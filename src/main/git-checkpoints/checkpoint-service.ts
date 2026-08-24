// checkpoint-service.ts — snapshot core: full raw capture + durable finalize
// (Git-Native WP-G1.3b). MAIN-PROCESS ONLY. **`cwd = repoRoot` always.**
//
// This is the most safety-critical package in the checkpoint engine: it turns a
// dirty (or clean) workspace into a byte-exact, recoverable git tree without ever
// touching HEAD, the real index, branch refs, or user config (invariant #1). It
// builds on the landed layers and REDEFINES none of them:
//   • git-command.runGit / runGitBlobToFile  — bounded exec + binary stream (G1.1)
//   • CheckpointQueue                          — per-object-db priority serialization
//                                                with eager deadline expiry (G1.2)
//   • ref-encoding.checkpointRef               — deterministic per-turn ref names (G1.3a)
//   • checkpoint-gating.gateCheckpoint /
//     enumerateScope                           — capability gate + full-scope
//                                                enumeration (gitlinks/unsupported/
//                                                filtered returned as DATA) (G1.3a)
//   • database turn_records accessors          — the durable finalize write target (A0)
//
// THE CAPTURE ALGORITHM (spec "Full raw snapshot sequence"):
//   1. temp GIT_INDEX_FILE `lares-idx-<uuid>` in OS temp, NEVER inside `.git/`.
//   2. seed: `read-tree HEAD` (repo) or `read-tree --empty` (unborn) — supplies the
//      out-of-scope entries so the tree is coherent; in-scope entries are overwritten.
//   3. modes: read seeded tracked-entry modes from `ls-files --stage` against the
//      temp index. Existing tracked path → PRESERVE its seeded mode (no filemode=false
//      downgrade of 100755); new untracked → derive from lstat (symlink 120000 /
//      exec 100755 / else 100644); gitlink 160000 → visible reject, never captured.
//   4. raw-hash every present in-scope regular/symlink path with
//      `hash-object --no-filters -w` in argv chunks bounded to a safe Windows
//      command-line length; a newline-containing path is hashed in its OWN invocation.
//   5. one NUL-safe `update-index -z --index-info` batch: `<mode> <oid>\t<path>` for
//      additions and the `0 <zero-oid>\t<path>` delete form for tracked-absent paths.
//   6. `write-tree` → `commit-tree` (buildGitEnv commit mode + `-c commit.gpgsign=false`).
//   7. `finally`: delete the temp index + any `<idx>.lock`, async + off the delivery path.
//
// Why byte-exact: `hash-object --no-filters` stores worktree bytes verbatim for EVERY
// in-scope path (clean or dirty), so a clean tracked file under autocrlf/LFS/git-crypt
// is captured as its on-disk bytes, never silently reverted to the canonical HEAD blob.
//
// THE WALL-CLOCK CONTRACT (spec "authoritative"): deadlineAt = enqueueTime + budget.
//   • Cancellable capture runs only while now ≤ deadlineAt − FINALIZE_ALLOWANCE_MS
//     (the allowance is carved OUT of the budget). Past that with no candidate →
//     abandon: nothing persisted, quality 'degraded', failure_reason 'budget-exceeded'.
//   • Finalize is durable-not-unbounded: once the candidate OID is persisted (ready=0)
//     the edge is never abandoned; if update-ref/verify/mark overrun the absolute
//     deadline, delivery is released anyway and the edge is left persisted-but-non-ready
//     for startup reconciliation (WP-G1.8) to finish. An edge is NEVER exposed as usable
//     before a live `rev-parse --verify` confirms the ref == the persisted candidate.
//
// Every git touch and the persistence layer are injectable seams so the whole thing
// is testable with real git in temp repos plus deterministic fakes.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { TextDecoder } from 'util';

import {
  BEFORE_CHECKPOINT_BUDGET_MS,
  AFTER_CHECKPOINT_BUDGET_MS,
  FINALIZE_ALLOWANCE_MS,
  CLEANUP_ALLOWANCE_MS,
} from '../../shared/constants';
import type {
  GitCapability,
  MergeUndoPathPreview as SharedMergeUndoPathPreview,
  MergeUndoPathState,
  RestoreStrategy,
} from '../../shared/types';
import type { TurnRecord, RecoveryOperation, InsertRecoveryOperationFields } from '../database';
import {
  getTurnRecord as dbGetTurnRecord,
  updateTurnRecord as dbUpdateTurnRecord,
  listTurnRecords as dbListTurnRecords,
  listOpenTurnRecords as dbListOpenTurnRecords,
  listLaterTurnsWitnessingPath as dbListLaterTurnsWitnessingPath,
  insertRecoveryOperation as dbInsertRecoveryOperation,
  getRecoveryOperation as dbGetRecoveryOperation,
  updateRecoveryOperation as dbUpdateRecoveryOperation,
} from '../database';
import { buildGitEnv } from '../git/git-runtime';
import {
  gateCheckpoint,
  enumerateScope,
  classifyIgnored,
  type CapturableEntry,
  type EnumerationOutcome,
  type EnumerationResult,
  type LstatInfo,
  type LstatFn,
} from './checkpoint-gating';
import {
  runGit as realRunGit,
  runGitBytes as realRunGitBytes,
  runGitBlobToFile as realRunGitBlobToFile,
  type GitRunResult,
  type GitRunBytesResult,
  type RunGitOptions,
  type RunGitBlobToFileOptions,
  GitCommandError,
  GitBlobError,
} from './git-command';
import { CheckpointQueue, type CheckpointPriority, type SkippedDeadline } from './checkpoint-queue';
import { checkpointRef, recoveryRef, type CheckpointEdge } from './ref-encoding';
import { deriveRawGitMode } from './raw-git-mode';
import { encodeGitPath } from '../commit-candidates/dirty-inventory';
import { resolveCheckpointPathBlob } from './concurrency-policy';
import {
  checkAfterSnapshot,
  type AfterSnapshotOverlap,
} from './after-snapshot-gate';
import {
  planUndoMerge as realPlanUndoMerge,
  type UndoMergePlannerInput,
  type UndoMergePlannerResult,
} from './undo-merge-planner';

// ── injectable seams ──────────────────────────────────────────────────────────

/** The git-command.runGit shape (cwd, args, opts). */
export type RunGitLike = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunResult>;

/** Binary-preserving counterpart used by NUL-delimited Git output. */
export type RunGitBytesLike = (
  cwd: string,
  args: string[],
  opts: RunGitOptions,
) => Promise<GitRunBytesResult>;

/** The subset of the WP-A0 turn_records accessors the finalize write order needs.
 *  Defaults bind to the real database.ts exports; tests inject an in-memory fake so
 *  the ready=0 → ref → verify → ready=1 ordering is observable. */
export interface CheckpointTurnStore {
  getTurnRecord(id: string): TurnRecord | null;
  updateTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null;
  listTurnRecords(workspaceId: string, opts?: { agentId?: string }): TurnRecord[];
  listOpenTurnRecords(workspaceId: string): TurnRecord[];
  listLaterTurnsWitnessingPath(workspaceId: string, afterTurnSeq: number, path: string): TurnRecord[];
}

const DEFAULT_TURN_STORE: CheckpointTurnStore = {
  getTurnRecord: dbGetTurnRecord,
  updateTurnRecord: (id, updates) => dbUpdateTurnRecord(id, updates as never),
  listTurnRecords: dbListTurnRecords,
  listOpenTurnRecords: dbListOpenTurnRecords,
  listLaterTurnsWitnessingPath: dbListLaterTurnsWitnessingPath,
};

/** The subset of the WP-A0 `recovery_operations` accessors the restore path needs.
 *  Defaults bind to the real database.ts exports; tests inject an in-memory fake so
 *  the pending → ready → completed/partial/failed lifecycle + `completed_paths`
 *  incremental record are observable. */
export interface CheckpointRecoveryStore {
  insertRecoveryOperation(workspaceId: string, fields: InsertRecoveryOperationFields): RecoveryOperation;
  getRecoveryOperation(id: string): RecoveryOperation | null;
  updateRecoveryOperation(id: string, updates: Record<string, unknown>): RecoveryOperation | null;
}

const DEFAULT_RECOVERY_STORE: CheckpointRecoveryStore = {
  insertRecoveryOperation: dbInsertRecoveryOperation,
  getRecoveryOperation: dbGetRecoveryOperation,
  updateRecoveryOperation: (id, updates) => dbUpdateRecoveryOperation(id, updates as never),
};

/** The `runGitBlobToFile` shape (cwd, blobOid, destTmpPath, opts) — injectable so a
 *  restore test can force a stream failure/AV-lock path without a real git process. */
export type RunGitBlobToFileLike = (
  cwd: string,
  blobOid: string,
  destTmpPath: string,
  opts: RunGitBlobToFileOptions,
) => Promise<{ bytesWritten: number }>;

/** Per-file guarded-write tuning. Injectable so the AV-lock retry semantics can be
 *  exercised deterministically (a fake fs seam throwing EPERM a bounded number of
 *  times before succeeding). */
export interface RestoreTuning {
  /** Byte cap handed to `runGitBlobToFile` per restored blob (over-cap → visible fail). */
  fileMaxBytes: number;
  /** Absolute per-file git bound (stream + validation probes) in ms. */
  fileTimeoutMs: number;
  /** Windows read-only/EPERM/EBUSY (AV lock) replace attempts before failing visibly. */
  replaceRetries: number;
  /** Backoff between replace attempts (ms). */
  replaceBackoffMs: number;
}

const DEFAULT_RESTORE_TUNING: RestoreTuning = {
  fileMaxBytes: 256 << 20,
  fileTimeoutMs: 60_000,
  replaceRetries: 5,
  replaceBackoffMs: 50,
};

/** Timing constants — injectable so the timing tests use scaled-down REAL budgets
 *  (the queue and this service both key off the real wall clock). */
export interface CheckpointTiming {
  beforeBudgetMs: number;
  afterBudgetMs: number;
  finalizeAllowanceMs: number;
  cleanupAllowanceMs: number;
}

const DEFAULT_TIMING: CheckpointTiming = {
  beforeBudgetMs: BEFORE_CHECKPOINT_BUDGET_MS,
  afterBudgetMs: AFTER_CHECKPOINT_BUDGET_MS,
  finalizeAllowanceMs: FINALIZE_ALLOWANCE_MS,
  cleanupAllowanceMs: CLEANUP_ALLOWANCE_MS,
};

export interface CheckpointServiceOptions {
  queue: CheckpointQueue;
  /** Resolved absolute git exe (cached `resolveInternalGit()` in production). */
  gitExe: string;
  runGit?: RunGitLike;
  /** Binary-safe Git seam for NUL-delimited output. Never derived from `runGit`. */
  runGitBytes?: RunGitBytesLike;
  /** Restore's binary blob-write seam — defaults to git-command.runGitBlobToFile. */
  runGitBlobToFile?: RunGitBlobToFileLike;
  store?: CheckpointTurnStore;
  recoveryStore?: CheckpointRecoveryStore;
  restore?: Partial<RestoreTuning>;
  /** lstat seam for the restore guards (defaults to a real fs.lstatSync reader). */
  lstat?: (absPath: string) => LstatInfo | null;
  timing?: Partial<CheckpointTiming>;
  /** OS temp dir for the per-op index (defaults to os.tmpdir()). NEVER `.git/`. */
  tmpDir?: string;
  /** now() seam — defaults to Date.now. Kept in lockstep with the queue's clock. */
  now?: () => number;
  /** Enumeration seam — defaults to G1.3a enumerateScope. Injected in tests that
   *  need a synthetic gitlink/unsupported scope without creating one on disk. */
  enumerate?: (opts: {
    repoRoot: string;
    workspacePrefix: string;
    runGit: RunGitLike;
    gitExe?: string;
    lstat?: LstatFn;
  }) => Promise<EnumerationOutcome>;
  platform?: NodeJS.Platform;
  mergeUndoPreviewRegistry?: MergeUndoPreviewRegistry;
  /** Planner seam used by focused restore tests; production always uses the real planner. */
  planUndoMerge?: (input: UndoMergePlannerInput) => Promise<UndoMergePlannerResult>;
}

export const MERGE_UNDO_PREVIEW_TTL_MS = 5 * 60 * 1000;

export interface MergeUndoMechanicalPathIdentity {
  path: string;
  state: MergeUndoPathState;
  currentRawOid: string | null;
  currentCleanOid: string | null;
  currentMode: string | null;
  indexCleanOid: string | null;
  indexMode: string | null;
  normalizationFingerprint: string;
  resultBlobOid: string | null;
  resultMode: string | null;
}

export interface MergeUndoPreviewIdentity {
  workspaceId: string;
  turnId: string;
  strategy: 'merge-undo';
  beforeCommitOid: string;
  afterCommitOid: string;
  requestedPaths: string[];
  renameGroups: string[][];
  resultTreeOid: string;
  mergeExitCode: 0 | 1;
  hasUnmergedRecords: boolean;
  paths: MergeUndoMechanicalPathIdentity[];
}

export interface MergeUndoPreviewRecord extends MergeUndoPreviewIdentity {
  issuedAt: number;
  expiresAt: number;
}

export class MergeUndoPreviewRegistry {
  private readonly records = new Map<string, MergeUndoPreviewRecord>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly randomToken: () => string = () => randomBytes(32).toString('hex'),
  ) {}

  mint(identity: MergeUndoPreviewIdentity): string | null {
    if (
      identity.mergeExitCode !== 0
      || identity.hasUnmergedRecords
      || identity.paths.length === 0
      || identity.paths.some((p) => p.state !== 'clean' && p.state !== 'merged')
    ) return null;
    const issuedAt = this.now();
    const token = this.randomToken();
    this.records.set(token, {
      workspaceId: identity.workspaceId,
      turnId: identity.turnId,
      strategy: 'merge-undo',
      beforeCommitOid: identity.beforeCommitOid,
      afterCommitOid: identity.afterCommitOid,
      requestedPaths: [...identity.requestedPaths].sort(),
      renameGroups: identity.renameGroups.map((group) => [...group].sort()),
      resultTreeOid: identity.resultTreeOid,
      mergeExitCode: identity.mergeExitCode,
      hasUnmergedRecords: identity.hasUnmergedRecords,
      paths: identity.paths.map((p) => ({
        path: p.path,
        state: p.state,
        currentRawOid: p.currentRawOid,
        currentCleanOid: p.currentCleanOid,
        currentMode: p.currentMode,
        indexCleanOid: p.indexCleanOid,
        indexMode: p.indexMode,
        normalizationFingerprint: p.normalizationFingerprint,
        resultBlobOid: p.resultBlobOid,
        resultMode: p.resultMode,
      })),
      issuedAt,
      expiresAt: issuedAt + MERGE_UNDO_PREVIEW_TTL_MS,
    });
    return token;
  }

  consume(token: string): MergeUndoPreviewRecord | null {
    const result = this.consumeDetailed(token);
    return result.kind === 'ok' ? result.record : null;
  }

  consumeDetailed(token: string):
    | { kind: 'ok'; record: MergeUndoPreviewRecord }
    | { kind: 'invalid' | 'expired' } {
    const record = this.records.get(token);
    if (!record) return { kind: 'invalid' };
    this.records.delete(token);
    if (record.expiresAt <= this.now()) return { kind: 'expired' };
    return { kind: 'ok', record };
  }
}

/** Verified after-image input consumed by the supervisor restore authority. */
export interface AfterImageRestoreInput {
  turnId: string;
  workspaceId: string;
  path: string;
  afterCommitOid: string;
  afterBlobOid: string | null;
}

// ── result / outcome types ──────────────────────────────────────────────────────

export type EdgeCaptureStatus =
  | 'ready' // fully finalized: ref created + verified == candidate, ready=1
  | 'persisted-non-ready' // candidate persisted (ready=0); finalize overran/failed → reconciliation finishes it
  | 'abandoned' // no candidate persisted (deadline before candidate, or capture error) → degraded
  | 'skipped'; // capability gate or enumeration skip (non-repo/oversized/protected/…)

export interface EdgeCaptureResult {
  status: EdgeCaptureStatus;
  edge: CheckpointEdge;
  turnId: string;
  oid: string | null;
  ref: string | null;
  ready: boolean;
  quality: string | null;
  failureReason: string | null;
  /** BEFORE edge only — content-semantics diagnostics (invariant #15). */
  rawFilterBypassed?: boolean;
  filteredPaths?: string[];
  /** Diagnostics — gitlinks (visible reject) + unsupported entry types excluded. */
  rejectedGitlinks?: string[];
  unsupportedPaths?: string[];
  /** Skip diagnostics. */
  skipReason?: string;
  detail?: string | null;
}

export interface CaptureEdgeParams {
  edge: CheckpointEdge;
  turnId: string;
  workspaceId: string;
  /** Launch identity — NEVER a cwd/slug (invariant #4). */
  agentId: string;
  capability: GitCapability;
  /** Success-case quality: before = guaranteed|late|degraded; after = hook|
   *  session-log|terminal|idle-fallback|none. The coordinator (G1.5) decides it;
   *  the service records it verbatim on the ready edge. */
  quality: string;
  /** commit-tree label. */
  label?: string;
  /** Absolute enqueue time (defaults now()). deadlineAt = enqueueTime + budget. */
  enqueueTime?: number;
  /** lstat seam for enumeration (tests). */
  lstat?: LstatFn;
}

/** Explicit fleet-finalization snapshot. Unlike a turn edge this creates no
 * turn-row/ref side effects: the caller immediately pins the returned commit
 * through refs/lares/finalizations/... after freezing its selected manifest. */
export interface CaptureBoundaryParams {
  capability: GitCapability;
  label: string;
  lstat?: LstatFn;
}

export interface CaptureBoundaryResult {
  oid: string;
  treeOid: string;
}

// ── the zero OID (delete form) ──────────────────────────────────────────────────

const SHA1_ZERO = '0'.repeat(40);
const OID_RE = /^[0-9a-f]{40,64}$/;

/** ~30 000 chars — a conservative bound well under the Windows CreateProcess
 *  command-line limit (32 767 UTF-16 units) once the exe + fixed flags are counted. */
const MAX_ARG_CHARS = 30_000;

/** Result of the raw-capture phase — the still-cancellable half. */
interface SnapshotOutcome {
  candidateOid: string;
  treeOid: string;
  rawFilterBypassed: boolean;
  filteredPaths: string[];
  rejectedGitlinks: string[];
  unsupportedPaths: string[];
}

export const WINDOW_PATHS_MAX_BYTES = 1 << 20;
export const WINDOW_PATHS_TIMEOUT_MS = 15_000;

export interface WindowPathList {
  available: boolean;
  reason:
    | 'ok' | 'empty'
    | 'before-edge-unusable' | 'after-edge-unusable'
    | 'malformed' | 'non-utf8'
    | 'cap-exhausted' | 'timeout' | 'git-failed';
  paths: string[];
  omittedPathCount: number | null;
  hasOmittedPaths: boolean;
  truncated: boolean;
}

function unavailableWindowPaths(reason: WindowPathList['reason']): WindowPathList {
  return {
    available: false,
    reason,
    paths: [],
    omittedPathCount: null,
    hasOmittedPaths: true,
    truncated: false,
  };
}

function parseWindowPathBytes(stdout: Buffer): WindowPathList {
  if (stdout.length === 0) {
    return {
      available: true,
      reason: 'empty',
      paths: [],
      omittedPathCount: 0,
      hasOmittedPaths: false,
      truncated: false,
    };
  }

  const fields: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] !== 0) continue;
    fields.push(stdout.subarray(start, i));
    start = i + 1;
  }
  const hasUnterminatedTail = start < stdout.length;

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const paths: string[] = [];
  let omittedPathCount = 0;
  let cursor = 0;
  while (cursor < fields.length) {
    const statusBytes = fields[cursor++];
    if (statusBytes.length === 0 || statusBytes.some((byte) => byte > 0x7f)) {
      return { ...unavailableWindowPaths('malformed'), paths };
    }
    const status = statusBytes.toString('ascii');
    const pathCount = /^[AMDTUXB]$/.test(status) ? 1 : /^[RC]\d+$/.test(status) ? 2 : 0;
    if (pathCount === 0 || cursor + pathCount > fields.length) {
      return { ...unavailableWindowPaths('malformed'), paths };
    }

    for (let i = 0; i < pathCount; i++) {
      const pathBytes = fields[cursor++];
      if (pathBytes.length === 0) return { ...unavailableWindowPaths('malformed'), paths };
      try {
        paths.push(decoder.decode(pathBytes));
      } catch {
        omittedPathCount += 1;
      }
    }
  }

  if (hasUnterminatedTail) return { ...unavailableWindowPaths('malformed'), paths };

  if (omittedPathCount > 0) {
    return {
      available: false,
      reason: 'non-utf8',
      paths,
      omittedPathCount,
      hasOmittedPaths: true,
      truncated: false,
    };
  }
  return {
    available: true,
    reason: paths.length === 0 ? 'empty' : 'ok',
    paths,
    omittedPathCount: 0,
    hasOmittedPaths: false,
    truncated: false,
  };
}

export class CheckpointService {
  private readonly queue: CheckpointQueue;
  private readonly gitExe: string;
  private readonly runGit: RunGitLike;
  private readonly runGitBytes: RunGitBytesLike;
  private readonly runGitBlobToFile: RunGitBlobToFileLike;
  private readonly store: CheckpointTurnStore;
  private readonly recoveryStore: CheckpointRecoveryStore;
  private readonly restoreTuning: RestoreTuning;
  private readonly lstatAbs: (absPath: string) => LstatInfo | null;
  private readonly timing: CheckpointTiming;
  private readonly tmpDir: string;
  private readonly now: () => number;
  private readonly enumerate: NonNullable<CheckpointServiceOptions['enumerate']>;
  private readonly platform: NodeJS.Platform;
  private readonly planUndoMerge: (input: UndoMergePlannerInput) => Promise<UndoMergePlannerResult>;
  readonly mergeUndoPreviewRegistry: MergeUndoPreviewRegistry;
  /** Fire-and-forget cleanup promises — awaitable by tests via settleCleanups(). */
  private readonly cleanups: Promise<void>[] = [];

  constructor(opts: CheckpointServiceOptions) {
    this.queue = opts.queue;
    this.gitExe = opts.gitExe;
    this.runGit = opts.runGit ?? realRunGit;
    this.runGitBytes = opts.runGitBytes ?? realRunGitBytes;
    this.runGitBlobToFile = opts.runGitBlobToFile ?? realRunGitBlobToFile;
    this.store = opts.store ?? DEFAULT_TURN_STORE;
    this.recoveryStore = opts.recoveryStore ?? DEFAULT_RECOVERY_STORE;
    this.restoreTuning = { ...DEFAULT_RESTORE_TUNING, ...(opts.restore ?? {}) };
    this.lstatAbs = opts.lstat ?? defaultAbsLstat;
    this.timing = { ...DEFAULT_TIMING, ...(opts.timing ?? {}) };
    this.tmpDir = opts.tmpDir ?? os.tmpdir();
    this.now = opts.now ?? Date.now;
    this.enumerate = opts.enumerate ?? ((o) => enumerateScope(o));
    this.platform = opts.platform ?? process.platform;
    this.planUndoMerge = opts.planUndoMerge ?? ((input) => realPlanUndoMerge(input, {
      gitExe: this.gitExe,
      runGit: this.runGit,
      runGitBytes: this.runGitBytes,
      tmpDir: this.tmpDir,
    }));
    this.mergeUndoPreviewRegistry = opts.mergeUndoPreviewRegistry ?? new MergeUndoPreviewRegistry(this.now);
  }

  // ── public: capture one edge ──────────────────────────────────────────────────

  /**
   * Capture the before/after edge for a turn: gate → enumerate → full raw snapshot
   * → durable finalize, all serialized on the repo's object database at the edge's
   * priority under the wall-clock contract. The turn row (already allocated + open
   * by the coordinator) is filled via the WP-A0 accessors.
   */
  async captureEdge(params: CaptureEdgeParams): Promise<EdgeCaptureResult> {
    const { edge, turnId } = params;
    const enqueueTime = params.enqueueTime ?? this.now();
    const budget = edge === 'before' ? this.timing.beforeBudgetMs : this.timing.afterBudgetMs;
    const deadlineAt = enqueueTime + budget;
    const priority: CheckpointPriority = edge === 'before' ? 'BEFORE' : 'AFTER';

    // Gate is pure + instantaneous — decide before spending a queue slot.
    const gate = gateCheckpoint(params.capability);
    if (!gate.ok) {
      // The before edge fails OPEN at the coordinator; the after edge simply has no
      // recoverable state. Either way we persist no candidate and no ref.
      return {
        status: 'skipped',
        edge,
        turnId,
        oid: null,
        ref: null,
        ready: false,
        quality: null,
        failureReason: null,
        skipReason: gate.skipped,
        detail: gate.detail,
      };
    }

    const key = params.capability.commonDirQueueKey;
    if (!key) {
      // gate.ok guarantees a repoRoot; a null queue key is an internal inconsistency.
      return this.abandon(edge, turnId, 'missing-queue-key', deadlineAt);
    }

    const settled = await this.queue.withPriority(
      key,
      { priority, deadlineAt },
      () => this.runCapture({ ...params, enqueueTime, deadlineAt, gate }),
    );

    if (isSkippedDeadline(settled)) {
      // The queue expired the item before it ever started — a long AFTER holding the
      // key must never delay a BEFORE past its deadline. No candidate exists.
      return this.abandon(edge, turnId, 'budget-exceeded', deadlineAt);
    }
    return settled;
  }

  /** Capture the current raw worktree as a checkpoint-native commit for an
   * explicit finalization boundary. The shared object-db queue makes this one
   * uninterrupted snapshot operation; no real-index mutation occurs. */
  async captureBoundary(params: CaptureBoundaryParams): Promise<CaptureBoundaryResult> {
    const gate = gateCheckpoint(params.capability);
    if (!gate.ok || !params.capability.commonDirQueueKey) {
      throw new Error(`finalization boundary unavailable: ${gate.ok ? 'missing-queue-key' : gate.skipped}`);
    }
    const captureDeadline = this.now() + 60_000;
    const settled = await this.queue.withLock(
      params.capability.commonDirQueueKey,
      () => this.rawSnapshot({
        repoRoot: gate.repoRoot,
        repoState: gate.repoState,
        workspacePrefix: gate.workspacePrefix,
        captureDeadline,
        label: params.label,
        lstat: params.lstat,
      }),
    );
    if (isSkippedDeadline(settled)) {
      throw new Error('finalization boundary capture expired in the object-db queue');
    }
    return { oid: settled.candidateOid, treeOid: settled.treeOid };
  }

  // ── the cancellable capture + durable finalize (runs while holding the key) ─────

  private async runCapture(
    params: CaptureEdgeParams & {
      enqueueTime: number;
      deadlineAt: number;
      gate: { repoState: 'repo' | 'unborn'; repoRoot: string; workspacePrefix: string };
    },
  ): Promise<EdgeCaptureResult> {
    const { edge, turnId, gate, deadlineAt } = params;
    const captureDeadline = deadlineAt - this.timing.finalizeAllowanceMs;

    // Cancellable capture may start only while now ≤ deadlineAt − FINALIZE_ALLOWANCE_MS.
    if (this.now() > captureDeadline) {
      return this.abandon(edge, turnId, 'budget-exceeded', deadlineAt);
    }

    let snap: SnapshotOutcome;
    try {
      snap = await this.rawSnapshot({
        repoRoot: gate.repoRoot,
        repoState: gate.repoState,
        workspacePrefix: gate.workspacePrefix,
        captureDeadline,
        label: params.label ?? `lares:${edge}:${turnId}`,
        lstat: params.lstat,
      });
    } catch (err) {
      // A deadline/timeout kill during capture, an oversized skip, or any capture
      // failure lands here BEFORE a candidate is persisted → abandon (degraded).
      if (err instanceof EnumerationSkipError) {
        return {
          status: 'skipped',
          edge,
          turnId,
          oid: null,
          ref: null,
          ready: false,
          quality: null,
          failureReason: null,
          skipReason: err.reason,
          detail: err.detail,
        };
      }
      const reason =
        err instanceof GitCommandError && (err.kind === 'deadline' || err.kind === 'timeout')
          ? 'budget-exceeded'
          : 'snapshot-failed';
      return this.abandon(edge, turnId, reason, deadlineAt, describeError(err));
    }

    // We have a candidate. From here the edge is durable-not-unbounded: it is never
    // abandoned, only left persisted-non-ready if finalize overruns the deadline.
    return this.finalize({ edge, turnId, params, snap, deadlineAt });
  }

  // ── steps 1–6: full raw snapshot (still cancellable) ───────────────────────────

  private async rawSnapshot(args: {
    repoRoot: string;
    repoState: 'repo' | 'unborn';
    workspacePrefix: string;
    captureDeadline: number;
    label: string;
    lstat?: LstatFn;
  }): Promise<SnapshotOutcome> {
    const { repoRoot, repoState, workspacePrefix, captureDeadline, label } = args;

    // Enumerate the full scope (G1.3a) — gitlinks/unsupported/filtered come back as data.
    const enumeration = await this.enumerate({
      repoRoot,
      workspacePrefix,
      runGit: this.runGit,
      gitExe: this.gitExe,
      lstat: args.lstat,
    });
    if (enumeration.kind === 'skipped') {
      throw new EnumerationSkipError(enumeration.reason, JSON.stringify(enumeration.observed));
    }
    const scope: EnumerationResult = enumeration;

    // 1. Unique temp GIT_INDEX_FILE outside `.git/`.
    const indexFile = path.join(this.tmpDir, `lares-idx-${randomUUID()}`);
    try {
      // 2. Seed the temp index: HEAD tree (repo) or empty (unborn).
      const seedArgs = repoState === 'unborn' ? ['read-tree', '--empty'] : ['read-tree', 'HEAD'];
      await this.git(repoRoot, seedArgs, { indexFile, deadlineAt: captureDeadline });

      // 3. Seeded tracked-entry modes (against the temp index), NUL-safe.
      const seededModes = await this.readSeededModes(repoRoot, indexFile, captureDeadline);

      // 3+4. Derive filemode per path + raw-hash worktree bytes. Gitlinks rejected.
      const rejectedGitlinks: string[] = [...scope.gitlinks];
      const toHash: CapturableEntry[] = [];
      const modeByPath = new Map<string, string>();
      for (const entry of scope.capturable) {
        const seeded = seededModes.get(entry.path);
        if (seeded === '160000') {
          // A seeded gitlink surfacing as a capturable path — never hash a submodule.
          rejectedGitlinks.push(entry.path);
          continue;
        }
        const mode = deriveRawGitMode(seeded ?? null, {
          isFile: entry.type === 'regular',
          isSymbolicLink: entry.type === 'symlink',
          mode: entry.mode,
        }, this.platform);
        if (mode === null) throw new Error(`cannot derive raw Git mode for ${entry.path}`);
        if (mode === '160000') {
          rejectedGitlinks.push(entry.path);
          continue;
        }
        modeByPath.set(entry.path, mode);
        toHash.push(entry);
      }

      const oidByPath = await this.hashPaths(repoRoot, toHash.map((e) => e.path), captureDeadline);

      // 5. One NUL-safe update-index --index-info batch: additions + deletions.
      const additions: string[] = [];
      let sampleOidLen = 0;
      for (const entry of toHash) {
        const oid = oidByPath.get(entry.path);
        const mode = modeByPath.get(entry.path);
        if (!oid || !mode) continue;
        if (sampleOidLen === 0) sampleOidLen = oid.length;
        additions.push(`${mode} ${oid}\t${entry.path}`);
      }
      const zeroOid = sampleOidLen > 0 ? '0'.repeat(sampleOidLen) : SHA1_ZERO;
      const deletions = scope.deletions.map((p) => `0 ${zeroOid}\t${p}`);
      const indexInfo = [...additions, ...deletions];
      if (indexInfo.length > 0) {
        const stdin = indexInfo.map((line) => `${line}\0`).join('');
        await this.git(repoRoot, ['update-index', '-z', '--index-info'], {
          indexFile,
          stdin,
          deadlineAt: captureDeadline,
        });
      }

      // 6. write-tree → commit-tree (identity from buildGitEnv commit; gpgsign off).
      const treeOid = (
        await this.git(repoRoot, ['write-tree'], { indexFile, deadlineAt: captureDeadline })
      ).stdout.trim();

      const commitTopLevel = this.longpaths().concat(['-c', 'commit.gpgsign=false']);
      const commitOid = (
        await this.git(repoRoot, [...commitTopLevel, 'commit-tree', treeOid, '-m', label], {
          mode: 'commit',
          deadlineAt: captureDeadline,
        })
      ).stdout.trim();

      return {
        candidateOid: commitOid,
        treeOid,
        rawFilterBypassed: scope.beforeRawFilterBypassed,
        filteredPaths: scope.filteredPaths,
        rejectedGitlinks,
        unsupportedPaths: scope.unsupported,
      };
    } finally {
      // 7. Async, off the delivery path — never delays return / delivery.
      this.scheduleCleanup(indexFile);
    }
  }

  // ── the durable finalize write order (steps 2–5) ───────────────────────────────

  private async finalize(args: {
    edge: CheckpointEdge;
    turnId: string;
    params: CaptureEdgeParams;
    snap: SnapshotOutcome;
    deadlineAt: number;
  }): Promise<EdgeCaptureResult> {
    const { edge, turnId, params, snap, deadlineAt } = args;
    const repoRoot = params.capability.repoRoot as string;
    const ref = checkpointRef({
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      turnId,
      edge,
    });

    // Step 2: persist candidate OID + deterministic ref name (ready=0). This STARTS
    // the durable finalize state — a persisted candidate is never abandoned.
    this.store.updateTurnRecord(turnId, this.persistCandidateFields(edge, snap.candidateOid, ref, snap));

    const nonReady = (failureReason: string | null): EdgeCaptureResult => ({
      status: 'persisted-non-ready',
      edge,
      turnId,
      oid: snap.candidateOid,
      ref,
      ready: false,
      quality: null,
      failureReason,
      rawFilterBypassed: edge === 'before' ? snap.rawFilterBypassed : undefined,
      filteredPaths: edge === 'before' ? snap.filteredPaths : undefined,
      rejectedGitlinks: snap.rejectedGitlinks,
      unsupportedPaths: snap.unsupportedPaths,
    });

    // Steps 3–4 carry the ABSOLUTE deadline: an overrun releases delivery anyway and
    // leaves the edge persisted-non-ready for reconciliation (WP-G1.8).
    try {
      // Step 3: create-only atomic update-ref (expected-zero old OID).
      await this.git(repoRoot, ['update-ref', ref, snap.candidateOid, SHA1_ZERO], {
        deadlineAt,
        allowNonzero: true,
      });

      // Step 4: verify the ref resolves to exactly the persisted candidate. This is
      // the ONLY gate that lets an edge become usable — a create-only collision or a
      // killed update-ref yields a mismatch → non-ready, never a false guarantee.
      const verify = await this.git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`], {
        deadlineAt,
        allowNonzero: true,
      });
      if (verify.code !== 0 || verify.stdout.trim() !== snap.candidateOid) {
        return nonReady('finalize-verify-mismatch');
      }
    } catch (err) {
      return nonReady(describeError(err));
    }

    // Step 5: mark ready + assign quality. Only now is the edge a real guarantee.
    this.store.updateTurnRecord(turnId, this.readyFields(edge, params.quality));

    return {
      status: 'ready',
      edge,
      turnId,
      oid: snap.candidateOid,
      ref,
      ready: true,
      quality: params.quality,
      failureReason: null,
      rawFilterBypassed: edge === 'before' ? snap.rawFilterBypassed : undefined,
      filteredPaths: edge === 'before' ? snap.filteredPaths : undefined,
      rejectedGitlinks: snap.rejectedGitlinks,
      unsupportedPaths: snap.unsupportedPaths,
    };
  }

  private persistCandidateFields(
    edge: CheckpointEdge,
    oid: string,
    ref: string,
    snap: SnapshotOutcome,
  ): Record<string, unknown> {
    if (edge === 'before') {
      return {
        beforeOid: oid,
        beforeRef: ref,
        beforeReady: false,
        // Content-semantics fields are BEFORE-edge only (invariant #15).
        beforeRawFilterBypassed: snap.rawFilterBypassed,
        beforeFilteredPaths: snap.filteredPaths.length > 0 ? snap.filteredPaths : null,
      };
    }
    return { afterOid: oid, afterRef: ref, afterReady: false };
  }

  private readyFields(edge: CheckpointEdge, quality: string): Record<string, unknown> {
    return edge === 'before'
      ? { beforeReady: true, beforeQuality: quality }
      : { afterReady: true, afterQuality: quality };
  }

  // ── abandon: no candidate persisted → degraded ─────────────────────────────────

  private abandon(
    edge: CheckpointEdge,
    turnId: string,
    failureReason: string,
    deadlineAt: number,
    detail?: string,
  ): EdgeCaptureResult {
    // Record the degraded quality + exact reason WITHOUT a candidate/ref: the edge
    // claims no recovery guarantee and there is nothing for reconciliation to adopt.
    const fields =
      edge === 'before'
        ? { beforeQuality: 'degraded', failureReason }
        : { afterQuality: 'none', failureReason };
    try {
      this.store.updateTurnRecord(turnId, fields);
    } catch {
      /* the row may already be terminal (raced close) — abandon is best-effort here */
    }
    return {
      status: 'abandoned',
      edge,
      turnId,
      oid: null,
      ref: null,
      ready: false,
      quality: edge === 'before' ? 'degraded' : 'none',
      failureReason,
      detail: detail ?? null,
    };
  }

  // ── mode derivation ────────────────────────────────────────────────────────────

  /** Parse `ls-files --stage -z` (against the temp index) → path → mode string. */
  private async readSeededModes(
    repoRoot: string,
    indexFile: string,
    deadlineAt: number,
  ): Promise<Map<string, string>> {
    const res = await this.git(repoRoot, ['ls-files', '--stage', '-z'], { indexFile, deadlineAt });
    const map = new Map<string, string>();
    for (const rec of res.stdout.split('\0')) {
      if (rec.length === 0) continue;
      // `<mode> SP <oid> SP <stage>\t<path>`
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const meta = rec.slice(0, tab);
      const p = rec.slice(tab + 1);
      const mode = meta.split(' ', 1)[0];
      if (mode) map.set(p, mode);
    }
    return map;
  }

  // ── step 4: chunked raw-hash ─────────────────────────────────────────────────────

  /** Raw-hash every path with `hash-object --no-filters -w`, byte-exact. Paths are
   *  chunked to a safe argv length; a newline-containing path is hashed alone (its
   *  own invocation) since --stdin-paths is newline-delimited and unsafe for it. */
  private async hashPaths(
    repoRoot: string,
    paths: string[],
    deadlineAt: number,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (paths.length === 0) return out;

    const base = ['hash-object', '--no-filters', '-w', '--'];
    let chunk: string[] = [];
    let chunkLen = base.join(' ').length;

    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return;
      const res = await this.git(repoRoot, [...base, ...chunk], { deadlineAt });
      const oids = res.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      if (oids.length !== chunk.length) {
        throw new Error(`hash-object returned ${oids.length} oids for ${chunk.length} paths`);
      }
      chunk.forEach((p, i) => out.set(p, oids[i]));
      chunk = [];
      chunkLen = base.join(' ').length;
    };

    for (const p of paths) {
      if (p.includes('\n')) {
        // Newline-in-name → its OWN invocation; flush any pending normal batch first.
        await flush();
        const res = await this.git(repoRoot, [...base, p], { deadlineAt });
        out.set(p, res.stdout.trim());
        continue;
      }
      const add = p.length + 1;
      if (chunk.length > 0 && chunkLen + add > MAX_ARG_CHARS) {
        await flush();
      }
      chunk.push(p);
      chunkLen += add;
    }
    await flush();
    return out;
  }

  // ── diff generation ──────────────────────────────────────────────────────────

  /**
   * The witnessed-path diff AND the raw-window diff, returned SEPARATELY and
   * labeled. Both require before_ready=1 AND after_ready=1 AND a live
   * `rev-parse --verify` that the stored refs still resolve to the stored OIDs — the
   * DB `*_pruned_at` timestamps are hints, never authority (users can delete/rewrite
   * `refs/lares/*`). If either edge is unusable both diffs come back unavailable.
   */
  async generateDiffs(
    turnId: string,
    repoRoot: string,
  ): Promise<{
    witnessed: DiffResult;
    window: DiffResult;
  }> {
    const row = this.store.getTurnRecord(turnId);
    if (!row) {
      const unavail: DiffResult = { available: false, reason: 'unknown-turn', label: '', text: null };
      return { witnessed: { ...unavail, label: 'witnessed changes' }, window: { ...unavail, label: 'unattributed changes in this window' } };
    }

    const beforeUsable = await this.verifyEdgeUsable(repoRoot, row.beforeReady, row.beforeRef, row.beforeOid);
    const afterUsable = await this.verifyEdgeUsable(repoRoot, row.afterReady, row.afterRef, row.afterOid);

    const witnessedLabel = 'witnessed changes';
    const windowLabel = 'unattributed changes in this window';
    if (!beforeUsable || !afterUsable) {
      const reason = !beforeUsable ? 'before-edge-unusable' : 'after-edge-unusable';
      return {
        witnessed: { available: false, reason, label: witnessedLabel, text: null },
        window: { available: false, reason, label: windowLabel, text: null },
      };
    }

    const beforeOid = row.beforeOid as string;
    const afterOid = row.afterOid as string;
    const witnessedPaths = (row.touched ?? [])
      .filter((e) => e.op === 'write' || e.op === 'create')
      .map((e) => e.path);

    // Witnessed-path diff — scoped to the canonical write/create set.
    const witnessedText =
      witnessedPaths.length > 0
        ? (await this.diff(repoRoot, beforeOid, afterOid, witnessedPaths)).stdout
        : '';

    // Raw-window diff — the WHOLE before→after delta, incl. unattributed changes.
    const windowText = (await this.diff(repoRoot, beforeOid, afterOid, null)).stdout;

    return {
      witnessed: { available: true, reason: null, label: witnessedLabel, text: witnessedText, provenance: 'witnessed' },
      window: { available: true, reason: null, label: windowLabel, text: windowText, provenance: 'raw-window' },
    };
  }

  /**
   * List every repo-relative path in a turn's usable before/after window. Git's
   * NUL-delimited bytes are parsed without a text round-trip; any incomplete or
   * undecodable result remains visibly unavailable with honest omission counts.
   */
  async listWindowPaths(turnId: string, repoRoot: string): Promise<WindowPathList> {
    const row = this.store.getTurnRecord(turnId);
    const [beforeUsable, afterUsable] = await Promise.all([
      this.verifyEdgeUsable(
        repoRoot,
        row?.beforeReady ?? false,
        row?.beforeRef ?? null,
        row?.beforeOid ?? null,
      ),
      this.verifyEdgeUsable(
        repoRoot,
        row?.afterReady ?? false,
        row?.afterRef ?? null,
        row?.afterOid ?? null,
      ),
    ]);
    if (!beforeUsable) return unavailableWindowPaths('before-edge-unusable');
    if (!afterUsable) return unavailableWindowPaths('after-edge-unusable');

    try {
      const result = await this.runGitBytes(
        repoRoot,
        [
          '--no-pager',
          ...this.longpaths(),
          'diff',
          '--name-status',
          '-z',
          '--no-ext-diff',
          '--no-textconv',
          row!.beforeOid as string,
          row!.afterOid as string,
        ],
        {
          gitExe: this.gitExe,
          maxBytes: WINDOW_PATHS_MAX_BYTES,
          timeoutMs: WINDOW_PATHS_TIMEOUT_MS,
          mode: 'read',
        },
      );
      return parseWindowPathBytes(result.stdout);
    } catch (error) {
      if (error instanceof GitCommandError) {
        if (error.kind === 'timeout' || error.kind === 'deadline') {
          return unavailableWindowPaths('timeout');
        }
        if (error.kind === 'nonzero' && /output exceeded maxBytes/i.test(error.message)) {
          return {
            ...unavailableWindowPaths('cap-exhausted'),
            truncated: true,
          };
        }
      }
      return unavailableWindowPaths('git-failed');
    }
  }

  /** `git --no-pager [--no-ext-diff --no-textconv] diff <before> <after> [-- paths]`. */
  private diff(
    repoRoot: string,
    beforeOid: string,
    afterOid: string,
    paths: string[] | null,
  ): Promise<GitRunResult> {
    const top = ['--no-pager', ...this.longpaths()];
    const args = [...top, 'diff', '--no-ext-diff', '--no-textconv', beforeOid, afterOid];
    if (paths && paths.length > 0) args.push('--', ...paths);
    return this.git(repoRoot, args, { mode: 'read', maxBytes: 32 << 20, timeoutMs: 30_000 });
  }

  /** An edge is usable ONLY when ready=1 AND the stored ref lives + resolves to the
   *  stored OID right now. Never trust ready=1 alone (refs are user-mutable). */
  async verifyEdgeUsable(
    repoRoot: string,
    ready: boolean,
    ref: string | null,
    oid: string | null,
  ): Promise<boolean> {
    if (!ready || !ref || !oid) return false;
    try {
      const res = await this.git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`], {
        allowNonzero: true,
        timeoutMs: 10_000,
      });
      return res.code === 0 && res.stdout.trim() === oid;
    } catch {
      return false;
    }
  }

  // ── attribution enforcement (the validated path-set contract for restore) ──────

  /**
   * The canonical witnessed write/create set for a turn — the EXACT path set a
   * `revertTurn` may restore. Nothing outside a turn's witnessed writes is ever
   * revertable through this surface (whole-tree recovery is a separate human-only
   * surface, never here).
   */
  revertTurnPathSet(turnId: string): { turnId: string; paths: string[] } {
    const row = this.store.getTurnRecord(turnId);
    const paths = (row?.touched ?? [])
      .filter((e) => e.op === 'write' || e.op === 'create')
      .map((e) => e.path);
    return { turnId, paths: dedupe(paths) };
  }

  /**
   * Validate an agent-callable `restorePaths` request: the requested set must be a
   * SUBSET of the turn's canonical witnessed write/create set. Non-witnessed paths
   * are REJECTED (never restored). Same-path active contention is detected from OPEN
   * turn_records (not inferred from a git diff): another still-open turn that
   * witnessed one of these paths may still be writing it.
   */
  validateRestorePaths(
    turnId: string,
    requestedPaths: string[],
    workspaceId: string,
  ): RestorePathValidation {
    const witnessedSet = this.revertTurnPathSet(turnId).paths;
    const witnessed = new Set(witnessedSet);

    const validatedPaths: string[] = [];
    const rejectedPaths: string[] = [];
    for (const p of dedupe(requestedPaths)) {
      if (witnessed.has(p)) validatedPaths.push(p);
      else rejectedPaths.push(p);
    }

    const contention = this.openTurnContention(turnId, validatedPaths, workspaceId);

    return {
      ok: rejectedPaths.length === 0,
      turnId,
      witnessedSet,
      validatedPaths,
      rejectedPaths,
      contention,
    };
  }

  // ── restore preview (WP-G2.1: mint anti-TOCTOU preview tokens) ─────────────────

  /**
   * Read-only preview for a restore/revert: the witnessed set, the current
   * worktree OID per validated path (the anti-TOCTOU **preview token** the HTTP
   * caller echoes back to `restorePaths`/`revertTurn`), before-edge usability, and
   * same-path open-turn contention. Never mutates the worktree, index, or refs —
   * it only `hash-object`s the current bytes, so the token it hands back is exactly
   * what `captureSafetyPre` will re-derive at restore time (identical OID ⇒ the
   * token compare passes when the path is unchanged). Non-witnessed requested paths
   * are rejected, mirroring `validateRestorePaths` (whole-tree recovery is never
   * reachable here). Defaults `requestedPaths` to the full witnessed set.
   */
  /**
   * Resolve the verified after-checkpoint blob used by the cross-intent picker.
   * This is deliberately read-only: callers receive an input for the existing
   * supervisor-side restore authority; workers and the renderer never write it.
   */
  async afterImageRestoreInput(params: {
    turnId: string;
    workspaceId: string;
    repoRoot: string;
    path: string;
  }): Promise<AfterImageRestoreInput | null> {
    const row = this.store.getTurnRecord(params.turnId);
    if (!row || row.workspaceId !== params.workspaceId || !row.afterOid) return null;
    const canonical = canonicalHistoryPath(params.path, params.repoRoot);
    const witnessed = (row.touched ?? []).some((entry) =>
      (entry.op === 'write' || entry.op === 'create')
      && canonicalHistoryPath(entry.path, params.repoRoot) === canonical);
    if (!witnessed || canonical === '') return null;
    const usable = await this.verifyEdgeUsable(
      params.repoRoot, row.afterReady, row.afterRef, row.afterOid,
    );
    if (!usable) return null;
    const encoded = encodeGitPath(Buffer.from(canonical, 'utf8'));
    const afterBlobOid = await resolveCheckpointPathBlob({
      repoRoot: params.repoRoot,
      gitExe: this.gitExe,
      commitOid: row.afterOid,
      path: encoded,
      runGit: this.runGit,
    });
    return {
      turnId: row.id,
      workspaceId: row.workspaceId,
      path: canonical,
      afterCommitOid: row.afterOid,
      afterBlobOid,
    };
  }

  async previewRestore(params: {
    turnId: string;
    workspaceId: string;
    capability: GitCapability;
    requestedPaths?: string[];
    strategy?: RestoreStrategy;
  }): Promise<CheckpointPreviewResult> {
    const { turnId, workspaceId, capability } = params;
    const repoRoot = capability.repoRoot;
    const witnessedSet = this.revertTurnPathSet(turnId).paths;
    const requested =
      params.requestedPaths && params.requestedPaths.length > 0 ? params.requestedPaths : witnessedSet;
    const validation = this.validateRestorePaths(turnId, requested, workspaceId);

    const base: CheckpointPreviewResult = {
      available: false,
      reason: null,
      turnId,
      witnessedSet,
      tokens: {},
      validatedPaths: validation.validatedPaths,
      rejectedPaths: validation.rejectedPaths,
      contention: validation.contention,
      strategy: params.strategy ?? 'exact',
    };

    if (!repoRoot) return { ...base, reason: 'missing-repo' };
    const row = this.store.getTurnRecord(turnId);
    if (!row) return { ...base, reason: 'unknown-turn' };
    const beforeUsable = await this.verifyEdgeUsable(repoRoot, row.beforeReady, row.beforeRef, row.beforeOid);

    if (!beforeUsable) return { ...base, reason: 'before-edge-unusable' };
    if (!validation.ok) return { ...base, reason: 'non-witnessed-paths' };

    const afterUsable = await this.verifyEdgeUsable(
      repoRoot,
      row.afterReady,
      row.afterRef,
      row.afterOid,
    );
    if ((params.strategy ?? 'exact') === 'merge-undo') {
      if (!afterUsable || !row.beforeOid || !row.afterOid) {
        return { ...base, reason: 'after-edge-unusable' };
      }
      const planned = await this.planUndoMerge({
        cwd: repoRoot,
        beforeOid: row.beforeOid,
        afterOid: row.afterOid,
        requestedPaths: validation.validatedPaths,
        witnessedPaths: witnessedSet,
        liveContentionPaths: validation.contention.map((entry) => entry.path),
      });
      const pathStates: SharedMergeUndoPathPreview[] = planned.paths.map((entry) => ({
        path: entry.path,
        state: entry.state,
        ...(entry.state === 'conflicted'
          ? { reason: 'merge-undo-conflict' as const }
          : entry.state === 'clean' || entry.state === 'merged'
            ? {}
          : { reason: entry.state === 'refused-live-contention' ? 'active-turn-witnesses-path' : entry.state }),
        ...(entry.patch === null ? {} : { patch: entry.patch }),
        patchTruncated: entry.patchTruncated,
        omittedBytes: entry.omittedBytes,
      }));
      if (planned.kind !== 'ready') {
        const reason = planned.kind === 'conflicted'
          ? planned.reason
          : planned.kind === 'refused'
            ? (planned.reason === 'refused-live-contention' ? 'active-turn-witnesses-path' : planned.reason)
            : planned.reason;
        return {
          ...base,
          reason,
          pathStates,
          ...('omittedBytes' in planned ? {
            omittedBytes: planned.omittedBytes,
            omittedPathCount: planned.omittedPathCount,
          } : {}),
        };
      }
      const identity = mergePreviewIdentity(
        workspaceId,
        turnId,
        row.beforeOid,
        row.afterOid,
        validation.validatedPaths,
        planned,
      );
      const mergePreviewToken = this.mergeUndoPreviewRegistry.mint(identity);
      if (!mergePreviewToken) return { ...base, reason: 'merge-preview-token-invalid', pathStates };
      return {
        ...base,
        available: true,
        reason: null,
        mergePreviewToken,
        pathStates,
        omittedBytes: planned.omittedBytes,
        omittedPathCount: planned.omittedPathCount,
      };
    }
    const root = this.canonicalRoot(repoRoot);
    const gate = await checkAfterSnapshot({
      repoRoot,
      gitExe: this.gitExe,
      workspaceId,
      turnId,
      turnSeq: row.turnSeq,
      afterOid: row.afterOid,
      afterEdgeUsable: afterUsable,
      paths: validation.validatedPaths,
      store: this.store,
      runGit: this.runGit,
      lstatPath: (p) => this.lstatAbs(this.abs(root, p)),
      hashPaths: (paths) => this.hashPaths(
        repoRoot,
        [...paths],
        this.now() + this.restoreTuning.fileTimeoutMs,
      ),
    });
    if (!gate.ok) {
      return {
        ...base,
        reason: gate.failureReason,
        ...(gate.failureReason === 'current-hash-failed' ? {} : { overlap: gate.overlap }),
      };
    }
    if (validation.contention.length > 0) {
      return { ...base, reason: 'active-turn-witnesses-path' };
    }

    // Compute a token for every VALIDATED (witnessed) path: current raw blob OID for
    // a present file, the ABSENT sentinel for an absent path or a directory-occupied
    // slot (matches captureSafetyPre's currentOid semantics exactly).
    const tokens: Record<string, string> = {};
    const present: string[] = [];
    for (const p of validation.validatedPaths) {
      const st = this.lstatAbs(this.abs(root, p));
      if (st === null || st.isDirectory) tokens[p] = ABSENT_SENTINEL;
      else present.push(p);
    }
    if (present.length > 0) {
      const oidByPath = await this.hashPaths(
        repoRoot,
        present,
        this.now() + this.restoreTuning.fileTimeoutMs,
      );
      for (const p of present) tokens[p] = oidByPath.get(p) ?? ABSENT_SENTINEL;
    }

    return { ...base, available: true, reason: null, tokens };
  }

  // ── WP-G3.1: per-path version history (view/diff/restore one file) ─────────────

  /**
   * Versions of ONE canonical relative path across the workspace's retained turns:
   * every turn that WITNESSED a write/create to the path AND whose before-edge ref
   * LIVE-verifies right now (`isEdgeUsable` — the same rev-parse/readiness discipline
   * diff/restore use; the DB `*_ready`/`*_pruned_at` flags are hints, never
   * authority). A pruned/dead-ref edge is EXCLUDED — the presence of a version is
   * the restorable guarantee, so `FileHistoryView` never offers a restore against a
   * ref git can no longer resolve. Newest first (turnSeq desc). The path is matched
   * canonically so an absolute worktree path from the renderer resolves to the same
   * repo-relative key the witness join stored.
   */
  async fileHistory(params: {
    workspaceId: string;
    path: string;
    repoRoot: string;
    agentId?: string;
  }): Promise<FileHistoryVersion[]> {
    const target = canonicalHistoryPath(params.path, params.repoRoot);
    if (target === '') return [];
    const rows = this.store.listTurnRecords(
      params.workspaceId,
      params.agentId ? { agentId: params.agentId } : undefined,
    );

    const out: FileHistoryVersion[] = [];
    for (const row of rows) {
      const entry = (row.touched ?? []).find(
        (e) =>
          (e.op === 'write' || e.op === 'create') &&
          canonicalHistoryPath(e.path, params.repoRoot) === target,
      );
      if (!entry) continue;

      // The before edge is the restorable source — it must LIVE-verify (a pruned
      // ref drops the whole version, never listed as restorable).
      const beforeUsable = await this.verifyEdgeUsable(
        params.repoRoot,
        row.beforeReady,
        row.beforeRef,
        row.beforeOid,
      );
      if (!beforeUsable) continue;

      const afterUsable = await this.verifyEdgeUsable(
        params.repoRoot,
        row.afterReady,
        row.afterRef,
        row.afterOid,
      );

      out.push({
        turnId: row.id,
        turnSeq: row.turnSeq,
        agentId: row.agentId,
        agentTitle: row.agentTitle,
        taskLabel: row.taskLabel,
        status: row.status,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        beforeReady: row.beforeReady,
        afterReady: row.afterReady,
        beforeQuality: row.beforeQuality,
        afterQuality: row.afterQuality,
        witnessedPath: entry.path,
        op: entry.op as 'write' | 'create',
        afterVerified: afterUsable,
        beforeRawFilterBypassed: row.beforeRawFilterBypassed,
      });
    }

    out.sort((a, b) => b.turnSeq - a.turnSeq);
    return out;
  }

  // ── helpers ────────────────────────────────────────────────────────────────────

  private longpaths(): string[] {
    return this.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
  }

  /** runGit with the resolved exe + a default 30 s bound; callers override bounds. */
  private git(
    repoRoot: string,
    args: string[],
    opts: Partial<RunGitOptions> = {},
  ): Promise<GitRunResult> {
    return this.runGit(repoRoot, args, {
      gitExe: this.gitExe,
      maxBytes: 64 << 20,
      timeoutMs: 30_000,
      ...opts,
    });
  }

  private scheduleCleanup(indexFile: string): void {
    const p = this.cleanupIndex(indexFile);
    this.cleanups.push(p);
    // Bound the list so a long-lived service doesn't retain settled promises.
    if (this.cleanups.length > 64) this.cleanups.splice(0, this.cleanups.length - 64);
  }

  /** Delete the temp index + any `<idx>.lock`, bounded, best-effort, off the delivery
   *  path. Backstopped by the startup temp-artifact sweeper (WP-G1.8). */
  private async cleanupIndex(indexFile: string): Promise<void> {
    const deadline = this.now() + this.timing.cleanupAllowanceMs;
    for (const target of [indexFile, `${indexFile}.lock`]) {
      if (this.now() > deadline) return;
      try {
        await fs.promises.unlink(target);
      } catch {
        /* ENOENT / best-effort — the sweeper backstops any straggler */
      }
    }
  }

  /** Await all scheduled cleanups — TEST-ONLY hook so temp indexes don't leak. */
  async settleCleanups(): Promise<void> {
    await Promise.allSettled(this.cleanups.splice(0));
  }

  // ══ WP-G1.3c: guarded blob-write restore ════════════════════════════════════
  //
  // Restore is worktree-only (invariant #2): NEVER `git restore`/`git checkout`. The
  // whole compound op runs under ONE `queue.withLock` acquisition at RESTORE priority
  // (invariant #23) — no BEFORE/AFTER can interleave between the path-scoped safety
  // snapshot and the mutation, and continuous sends cannot starve it. Sources are the
  // before-edge blob OIDs resolved via `ls-tree` from the before commit (the tree blob
  // OID, never `before_oid`), and the mode always comes from the ls-tree entry.

  /**
   * Restore a caller-chosen SUBSET of a turn's witnessed write/create paths to their
   * before-edge bytes. The requested set is validated against the G1.3b witnessed
   * contract (`validateRestorePaths`); any non-witnessed path fails the op visibly
   * (whole-tree recovery is never reachable here).
   */
  async restorePaths(params: {
    turnId: string;
    requestedPaths: string[];
    workspaceId: string;
    /** supervisor agentId | 'human-ipc' — the row's `actor`. */
    actor: string;
    capability: GitCapability;
    /** Optional caller-supplied operationId (defaults to a fresh UUID). */
    operationId?: string;
    /** Optional preview tokens (path → OID seen at preview time) for the anti-TOCTOU
     *  recheck (Open #4 / WP-G2.2). Absent → no preview to compare. */
    previewTokens?: Record<string, string>;
    /** Human-force bypass of a preview-token mismatch. */
    force?: boolean;
    strategy?: RestoreStrategy;
    mergePreviewToken?: string;
  }): Promise<RestoreOutcome> {
    const validation = this.validateRestorePaths(params.turnId, params.requestedPaths, params.workspaceId);
    if (!validation.ok) {
      // Non-witnessed paths never reach a mutation; fail visibly WITHOUT a lock/row.
      return {
        status: 'failed',
        operationId: params.operationId ?? '',
        kind: (params.strategy ?? 'exact') === 'merge-undo' ? 'merge_undo_paths' : 'restore_paths',
        preRef: null,
        preOid: null,
        requestedPaths: dedupe(params.requestedPaths),
        completedPaths: [],
        rejectedPaths: validation.rejectedPaths,
        failures: [],
        contention: validation.contention,
        failureReason: 'non-witnessed-paths',
      };
    }
    return this.executeRestore((params.strategy ?? 'exact') === 'merge-undo' ? 'merge_undo_paths' : 'restore_paths', {
      ...params,
      paths: validation.validatedPaths,
      contention: validation.contention,
    });
  }

  /**
   * Revert an ENTIRE turn: restore every path in its canonical witnessed write/create
   * set to the before-edge bytes (create → delete; modify/delete → exact prior bytes).
   */
  async revertTurn(params: {
    turnId: string;
    workspaceId: string;
    actor: string;
    capability: GitCapability;
    operationId?: string;
    previewTokens?: Record<string, string>;
    force?: boolean;
    strategy?: RestoreStrategy;
    mergePreviewToken?: string;
  }): Promise<RestoreOutcome> {
    const paths = this.revertTurnPathSet(params.turnId).paths;
    // Surface same-path open-turn contention for symmetry with restorePaths.
    const validation = this.validateRestorePaths(params.turnId, paths, params.workspaceId);
    return this.executeRestore((params.strategy ?? 'exact') === 'merge-undo' ? 'merge_undo_turn' : 'revert_turn', {
      ...params,
      paths,
      contention: validation.contention,
    });
  }

  // ── the compound op: one RESTORE-priority lock acquisition ─────────────────────

  private async executeRestore(
    kind: RestoreOutcome['kind'],
    args: {
      turnId: string;
      paths: string[];
      workspaceId: string;
      actor: string;
      capability: GitCapability;
      operationId?: string;
      previewTokens?: Record<string, string>;
      force?: boolean;
      strategy?: RestoreStrategy;
      mergePreviewToken?: string;
      contention: { path: string; turnId: string }[];
    },
  ): Promise<RestoreOutcome> {
    const key = args.capability.commonDirQueueKey;
    const repoRoot = args.capability.repoRoot;
    if (!key || !repoRoot) {
      return this.failedOutcome(kind, args.operationId ?? '', args.paths, args.contention, 'missing-repo');
    }
    const settled = await this.queue.withLock(key, () => this.runRestore(kind, { ...args, repoRoot }));
    if (isSkippedDeadline(settled)) {
      // withLock uses an infinite deadline, so this is unreachable in practice.
      return this.failedOutcome(kind, args.operationId ?? '', args.paths, args.contention, 'lock-skipped');
    }
    return settled;
  }

  private async runRestore(
    kind: RestoreOutcome['kind'],
    args: {
      turnId: string;
      paths: string[];
      workspaceId: string;
      actor: string;
      capability: GitCapability;
      repoRoot: string;
      operationId?: string;
      previewTokens?: Record<string, string>;
      force?: boolean;
      strategy?: RestoreStrategy;
      mergePreviewToken?: string;
      contention: { path: string; turnId: string }[];
    },
  ): Promise<RestoreOutcome> {
    const { repoRoot } = args;
    // Canonical (realpath'd) root — all filesystem paths key off this so a
    // symlinked temp dir (mac `/var`→`/private/var`, Windows short names) can never
    // make an in-workspace descendant look out-of-workspace. Git commands keep
    // `repoRoot` (git resolves either).
    const root = this.canonicalRoot(repoRoot);
    const paths = dedupe(args.paths);
    const operationId = args.operationId ?? randomUUID();
    let contention: { path: string; turnId: string }[] = [];

    // 1. Write the recovery_operations row `pending` (before any snapshot/mutation).
    this.recoveryStore.insertRecoveryOperation(args.workspaceId, {
      id: operationId,
      kind,
      actor: args.actor,
      status: 'pending',
      sourceTurnId: args.turnId,
      requestedPaths: paths,
      ...((args.strategy ?? 'exact') === 'merge-undo' ? { previewToken: args.mergePreviewToken ?? null } : {}),
    });

    const fail = (reason: string, extra?: Partial<RestoreOutcome>): RestoreOutcome => {
      const overlap = extra?.overlap;
      const rejectedPaths = extra?.rejectedPaths ?? [];
      this.recoveryStore.updateRecoveryOperation(operationId, {
        status: 'failed',
        failureReason: reason,
        endedAt: this.now(),
        result: JSON.stringify({
          ...(overlap ? { overlap } : {}),
          contention,
          ...(rejectedPaths.length > 0 ? { rejectedPaths } : {}),
        }),
      });
      return {
        status: 'failed',
        operationId,
        kind,
        preRef: extra?.preRef ?? null,
        preOid: extra?.preOid ?? null,
        requestedPaths: paths,
        completedPaths: [],
        rejectedPaths,
        failures: extra?.failures ?? [],
        contention,
        failureReason: reason,
        ...(overlap ? { overlap } : {}),
      };
    };

    // Strategy dispatch is deliberately above every exact-only classifier/source/gate.
    // Merge undo owns its token, edge, contention, planner, PRE, and apply checks and
    // cannot fall through to checkAfterSnapshot or the exact preview-token/force path.
    if ((args.strategy ?? 'exact') === 'merge-undo') {
      if (args.force) return fail('merge-force-refused');
      const consumed = args.mergePreviewToken
        ? this.mergeUndoPreviewRegistry.consumeDetailed(args.mergePreviewToken)
        : { kind: 'invalid' as const };
      if (consumed.kind !== 'ok') {
        return fail(consumed.kind === 'expired' ? 'merge-preview-token-expired' : 'merge-preview-token-invalid');
      }
      const token = consumed.record;
      if (
        token.workspaceId !== args.workspaceId
        || token.turnId !== args.turnId
        || token.strategy !== 'merge-undo'
        || JSON.stringify(token.requestedPaths) !== JSON.stringify([...paths].sort())
        || token.mergeExitCode !== 0
        || token.hasUnmergedRecords
      ) return fail('merge-preview-token-invalid');

      const row = this.store.getTurnRecord(args.turnId);
      if (!row) return fail('unknown-turn');
      const [beforeUsable, afterUsable] = await Promise.all([
        this.verifyEdgeUsable(repoRoot, row.beforeReady, row.beforeRef, row.beforeOid),
        this.verifyEdgeUsable(repoRoot, row.afterReady, row.afterRef, row.afterOid),
      ]);
      if (!beforeUsable) return fail('before-edge-unusable');
      if (!afterUsable || !row.beforeOid || !row.afterOid) return fail('after-edge-unusable');
      if (row.beforeOid !== token.beforeCommitOid || row.afterOid !== token.afterCommitOid) {
        return fail('merge-preview-token-invalid');
      }

      contention = this.openTurnContention(args.turnId, paths, args.workspaceId);
      const plannerInput: UndoMergePlannerInput = {
        cwd: repoRoot,
        beforeOid: row.beforeOid,
        afterOid: row.afterOid,
        requestedPaths: paths,
        witnessedPaths: this.revertTurnPathSet(args.turnId).paths,
        liveContentionPaths: contention.map((entry) => entry.path),
      };
      const classified = await this.planUndoMerge(plannerInput);
      if (classified.kind !== 'ready') {
        return fail(mergePlanFailureReason(classified));
      }
      if (!sameMergeIdentity(token, mergePreviewIdentity(
        args.workspaceId, args.turnId, row.beforeOid, row.afterOid, paths, classified,
      ))) return fail('merge-preview-token-invalid');

      const currentStat = new Map<string, LstatInfo | null>();
      for (const p of paths) currentStat.set(p, this.lstatAbs(this.abs(root, p)));
      let pre: SafetyPreOutcome;
      try {
        pre = await this.captureSafetyPre({
          repoRoot,
          repoState: args.capability.repoState === 'unborn' ? 'unborn' : 'repo',
          workspaceId: args.workspaceId,
          operationId,
          paths,
          currentStat,
          captureIndex: true,
        });
      } catch (err) {
        return fail(`pre-snapshot-failed:${describeError(err)}`);
      }
      this.recoveryStore.updateRecoveryOperation(operationId, { preIncludedPaths: pre.included });
      if (!pre.ok) return fail(pre.reason ?? 'pre-snapshot-failed', { preRef: pre.ref, preOid: pre.oid });

      // Re-plan after PRE so all mechanical identity is live at the last safe point.
      const replanned = await this.planUndoMerge(plannerInput);
      if (replanned.kind !== 'ready' || !sameMergeIdentity(token, mergePreviewIdentity(
        args.workspaceId, args.turnId, row.beforeOid, row.afterOid, paths, replanned.kind === 'ready' ? replanned : classified,
      ))) {
        return fail(replanned.kind === 'ready' ? 'merge-preview-token-invalid' : mergePlanFailureReason(replanned), {
          preRef: pre.ref, preOid: pre.oid,
        });
      }
      if (replanned.paths.some((entry) => entry.conflictStages.length > 0)) {
        return fail('merge-preview-token-invalid', { preRef: pre.ref, preOid: pre.oid });
      }

      this.recoveryStore.updateRecoveryOperation(operationId, { status: 'ready' });
      const completed: string[] = [];
      const failures: { path: string; reason: string }[] = [];
      const requestedSet = new Set(paths);
      for (const p of paths) {
        const plannedPath = replanned.paths.find((entry) => entry.path === p);
        if (!plannedPath) {
          failures.push({ path: p, reason: 'merge-result-missing' });
          continue;
        }
        const target: RestoreTarget = plannedPath.result
          ? { kind: 'present', mode: plannedPath.result.mode, oid: plannedPath.result.blobOid }
          : { kind: 'absent' };
        // A path that currently exists in the worktree with NO index entry is an
        // UNTRACKED file (the planner already refuses genuinely diverged TRACKED
        // paths): merge it worktree-only and never create an index entry, so the file
        // stays untracked after undo. Both signals are required — a path absent from
        // the index because it was renamed away (`current === null`) must still be
        // restored INTO the index, so it is not worktree-only.
        const worktreeOnly = plannedPath.index === null && plannedPath.current !== null;
        try {
          await this.mutateMergeWorktreePath(repoRoot, root, p, target, requestedSet);
          if (!worktreeOnly) await this.updateRealIndex(repoRoot, p, target);
          completed.push(p);
          this.recoveryStore.updateRecoveryOperation(operationId, { completedPaths: completed });
        } catch (err) {
          failures.push({ path: p, reason: describeError(err) });
        }
      }
      const status: RestoreOutcome['status'] = failures.length === 0 ? 'completed' : 'partial';
      const rollbackCommit = completed.length > 0
        ? await this.writeRollbackCommit(repoRoot, args.turnId, operationId, kind, args.actor, completed)
        : undefined;
      this.recoveryStore.updateRecoveryOperation(operationId, {
        status,
        completedPaths: completed,
        failureReason: failures.length > 0 ? failures.map((entry) => `${entry.path}:${entry.reason}`).join('; ') : null,
        result: JSON.stringify({ completed, failures, ...(rollbackCommit ? { rollbackCommit } : {}) }),
        endedAt: this.now(),
      });
      return {
        status,
        operationId,
        kind,
        preRef: pre.ref,
        preOid: pre.oid,
        requestedPaths: paths,
        completedPaths: completed,
        rejectedPaths: [],
        failures,
        contention,
        failureReason: null,
        ...(rollbackCommit ? { rollbackCommit } : {}),
      };
    }

    // 0. Classify requested paths: ignored (check-ignore trichotomy) + unsupported
    //    current entry types are REJECTED as not-covered-by-before-checkpoint. Any
    //    rejection fails the whole op visibly with NO mutation.
    const ignore = await classifyIgnored({ repoRoot, paths, runGit: this.runGit, gitExe: this.gitExe });
    if (ignore.kind === 'error') {
      return fail('check-ignore-error');
    }
    const ignored = ignore.kind === 'some-ignored' ? ignore.ignored : [];
    const unsupported: string[] = [];
    const currentStat = new Map<string, LstatInfo | null>();
    for (const p of paths) {
      const st = this.lstatAbs(this.abs(root, p));
      currentStat.set(p, st);
      if (st && isUnsupportedEntry(st)) unsupported.push(p);
    }
    const rejectedPaths = dedupe([...ignored, ...unsupported]);
    if (rejectedPaths.length > 0) {
      return fail('not-covered-by-before-checkpoint', { rejectedPaths });
    }

    // The before edge is the ONLY source: it must be ready AND live rev-parse-verify
    // to the stored OID (reuse the G1.3b guard — DB ready flags are hints, not authority).
    const row = this.store.getTurnRecord(args.turnId);
    if (!row) return fail('unknown-turn');
    const beforeUsable = await this.verifyEdgeUsable(repoRoot, row.beforeReady, row.beforeRef, row.beforeOid);
    if (!beforeUsable) return fail('before-edge-unusable');
    const beforeOid = row.beforeOid as string;

    // Recompute under the restore lock. Pre-lock preview/validation contention is
    // advisory only and is never returned by runRestore.
    contention = this.openTurnContention(args.turnId, paths, args.workspaceId);

    const afterUsable = await this.verifyEdgeUsable(
      repoRoot,
      row.afterReady,
      row.afterRef,
      row.afterOid,
    );
    const gate = await checkAfterSnapshot({
      repoRoot,
      gitExe: this.gitExe,
      workspaceId: args.workspaceId,
      turnId: args.turnId,
      turnSeq: row.turnSeq,
      afterOid: row.afterOid,
      afterEdgeUsable: afterUsable,
      paths,
      store: this.store,
      runGit: this.runGit,
      lstatPath: (p) => currentStat.get(p) ?? null,
      hashPaths: (gatePaths) => this.hashPaths(
        repoRoot,
        [...gatePaths],
        this.now() + this.restoreTuning.fileTimeoutMs,
      ),
    });
    if (!gate.ok) {
      return fail(
        gate.failureReason,
        gate.failureReason === 'current-hash-failed' ? undefined : { overlap: gate.overlap },
      );
    }
    if (contention.length > 0) return fail('active-turn-witnesses-path');

    // 2. Path-scoped PRE safety checkpoint (present-with-OID/mode or explicitly absent);
    //    create + verify the recovery `pre` ref. Abort the ENTIRE restore unless verified.
    let pre: SafetyPreOutcome;
    try {
      pre = await this.captureSafetyPre({
        repoRoot,
        repoState: args.capability.repoState === 'unborn' ? 'unborn' : 'repo',
        workspaceId: args.workspaceId,
        operationId,
        paths,
        currentStat,
      });
    } catch (err) {
      return fail(`pre-snapshot-failed:${describeError(err)}`);
    }
    this.recoveryStore.updateRecoveryOperation(operationId, {
      preIncludedPaths: pre.included,
    });
    if (!pre.ok) {
      return fail(pre.reason ?? 'pre-snapshot-failed', { preRef: pre.ref, preOid: pre.oid });
    }

    // 3. pending → ready. (Distinguishes kill-during-snapshot=`pending` from
    //    failure-before-mutation=`ready` with no `completed_paths`.)
    this.recoveryStore.updateRecoveryOperation(operationId, { status: 'ready' });

    // 4. Resolve restore sources from the BEFORE commit via ls-tree: blob OID + mode
    //    per present path; absent-from-tree paths are targeted for deletion.
    let targets: Map<string, RestoreTarget>;
    try {
      targets = await this.lsTreeTargets(repoRoot, beforeOid, paths);
    } catch (err) {
      return fail(`ls-tree-failed:${describeError(err)}`);
    }

    // 5. Anti-TOCTOU: compare the current OID (captured in the PRE snapshot) to the
    //    preview token; abort on mismatch unless human-force.
    if (args.previewTokens && !args.force) {
      for (const p of paths) {
        const token = args.previewTokens[p];
        if (token === undefined) continue;
        const now = pre.currentOid.get(p) ?? ABSENT_SENTINEL;
        if (token !== now) {
          return fail('preview-token-mismatch', { preRef: pre.ref, preOid: pre.oid });
        }
      }
    }

    // 6–8. Per-path guarded mutation. A per-path failure is accounted (partial); the
    //      op continues so `completed_paths` stays a faithful recoverability record.
    const requestedSet = new Set(paths);
    const completed: string[] = [];
    const failures: { path: string; reason: string }[] = [];
    for (const p of paths) {
      try {
        await this.mutateOnePath(repoRoot, root, p, targets.get(p) ?? { kind: 'absent' }, requestedSet);
        completed.push(p);
        // Record `completed_paths` incrementally → a killed multi-path restore is
        // recoverable to exactly the point it reached.
        this.recoveryStore.updateRecoveryOperation(operationId, { completedPaths: completed });
      } catch (err) {
        failures.push({ path: p, reason: describeError(err) });
      }
    }

    const status: RestoreOutcome['status'] = failures.length === 0 ? 'completed' : 'partial';
    const rollbackCommit = completed.length > 0
      ? await this.writeRollbackCommit(repoRoot, args.turnId, operationId, kind, args.actor, completed)
      : undefined;
    this.recoveryStore.updateRecoveryOperation(operationId, {
      status,
      completedPaths: completed,
      failureReason: failures.length > 0 ? failures.map((f) => `${f.path}:${f.reason}`).join('; ') : null,
      result: JSON.stringify({ completed, failures, ...(rollbackCommit ? { rollbackCommit } : {}) }),
      endedAt: this.now(),
    });

    return {
      status,
      operationId,
      kind,
      preRef: pre.ref,
      preOid: pre.oid,
      requestedPaths: paths,
      completedPaths: completed,
      rejectedPaths: [],
      failures,
      contention,
      failureReason: null,
      ...(rollbackCommit ? { rollbackCommit } : {}),
    };
  }

  /** Record a successful restore as one ordinary commit while preserving unrelated
   *  staged/dirty work. The caller already holds the repository queue lock. A commit
   *  failure is diagnostic only: restored worktree bytes remain the operation truth. */
  private async writeRollbackCommit(
    repoRoot: string,
    turnId: string,
    operationId: string,
    kind: RestoreOutcome['kind'],
    actor: string,
    completedPaths: readonly string[],
  ): Promise<RollbackCommitResult> {
    const paths = dedupe([...completedPaths]);
    try {
      const present: string[] = [];
      const absent: string[] = [];
      for (const p of paths) {
        (this.lstatAbs(this.abs(this.canonicalRoot(repoRoot), p)) ? present : absent).push(p);
      }
      if (present.length > 0) await this.git(repoRoot, ['add', '--', ...present]);
      if (absent.length > 0) {
        await this.git(repoRoot, ['rm', '--cached', '--ignore-unmatch', '--', ...absent]);
      }

      const changed = await this.git(repoRoot, ['diff', '--cached', '--quiet', '--', ...paths], {
        allowNonzero: true,
      });
      if (changed.code === 0) return { skipped: 'nothing-to-commit' };
      if (changed.code !== 1) return { skipped: `diff-check-failed:${changed.code}` };

      const subject = `[lares] revert: turn ${turnId.slice(0, 8)} (${kind})`;
      const body = [
        'Restored paths:',
        ...paths.map((p) => `- ${p}`),
        '',
        `Reverts-Turn: ${turnId}`,
        `Recovery-Operation: ${operationId}`,
        `Restore-Kind: ${kind}`,
        `Actor: ${actor}`,
      ].join('\n');
      await this.git(repoRoot, [
        ...this.longpaths(), '-c', 'commit.gpgsign=false',
        'commit', '--no-verify', '-m', subject, '-m', body, '--', ...paths,
      ], { mode: 'commit', timeoutMs: 60_000 });
      const oid = (await this.git(repoRoot, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
      return OID_RE.test(oid) ? { oid } : { skipped: 'commit-oid-invalid' };
    } catch (err) {
      return { skipped: describeError(err) };
    }
  }

  /** Same-path write/create witnesses from other currently-open turns. */
  private openTurnContention(
    turnId: string,
    paths: readonly string[],
    workspaceId: string,
  ): { path: string; turnId: string }[] {
    const requested = new Set(paths);
    const seen = new Set<string>();
    const contention: { path: string; turnId: string }[] = [];
    for (const other of this.store.listOpenTurnRecords(workspaceId)) {
      if (other.id === turnId) continue;
      for (const entry of other.touched ?? []) {
        if ((entry.op !== 'write' && entry.op !== 'create') || !requested.has(entry.path)) continue;
        const key = `${entry.path}\0${other.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        contention.push({ path: entry.path, turnId: other.id });
      }
    }
    return contention;
  }

  // ── step 2: path-scoped PRE safety checkpoint ──────────────────────────────────

  /**
   * Snapshot the CURRENT state of exactly the requested paths so the whole restore is
   * reversible. Each surviving path is recorded present (raw blob OID + mode via
   * `hash-object --no-filters`) or explicitly absent; a path currently occupied by a
   * directory is recorded as such (its rollback is a no-op — the mutation step guards
   * it). The `…/pre` commit is HEAD-seeded for coherence but is PATH-SCOPED: it
   * authoritatively covers ONLY `pre_included_paths` and can never feed whole-tree
   * recovery. The ref is created + verified with the same durable write order the
   * before/after edges use (persist OID → create-only update-ref → rev-parse verify →
   * mark ready); the entire restore aborts unless that ref + OID verify.
   */
  private async captureSafetyPre(a: {
    repoRoot: string;
    repoState: 'repo' | 'unborn';
    workspaceId: string;
    operationId: string;
    paths: string[];
    currentStat: Map<string, LstatInfo | null>;
    captureIndex?: boolean;
  }): Promise<SafetyPreOutcome> {
    const { repoRoot, repoState, operationId, paths, currentStat } = a;
    const ref = recoveryRef({ workspaceId: a.workspaceId, operationId });
    const indexFile = path.join(this.tmpDir, `lares-idx-${randomUUID()}`);
    const included: PreIncludedPath[] = [];
    const currentOid = new Map<string, string>();

    try {
      const seedArgs = repoState === 'unborn' ? ['read-tree', '--empty'] : ['read-tree', 'HEAD'];
      await this.git(repoRoot, seedArgs, { indexFile });
      const seededModes = await this.readSeededModes(repoRoot, indexFile, this.now() + this.restoreTuning.fileTimeoutMs);

      // Partition present (file/symlink) vs absent vs directory.
      const presentPaths: string[] = [];
      for (const p of paths) {
        const st = currentStat.get(p) ?? null;
        if (st === null) {
          included.push({ path: p, state: 'absent' });
        } else if (st.isDirectory) {
          // A directory occupying a requested (file) path: not a present-blob rollback
          // target. Recorded so the safety ref is honest; the mutation step's
          // directory-transition guard decides whether it may be removed.
          included.push({ path: p, state: 'directory' });
        } else {
          presentPaths.push(p);
        }
      }

      const oidByPath = await this.hashPaths(repoRoot, presentPaths, this.now() + this.restoreTuning.fileTimeoutMs);
      const additions: string[] = [];
      let sampleOidLen = 0;
      const deletions: string[] = [];
      for (const p of presentPaths) {
        const oid = oidByPath.get(p);
        if (!oid) throw new Error(`hash-object produced no OID for ${p}`);
        currentOid.set(p, oid);
        if (sampleOidLen === 0) sampleOidLen = oid.length;
        const st = currentStat.get(p);
        const mode = deriveRawGitMode(
          seededModes.get(p) ?? null,
          st ? { isFile: st.isFile, isSymbolicLink: st.isSymbolicLink, mode: st.mode } : null,
          this.platform,
        );
        if (mode === null) throw new Error(`cannot derive raw Git mode for ${p}`);
        included.push({ path: p, state: 'present', oid, mode });
        additions.push(`${mode} ${oid}\t${p}`);
      }
      const zeroOid = sampleOidLen > 0 ? '0'.repeat(sampleOidLen) : SHA1_ZERO;
      for (const rec of included) {
        if (rec.state === 'absent') deletions.push(`0 ${zeroOid}\t${rec.path}`);
      }
      // Absent paths in the PRE snapshot get the ABSENT sentinel for the token compare.
      for (const rec of included) if (rec.state !== 'present') currentOid.set(rec.path, ABSENT_SENTINEL);

      if (a.captureIndex) {
        const index = await this.readRealIndexEntries(repoRoot, paths);
        for (const rec of included) {
          const entry = index.get(rec.path) ?? null;
          rec.indexState = entry ? 'present' : 'absent';
          if (entry) {
            rec.indexOid = entry.oid;
            rec.indexMode = entry.mode;
          }
        }
      }

      const indexInfo = [...additions, ...deletions];
      if (indexInfo.length > 0) {
        const stdin = indexInfo.map((line) => `${line}\0`).join('');
        await this.git(repoRoot, ['update-index', '-z', '--index-info'], { indexFile, stdin });
      }

      const treeOid = (await this.git(repoRoot, ['write-tree'], { indexFile })).stdout.trim();
      const commitTopLevel = this.longpaths().concat(['-c', 'commit.gpgsign=false']);
      const commitOid = (
        await this.git(repoRoot, [...commitTopLevel, 'commit-tree', treeOid, '-m', `lares:recovery-pre:${operationId}`], {
          mode: 'commit',
        })
      ).stdout.trim();

      // Durable write order: persist candidate + ref (pre_ready=0) → create-only
      // update-ref → verify → pre_ready=1. A collision/kill yields a mismatch, never a
      // false safety guarantee.
      this.recoveryStore.updateRecoveryOperation(operationId, {
        preOid: commitOid,
        preRef: ref,
        preReady: false,
        preIncludedPaths: included,
      });
      await this.git(repoRoot, ['update-ref', ref, commitOid, SHA1_ZERO], { allowNonzero: true });
      const verify = await this.git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`], { allowNonzero: true });
      if (verify.code !== 0 || verify.stdout.trim() !== commitOid) {
        return { ok: false, ref, oid: commitOid, included, currentOid, reason: 'pre-verify-mismatch' };
      }
      this.recoveryStore.updateRecoveryOperation(operationId, { preReady: true });
      return { ok: true, ref, oid: commitOid, included, currentOid, reason: null };
    } finally {
      this.scheduleCleanup(indexFile);
    }
  }

  // ── step 4: resolve restore sources from the before commit ─────────────────────

  /** `ls-tree -z <before_commit> -- <literal path…>` → present (blob OID + mode) vs
   *  absent-in-tree (→ delete). The mode comes from the tree entry, never cat-file. */
  private async lsTreeTargets(
    repoRoot: string,
    beforeCommit: string,
    paths: string[],
  ): Promise<Map<string, RestoreTarget>> {
    const out = new Map<string, RestoreTarget>();
    // Default every requested path to absent-in-tree (→ delete) until ls-tree proves present.
    for (const p of paths) out.set(p, { kind: 'absent' });
    if (paths.length === 0) return out;

    const res = await this.git(repoRoot, ['ls-tree', '-z', beforeCommit, '--', ...paths], {
      maxBytes: 64 << 20,
    });
    for (const rec of res.stdout.split('\0')) {
      if (rec.length === 0) continue;
      // `<mode> SP <type> SP <oid>\t<path>`
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const meta = rec.slice(0, tab).split(/\s+/);
      const p = rec.slice(tab + 1);
      if (meta.length < 3) continue;
      const [mode, , oid] = meta;
      out.set(p, { kind: 'present', mode, oid });
    }
    return out;
  }

  private async readRealIndexEntries(
    repoRoot: string,
    paths: string[],
  ): Promise<Map<string, { mode: string; oid: string }>> {
    const result = await this.runGitBytes(repoRoot, ['ls-files', '--stage', '-z', '--', ...paths], {
      gitExe: this.gitExe,
      timeoutMs: this.restoreTuning.fileTimeoutMs,
      maxBytes: 64 << 20,
    });
    if (result.code !== 0) throw new RestoreError('index-read-failed');
    const entries = new Map<string, { mode: string; oid: string }>();
    for (const record of result.stdout.toString('utf8').split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t');
      const meta = tab < 0 ? [] : record.slice(0, tab).split(' ');
      if (meta.length !== 3 || meta[2] !== '0') throw new RestoreError('index-worktree-diverged');
      entries.set(record.slice(tab + 1), { mode: meta[0], oid: meta[1] });
    }
    return entries;
  }

  private async updateRealIndex(repoRoot: string, relPath: string, target: RestoreTarget): Promise<void> {
    const args = target.kind === 'present'
      ? ['update-index', '--add', '--cacheinfo', target.mode, target.oid, relPath]
      : ['update-index', '--force-remove', '--', relPath];
    const result = await this.git(repoRoot, args, { allowNonzero: true });
    if (result.code !== 0) throw new RestoreError('index-update-failed');
  }

  /** Materialize a clean merge blob through Git's smudge pipeline before the same
   * guarded atomic worktree transition used by exact restore. */
  private async mutateMergeWorktreePath(
    repoRoot: string,
    root: string,
    relPath: string,
    target: RestoreTarget,
    requestedSet: Set<string>,
  ): Promise<void> {
    const targetAbs = this.abs(root, relPath);
    if (!withinRoot(targetAbs, root)) throw new RestoreError('path-escapes-workspace');
    this.assertSafeAncestors(root, relPath);
    if (target.kind === 'absent') {
      const st = this.lstatAbs(targetAbs);
      if (st === null) return;
      if (st.isDirectory) {
        this.clearDirectoryForTransition(root, targetAbs, requestedSet);
        return;
      }
      this.assertSafeAncestors(root, relPath);
      await this.guardedUnlink(targetAbs);
      return;
    }
    if (target.mode !== '100644' && target.mode !== '100755') {
      throw new RestoreError(`unsupported-tree-mode:${target.mode}`);
    }
    this.clearDirectoryForTransition(root, targetAbs, requestedSet);
    const dir = path.dirname(targetAbs);
    fs.mkdirSync(dir, { recursive: true });
    this.assertSafeAncestors(root, relPath);
    const tmp = path.join(dir, `.lares-restore-${randomUUID()}.tmp`);
    try {
      const smudged = await this.runGitBytes(repoRoot, ['cat-file', '--filters', `--path=${relPath}`, target.oid], {
        gitExe: this.gitExe,
        timeoutMs: this.restoreTuning.fileTimeoutMs,
        maxBytes: this.restoreTuning.fileMaxBytes,
      });
      if (smudged.code !== 0) throw new RestoreError('blob-smudge-failed');
      fs.writeFileSync(tmp, smudged.stdout);
      this.applyMode(tmp, target.mode);
      await this.atomicReplace(tmp, targetAbs);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
      throw err;
    }
  }

  // ── steps 6–8: per-path guarded mutation ───────────────────────────────────────

  private async mutateOnePath(
    repoRoot: string,
    root: string,
    relPath: string,
    target: RestoreTarget,
    requestedSet: Set<string>,
  ): Promise<void> {
    const targetAbs = this.abs(root, relPath);

    // Ancestor guard: reject if any existing ancestor is a symlink/junction/reparse
    // point escaping the canonical workspace.
    this.assertSafeAncestors(root, relPath);

    if (target.kind === 'present') {
      // 9. Symlink / gitlink / non-regular tree modes → visible failure (never silent
      //    conversion). Symlink restore is unsupported-until-implemented.
      if (target.mode === '120000') throw new RestoreError('symlink-restore-unsupported');
      if (target.mode === '160000') throw new RestoreError('gitlink-restore-unsupported');
      if (target.mode !== '100644' && target.mode !== '100755') {
        throw new RestoreError(`unsupported-tree-mode:${target.mode}`);
      }

      // 7. Directory-transition safety: the target may become a file only if it is not
      //    currently a NON-EMPTY directory holding unrelated (non-requested) descendants.
      this.clearDirectoryForTransition(root, targetAbs, requestedSet);

      // Ensure the parent directory exists (guarded), then write to a same-dir temp.
      const dir = path.dirname(targetAbs);
      fs.mkdirSync(dir, { recursive: true });
      // Recheck ancestors immediately before the rename (TOCTOU window).
      this.assertSafeAncestors(root, relPath);

      const tmp = path.join(dir, `.lares-restore-${randomUUID()}.tmp`);
      try {
        await this.runGitBlobToFile(repoRoot, target.oid, tmp, {
          maxBytes: this.restoreTuning.fileMaxBytes,
          deadlineAt: this.now() + this.restoreTuning.fileTimeoutMs,
          gitExe: this.gitExe,
        });
        this.applyMode(tmp, target.mode);
        await this.atomicReplace(tmp, targetAbs);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* best-effort — never leave a temp behind */ }
        if (err instanceof GitBlobError) throw new RestoreError(`blob-${err.reason}`);
        throw err;
      }
      return;
    }

    // 8. Absent-in-tree → guarded delete of a file/symlink or empty dir ONLY. Never a
    //    recursive removal of unrelated descendants.
    const st = this.lstatAbs(targetAbs);
    if (st === null) return; // already absent → nothing to do
    if (st.isDirectory) {
      this.clearDirectoryForTransition(root, targetAbs, requestedSet);
      return;
    }
    // file/symlink → guarded delete (recheck ancestors immediately before).
    this.assertSafeAncestors(root, relPath);
    await this.guardedUnlink(targetAbs);
  }

  /**
   * Directory-transition guard (invariant #24). An existing EMPTY directory at the
   * target is removed. A NON-EMPTY directory fails visibly UNLESS every descendant is
   * itself explicitly requested (and therefore previewed + captured in the PRE
   * snapshot), in which case the whole subtree is removed. Unrelated descendant files
   * are NEVER recursively deleted.
   */
  private clearDirectoryForTransition(root: string, targetAbs: string, requestedSet: Set<string>): void {
    const st = this.lstatAbs(targetAbs);
    if (st === null || !st.isDirectory) return; // not a directory → nothing to clear here
    const descendants = listDescendantFiles(targetAbs);
    if (descendants.length === 0) {
      fs.rmdirSync(targetAbs);
      return;
    }
    for (const abs of descendants) {
      const rel = toRepoRel(root, abs);
      if (rel === null || !requestedSet.has(rel)) {
        throw new RestoreError('dir-transition-blocked-unrelated-descendant');
      }
    }
    // Every descendant is itself requested → removing the subtree deletes nothing
    // unrelated.
    fs.rmSync(targetAbs, { recursive: true, force: true });
  }

  /** Atomic rename-replace with Windows read-only clear + EPERM/EBUSY (AV-lock) retry.
   *  On failure the caller deletes the temp; here we only leave the target untouched. */
  private async atomicReplace(tmpAbs: string, targetAbs: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (this.platform === 'win32') this.clearReadOnly(targetAbs);
        fs.renameSync(tmpAbs, targetAbs);
        return;
      } catch (err) {
        if (attempt >= this.restoreTuning.replaceRetries || !isTransientFsError(err)) {
          throw new RestoreError(`replace-failed:${errCode(err)}`);
        }
        await sleep(this.restoreTuning.replaceBackoffMs * (attempt + 1));
      }
    }
  }

  /** Guarded unlink with the same Windows read-only clear + AV-lock retry semantics. */
  private async guardedUnlink(targetAbs: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (this.platform === 'win32') this.clearReadOnly(targetAbs);
        fs.unlinkSync(targetAbs);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        if (attempt >= this.restoreTuning.replaceRetries || !isTransientFsError(err)) {
          throw new RestoreError(`delete-failed:${errCode(err)}`);
        }
        await sleep(this.restoreTuning.replaceBackoffMs * (attempt + 1));
      }
    }
  }

  private clearReadOnly(targetAbs: string): void {
    try {
      const st = fs.lstatSync(targetAbs);
      // Clear the read-only bit (add owner-write) before a replace/delete on Windows.
      fs.chmodSync(targetAbs, st.mode | 0o200);
    } catch {
      /* ENOENT / unsupported — nothing to clear */
    }
  }

  /** Apply the ls-tree git filemode to the freshly-written temp file. On POSIX this
   *  sets 0755 for 100755 else 0644; on Windows only the read-only bit is meaningful. */
  private applyMode(tmpAbs: string, mode: string): void {
    try {
      fs.chmodSync(tmpAbs, mode === '100755' ? 0o755 : 0o644);
    } catch {
      /* best-effort — Windows chmod is a no-op beyond the read-only bit */
    }
  }

  /** Reject if any EXISTING ancestor directory of `relPath` resolves (realpath) outside
   *  the canonical workspace — a symlink/junction/reparse-point escape (invariant #13).
   *  Uses the nearest existing ancestor so a not-yet-created leaf never blocks. */
  private assertSafeAncestors(root: string, relPath: string): void {
    const parentAbs = path.dirname(this.abs(root, relPath));
    let nearest = parentAbs;
    // Walk up until an existing ancestor is found.
    // (`mkdirSync(recursive)` may create these later; we only guard what exists now.)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (fs.existsSync(nearest)) break;
      const up = path.dirname(nearest);
      if (up === nearest) break;
      nearest = up;
    }
    let real: string;
    try {
      real = fs.realpathSync(nearest);
    } catch {
      throw new RestoreError('ancestor-unresolvable');
    }
    if (!withinRoot(real, root)) {
      throw new RestoreError('ancestor-escapes-workspace');
    }
  }

  private canonicalRoot(repoRoot: string): string {
    try {
      return fs.realpathSync(repoRoot);
    } catch {
      return path.resolve(repoRoot);
    }
  }

  /** Join a repo-relative POSIX path onto the (canonical) root as an absolute OS path. */
  private abs(rootAbs: string, relPath: string): string {
    return path.resolve(rootAbs, relPath.split('/').join(path.sep));
  }

  private failedOutcome(
    kind: RestoreOutcome['kind'],
    operationId: string,
    paths: string[],
    contention: { path: string; turnId: string }[],
    reason: string,
    overlap?: AfterSnapshotOverlap,
  ): RestoreOutcome {
    return {
      status: 'failed',
      operationId,
      kind,
      preRef: null,
      preOid: null,
      requestedPaths: dedupe(paths),
      completedPaths: [],
      rejectedPaths: [],
      failures: [],
      contention,
      failureReason: reason,
      ...(overlap ? { overlap } : {}),
    };
  }
}

// ── diff / validation DTOs ──────────────────────────────────────────────────────

export interface DiffResult {
  available: boolean;
  reason: string | null;
  /** Human label — witnessed vs. "unattributed changes in this window". */
  label: string;
  text: string | null;
  provenance?: 'witnessed' | 'raw-window';
}

/** WP-G3.1 file-history version: one retained turn that WITNESSED a write/create to
 *  a single canonical path AND whose before-edge ref LIVE-verifies right now. A
 *  pruned/dead-ref edge is never emitted (the presence of a version IS the
 *  restorable guarantee). Carries witnessed PATHS only, never worktree bytes. */
export interface FileHistoryVersion {
  turnId: string;
  turnSeq: number;
  agentId: string | null;
  agentTitle: string | null;
  taskLabel: string | null;
  status: string;
  startedAt: number | null;
  endedAt: number | null;
  beforeReady: boolean;
  afterReady: boolean;
  beforeQuality: string | null;
  afterQuality: string | null;
  /** The canonical (repo-relative) witnessed path this version covers. */
  witnessedPath: string;
  op: 'write' | 'create';
  /** After edge also live-verified → the turn diff is available. */
  afterVerified: boolean;
  beforeRawFilterBypassed: boolean;
}

/** WP-G2.1 restore preview: witnessed set + per-path anti-TOCTOU tokens (current
 *  worktree OID, or the ABSENT sentinel) the HTTP caller echoes back to
 *  restore/revert. `available` is true only when the before edge is usable AND every
 *  requested path is witnessed. Carries NO worktree bytes — only paths + OIDs. */
export interface CheckpointPreviewResult {
  available: boolean;
  reason: string | null;
  turnId: string;
  witnessedSet: string[];
  /** path → current worktree OID (present) or the ABSENT sentinel — the preview token. */
  tokens: Record<string, string>;
  validatedPaths: string[];
  rejectedPaths: string[];
  contention: { path: string; turnId: string }[];
  overlap?: AfterSnapshotOverlap;
  strategy?: RestoreStrategy;
  mergePreviewToken?: string;
  pathStates?: SharedMergeUndoPathPreview[];
  omittedBytes?: number;
  omittedPathCount?: number;
}

export interface RestorePathValidation {
  ok: boolean;
  turnId: string;
  /** The canonical witnessed write/create set. */
  witnessedSet: string[];
  /** Requested paths accepted (subset of the witnessed set). */
  validatedPaths: string[];
  /** Requested paths NOT witnessed by this turn → rejected. */
  rejectedPaths: string[];
  /** Same-path contention from other OPEN turn_records. */
  contention: { path: string; turnId: string }[];
}

// ── restore DTOs ────────────────────────────────────────────────────────────────

/** One entry in `recovery_operations.pre_included_paths`. Path-scoped: authoritatively
 *  covers ONLY these paths. `present` carries the current raw blob OID + git mode;
 *  `absent` means the path did not exist; `directory` means a directory occupied the
 *  (file) path and was left untouched (its rollback is a no-op). */
export interface PreIncludedPath {
  path: string;
  state: 'present' | 'absent' | 'directory';
  oid?: string;
  mode?: string;
  /** Merge undo additionally records the prior real-index entry for rollback. */
  indexState?: 'present' | 'absent';
  indexOid?: string;
  indexMode?: string;
}

/** A restore source resolved from the before commit via ls-tree. */
type RestoreTarget =
  | { kind: 'present'; mode: string; oid: string }
  | { kind: 'absent' };

interface SafetyPreOutcome {
  ok: boolean;
  ref: string;
  oid: string;
  included: PreIncludedPath[];
  /** path → current-worktree OID (present) or the ABSENT sentinel — for the preview
   *  token compare (reuses the PRE-captured hash, no re-hash). */
  currentOid: Map<string, string>;
  reason: string | null;
}

export interface RestoreOutcome {
  status: 'completed' | 'partial' | 'failed';
  operationId: string;
  kind: 'restore_paths' | 'revert_turn' | 'merge_undo_paths' | 'merge_undo_turn';
  /** The path-scoped safety `pre` ref (usable to roll the restore back). */
  preRef: string | null;
  preOid: string | null;
  requestedPaths: string[];
  /** Paths successfully restored (incrementally recorded → partial-recoverable). */
  completedPaths: string[];
  /** Paths rejected at classification (ignored / unsupported-entry-type / non-witnessed). */
  rejectedPaths: string[];
  /** Per-path mutation failures (partial outcome). */
  failures: { path: string; reason: string }[];
  /** Same-path open-turn contention surfaced to the caller. */
  contention: { path: string; turnId: string }[];
  overlap?: AfterSnapshotOverlap;
  /** Op-level failure reason (classification / before-edge / pre-snapshot). */
  failureReason: string | null;
  /** Best-effort history record for a successful non-empty restore. */
  rollbackCommit?: RollbackCommitResult;
}

export type RollbackCommitResult = { oid: string } | { skipped: string };

// ── internals ────────────────────────────────────────────────────────────────

/** Thrown out of rawSnapshot when enumeration returns an oversized skip. */
class EnumerationSkipError extends Error {
  constructor(readonly reason: string, readonly detail: string) {
    super(`enumeration skipped: ${reason}`);
    this.name = 'EnumerationSkipError';
  }
}

function isSkippedDeadline(v: unknown): v is SkippedDeadline {
  return typeof v === 'object' && v !== null && (v as SkippedDeadline).skipped === 'deadline';
}

function describeError(err: unknown): string {
  if (err instanceof GitCommandError) return `git-${err.kind}`;
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

/** Normalize a path to the canonical repo-relative form the witness join stores
 *  (forward slashes, no leading `./` or `/`). An absolute worktree path is made
 *  repo-relative by stripping the `repoRoot` prefix (case-insensitive prefix match
 *  for Windows drive-letter/short-name divergence; the relative TAIL keeps its
 *  git-stored case, so it still matches the stored witnessed path exactly). A path
 *  outside `repoRoot`, or `repoRoot` itself, yields '' (never matches a version). */
function canonicalHistoryPath(input: string, repoRoot: string): string {
  let p = (input ?? '').replace(/\\/g, '/');
  const root = (repoRoot ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (root) {
    const lower = p.toLowerCase();
    const rootLower = root.toLowerCase();
    if (lower === rootLower) return '';
    if (lower.startsWith(rootLower + '/')) p = p.slice(root.length + 1);
  }
  return p.replace(/^\.\//, '').replace(/^\/+/, '');
}

function dedupe(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

type ReadyUndoMergePlan = Extract<UndoMergePlannerResult, { kind: 'ready' }>;

function mergePreviewIdentity(
  workspaceId: string,
  turnId: string,
  beforeCommitOid: string,
  afterCommitOid: string,
  requestedPaths: string[],
  planned: ReadyUndoMergePlan,
): MergeUndoPreviewIdentity {
  return {
    workspaceId,
    turnId,
    strategy: 'merge-undo',
    beforeCommitOid,
    afterCommitOid,
    requestedPaths: [...requestedPaths].sort(),
    renameGroups: planned.renameGroups.map((group) => [...group].sort()),
    resultTreeOid: planned.resultTreeOid,
    mergeExitCode: 0,
    hasUnmergedRecords: planned.paths.some((entry) => entry.conflictStages.length > 0),
    paths: planned.paths.map((entry) => ({
      path: entry.path,
      state: entry.state,
      currentRawOid: entry.current?.rawWorktreeOid ?? null,
      currentCleanOid: entry.current?.blobOid ?? null,
      currentMode: entry.current?.mode ?? null,
      indexCleanOid: entry.index?.blobOid ?? null,
      indexMode: entry.index?.mode ?? null,
      normalizationFingerprint: entry.normalizationFingerprint ?? '',
      resultBlobOid: entry.result?.blobOid ?? null,
      resultMode: entry.result?.mode ?? null,
    })),
  };
}

function sameMergeIdentity(a: MergeUndoPreviewIdentity, b: MergeUndoPreviewIdentity): boolean {
  const normalized = (identity: MergeUndoPreviewIdentity) => ({
    workspaceId: identity.workspaceId,
    turnId: identity.turnId,
    strategy: identity.strategy,
    beforeCommitOid: identity.beforeCommitOid,
    afterCommitOid: identity.afterCommitOid,
    requestedPaths: [...identity.requestedPaths].sort(),
    renameGroups: identity.renameGroups.map((group) => [...group].sort())
      .sort((left, right) => left.join('\0').localeCompare(right.join('\0'))),
    resultTreeOid: identity.resultTreeOid,
    mergeExitCode: identity.mergeExitCode,
    hasUnmergedRecords: identity.hasUnmergedRecords,
    paths: [...identity.paths].sort((left, right) => left.path.localeCompare(right.path)),
  });
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}

function mergePlanFailureReason(plan: Exclude<UndoMergePlannerResult, { kind: 'ready' }>): string {
  if (plan.kind === 'conflicted') return plan.reason;
  if (plan.kind === 'refused') {
    return plan.reason === 'refused-live-contention' ? 'active-turn-witnesses-path' : plan.reason;
  }
  return plan.reason;
}

// ── restore internals ─────────────────────────────────────────────────────────

/** Sentinel OID for an absent path in the preview-token compare (an OID can never
 *  collide with it). */
const ABSENT_SENTINEL = '<absent>';

/** A per-path restore mutation failure (accounted as `partial`, never fatal to the op). */
class RestoreError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'RestoreError';
  }
}

/** FIFO / socket / char-or-block device (door) current entries are unsupported — the
 *  before edge never captured a byte-exact pre-image for them (invariant #28 mirror). */
function isUnsupportedEntry(st: LstatInfo): boolean {
  if (st.isFile || st.isSymbolicLink || st.isDirectory) return false;
  return st.isFIFO || st.isSocket || st.isCharacterDevice || st.isBlockDevice;
}

/** Default lstat over an ABSOLUTE path; null on ENOENT/unreadable. Never follows the
 *  final symlink (lstat). */
function defaultAbsLstat(absPath: string): LstatInfo | null {
  try {
    const st = fs.lstatSync(absPath);
    return {
      isFile: st.isFile(),
      isSymbolicLink: st.isSymbolicLink(),
      isDirectory: st.isDirectory(),
      isFIFO: st.isFIFO(),
      isSocket: st.isSocket(),
      isCharacterDevice: st.isCharacterDevice(),
      isBlockDevice: st.isBlockDevice(),
      mode: st.mode,
      size: st.size,
    };
  } catch {
    return null;
  }
}

/** Every regular-file/symlink descendant (absolute paths) under `dirAbs`, recursively. */
function listDescendantFiles(dirAbs: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(abs);
    }
  };
  walk(dirAbs);
  return out;
}

/** Convert an absolute path under `canonicalRoot` to a repo-relative POSIX path, or
 *  null if it is not within the root. */
function toRepoRel(canonicalRoot: string, abs: string): string | null {
  const rel = path.relative(canonicalRoot, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** True when `real` is the canonical root itself or strictly inside it. */
function withinRoot(real: string, canonicalRoot: string): boolean {
  const a = path.resolve(real);
  const root = path.resolve(canonicalRoot);
  if (a === root) return true;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return a.startsWith(withSep);
}

/** Transient FS errors worth a bounded retry (Windows read-only/AV-lock contention). */
function isTransientFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message.slice(0, 40) : String(err));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
