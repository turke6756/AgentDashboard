// SC-WP-1F — read-only, exact checkpoint-protection evaluation.
//
// Stage 1 has no commit ledger, so this module can only produce
// `checkpoint-protected` or `unprotected`. A checkpoint ref being live is merely
// the first gate: the immutable commit named by that edge must also record the
// member's exact {path, expected state, raw blob OID, mode} tuple.

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  PROTECTION_RUNG_ORDER,
  type DirtyEntry,
  type EncodedGitPath,
  type ProtectionRung,
} from '../../shared/commit-candidates';
import {
  GitCommandError,
  type GitRunBytesResult,
  type GitRunResult,
  type RunGitOptions,
} from '../git-checkpoints/git-command';
import {
  liveEdgeKey,
  verifyLiveEdgesBatch,
  type LiveEdgeRunGit,
} from '../git-checkpoints/live-edge';
import type { CommitPathLink, PackageFinalization } from '../database';
import { deriveRawGitMode } from '../git-checkpoints/raw-git-mode';
import {
  readCurrentCommitRepresentation,
  type CommitRepresentation,
  type ReadCurrentCommitRepresentationOptions,
} from './commit-representation';
import { parseFinalizationManifest } from './pinned-selection-drift';
import { SNAPSHOT_TIME_BUDGET } from './dirty-inventory';

export type ProtectionMember = Pick<
  DirtyEntry,
  'entryId' | 'path' | 'expectedWorktreeState' | 'rawWorktreeBlobOid' | 'worktreeMode'
> & Partial<Pick<DirtyEntry, 'commitPathspecs' | 'headMode' | 'indexStatus'>>;

export interface ProtectionCheckpointEdge {
  ref: string | null;
  oid: string | null;
}

export type RunProtectionGitBytes = (
  cwd: string,
  args: string[],
  opts: RunGitOptions,
) => Promise<GitRunBytesResult>;

/** One present entry recorded in a checkpoint commit's tree, keyed by exact path
 *  bytes. Absent paths are represented by their ABSENCE from the returned map. */
export interface CheckpointTreePresence {
  rawBlobOid: string;
  mode: string;
}

export interface ReadCheckpointTreeOptions {
  repoRoot: string;
  checkpointOid: string;
  /** Lossless-UTF-8 member paths to look up in ONE `ls-tree` (multiple pathspecs). */
  paths: readonly EncodedGitPath[];
  runGitBytes: RunProtectionGitBytes;
  gitExe?: string;
  deadlineAt?: number;
}

/**
 * Read the present-entry tuples for a batch of paths from one immutable checkpoint
 * commit. Returns a `pathBytesBase64 → {rawBlobOid, mode}` map; a path missing
 * from the map is authoritatively absent in that tree. Returns `null` when the
 * `ls-tree` read failed or its output was malformed — a broken lookup can never be
 * mistaken for proof that a deletion was captured.
 */
export type CheckpointTreeReader = (
  options: ReadCheckpointTreeOptions,
) => Promise<Map<string, CheckpointTreePresence> | null>;

/**
 * Approved ceiling on the Phase-1 membership probe's cross-product. The
 * synthetic incident oracle is 4,908 × 4,044 = 19,847,952 pairs, 79.4 times
 * this hard limit. The independent stdin-byte guard covers long-path inputs.
 */
export const PROBE_PAIR_BUDGET = Object.freeze({ soft: 100_000, hard: 250_000 });
export const PROBE_ESTIMATED_STDIN_BUDGET = Object.freeze({ soft: 32 << 20, hard: 64 << 20 });

/**
 * Peak query-stdin bytes materialized for ONE `cat-file --batch-check` chunk of
 * the membership probe. This is the WP-M peak-memory bound: the former probe
 * built the ENTIRE (live-checkpoints × members) cross-product as a per-pair
 * `Buffer[]` and collapsed it with a single `Buffer.concat` — the verified OOM
 * allocator that crashed the app twice. The probe now streams the cross-product
 * to git in bounded chunks; at most this many bytes of query stdin (plus its
 * bounded response) are retained at once, and each chunk is parsed and discarded
 * before the next is built. Sized well under `PROBE_ESTIMATED_STDIN_BUDGET` so a
 * streamed probe never trips the estimated-stdin admission guard in production.
 */
export const PROBE_STDIN_CHUNK_BYTES = 1 << 20;

/** Backward-compatible name for the shipped emergency guard. */
export const CHECKPOINT_PROTECTION_MAX_PROBE_PAIRS = PROBE_PAIR_BUDGET.hard;

export type CheckpointProtectionBudgetReason = 'pairs' | 'estimated-stdin' | 'deadline';

/** Thrown BEFORE any cross-product Buffer or `cat-file` spawn exists when the
 *  membership probe would exceed its pair budget. Carries counts only — never
 *  paths or workspace content. `code` is a stable contract for boundaries that
 *  surface the refusal. */
export class CheckpointProtectionBudgetExceededError extends Error {
  readonly code = 'checkpoint-protection-budget-exceeded';
  constructor(
    readonly cardinality: {
      repositoryKey: string | null;
      liveOids: number;
      members: number;
      batchable: number;
      maxPairs: number;
      maxEstimatedStdinBytes: number;
      estimatedStdinBytes: number;
      /** Estimated PEAK retained query-stdin bytes for one streamed probe chunk —
       *  `min(chunk size, whole-corpus estimate)`. This is what the estimated-stdin
       *  admission now gates on (WP-M): streaming bounds peak memory to one chunk,
       *  so `estimatedStdinBytes` (the whole cross-product) is diagnostic only. */
      estimatedPeakChunkBytes: number;
    },
    readonly reasonCodes: readonly CheckpointProtectionBudgetReason[],
  ) {
    super(
      `checkpoint-protection-budget-exceeded: ${reasonCodes.join(',')} for `
      + `${cardinality.liveOids} live checkpoint commits × ${cardinality.batchable} batchable members`,
    );
    this.name = 'CheckpointProtectionBudgetExceededError';
  }
}

export interface EvaluateCheckpointProtectionOptions {
  repoRoot: string;
  members: readonly ProtectionMember[];
  checkpointEdges: readonly ProtectionCheckpointEdge[];
  /** Override for the emergency membership-probe pair ceiling (tests/tuning).
   *  Defaults to CHECKPOINT_PROTECTION_MAX_PROBE_PAIRS. */
  maxMembershipProbePairs?: number;
  /** Test/tuning override for the estimated peak-chunk stdin admission guard. */
  maxEstimatedMembershipProbeStdinBytes?: number;
  /** Test/tuning override for the streamed membership-probe chunk size (peak
   *  retained query-stdin bytes per `cat-file` chunk). Defaults to
   *  PROBE_STDIN_CHUNK_BYTES. */
  maxProbeStdinChunkBytes?: number;
  /** Shared absolute deadline. Defaults once, at evaluator entry, to 5 seconds. */
  deadlineAt?: number;
  finalizations?: readonly PackageFinalization[];
  readRawGitMode?: RawGitModeReader;
  platform?: NodeJS.Platform;
  runGit: LiveEdgeRunGit;
  runGitBytes: RunProtectionGitBytes;
  readCheckpointTree?: CheckpointTreeReader;
  repositoryKey?: string;
  readCommitPathLinks?: CommitPathLinkReader;
  /** undefined resolves HEAD live; null explicitly models an unborn repository. */
  pinnedHeadOid?: string | null;
  readCurrentRepresentation?: CurrentRepresentationReader;
  remoteRefPatterns?: readonly string[];
  gitExe?: string;
}

export type CommitPathLinkReader = (
  repositoryKey: string,
  pathBytesBase64: readonly string[],
) => readonly CommitPathLink[] | Promise<readonly CommitPathLink[]>;

export type CurrentRepresentationReader = (
  options: ReadCurrentCommitRepresentationOptions,
) => Promise<CommitRepresentation>;

export interface MemberProtectionResult {
  entryId: string;
  protection: ProtectionRung;
}

export interface CheckpointProtectionResult {
  members: MemberProtectionResult[];
  weakest: ProtectionRung;
  finalizationCoveredPathBytes: ReadonlySet<string>;
}

export type RawGitModeReader = (
  repoRoot: string,
  member: ProtectionMember,
  platform: NodeJS.Platform,
) => string | null | Promise<string | null>;

const GIT_TIMEOUT_MS = 10_000;
const LS_TREE_MAX_BYTES = 1 << 20;
// One `cat-file --batch-check` streams thousands of records; cap output generously
// (a few MB in practice) so a large live-checkpoint × member cross-product fits.
const CAT_FILE_MAX_BYTES = 256 << 20;
const NUL = 0x00;
const LF = 0x0a;
/** Shared single-byte NUL delimiter for `-z` query stdin, reused across every
 *  chunked pair so the hot loop allocates no per-pair terminator. */
const NUL_DELIMITER = Buffer.from([NUL]);

function seededMode(member: ProtectionMember): string | null {
  if (member.headMode) return member.headMode;
  // Older synthetic callers omit inventory status/head fields; retain their
  // explicit mode as the tracked seed. Production entries always carry both.
  return member.indexStatus === undefined ? member.worktreeMode : null;
}

function readRawGitModeFromWorktree(
  repoRoot: string,
  member: ProtectionMember,
  platform: NodeJS.Platform,
): string | null {
  const seed = seededMode(member);
  if (seed) return seed;
  if (member.expectedWorktreeState === 'absent' || !member.path.utf8Clean) return null;
  const rawPath = Buffer.from(member.path.pathBytesBase64, 'base64');
  const relativePath = rawPath.toString('utf8');
  if (Buffer.compare(Buffer.from(relativePath, 'utf8'), rawPath) !== 0) return null;
  try {
    const stat = fs.lstatSync(path.resolve(repoRoot, relativePath));
    return deriveRawGitMode(null, {
      isFile: stat.isFile(),
      isSymbolicLink: stat.isSymbolicLink(),
      mode: stat.mode,
    }, platform);
  } catch {
    return null;
  }
}

/** True only when a path round-trips losslessly through UTF-8, so it can be sent
 *  as a `:(top,literal)` pathspec. Non-lossless paths can never be safely batched
 *  (mirroring the old per-path reader, which rejected them) and are treated as
 *  unprotected by the evaluator. */
function isLosslessUtf8Path(path: EncodedGitPath): boolean {
  const pathBytes = Buffer.from(path.pathBytesBase64, 'base64');
  return path.utf8Clean
    && Buffer.compare(Buffer.from(pathBytes.toString('utf8'), 'utf8'), pathBytes) === 0;
}

/** A path safe to send as one line of `cat-file --batch-check -z` stdin. The `-z`
 *  input delimiter is NUL, but git still echoes the query verbatim on a "missing"
 *  line terminated by LF, so a path containing LF would desync the output; such
 *  paths fall back to the per-commit `ls-tree` scan. */
function isCatFileSafePath(path: EncodedGitPath): boolean {
  if (!isLosslessUtf8Path(path)) return false;
  return !Buffer.from(path.pathBytesBase64, 'base64').includes(LF);
}

/** Split a git `--batch-check` stdout Buffer into its LF-delimited record lines
 *  (trailing empty dropped), preserving each record's exact bytes. */
function splitBatchCheckLines(stdout: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] === LF) {
      lines.push(stdout.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < stdout.length) lines.push(stdout.subarray(start));
  return lines;
}

/**
 * Read the present-entry tuples for a batch of lossless-UTF-8 paths from one
 * immutable checkpoint commit in a SINGLE `ls-tree` (one spawn covering every
 * path via multiple `:(top,literal)` pathspecs), instead of one spawn per path.
 *
 * Returns a `pathBytesBase64 → {rawBlobOid, mode}` map of the paths present in
 * that tree; a requested path absent from the map is authoritatively absent in
 * the commit. Returns `null` on any Git failure or malformed output, so a broken
 * lookup can never be mistaken for proof that a deletion was captured.
 */
export async function readCheckpointTree(
  options: ReadCheckpointTreeOptions,
): Promise<Map<string, CheckpointTreePresence> | null> {
  const pathspecs: string[] = [];
  for (const path of options.paths) {
    if (!isLosslessUtf8Path(path)) continue;
    const pathText = Buffer.from(path.pathBytesBase64, 'base64').toString('utf8');
    pathspecs.push(`:(top,literal)${pathText}`);
  }
  if (pathspecs.length === 0) return new Map();

  const result = await options.runGitBytes(
    options.repoRoot,
    ['ls-tree', '-z', '--full-tree', options.checkpointOid, '--', ...pathspecs],
    {
      gitExe: options.gitExe,
      deadlineAt: options.deadlineAt,
      allowNonzero: true,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBytes: Math.max(LS_TREE_MAX_BYTES, pathspecs.length * 4096),
    },
  );
  if (result.code !== 0) return null;

  const present = new Map<string, CheckpointTreePresence>();
  const stdout = result.stdout;
  let start = 0;
  for (let i = 0; i <= stdout.length; i++) {
    if (i !== stdout.length && stdout[i] !== 0) continue;
    if (i > start) {
      const record = stdout.subarray(start, i);
      const tab = record.indexOf(0x09);
      if (tab < 0) return null;
      const header = record.subarray(0, tab).toString('ascii').split(' ');
      const recordedPath = record.subarray(tab + 1);
      if (
        header.length !== 3
        || !/^[0-7]{6}$/.test(header[0])
        || !/^[0-9a-f]{40,64}$/.test(header[2])
      ) {
        return null;
      }
      present.set(recordedPath.toString('base64'), {
        rawBlobOid: header[2],
        mode: header[0],
      });
    }
    start = i + 1;
  }
  return present;
}

/**
 * A member's exact {path, expected state, raw blob OID, mode} tuple is recorded in
 * one checkpoint tree iff either: it is present with a matching blob OID and mode,
 * or it is an absence (`absent`/null/null) and the path is absent from the tree.
 */
function memberMatchesTree(
  member: ProtectionMember,
  tree: Map<string, CheckpointTreePresence>,
): boolean {
  const recorded = tree.get(member.path.pathBytesBase64);
  if (member.expectedWorktreeState === 'present') {
    return recorded !== undefined
      && recorded.rawBlobOid === member.rawWorktreeBlobOid
      && recorded.mode === member.worktreeMode;
  }
  return recorded === undefined
    && member.rawWorktreeBlobOid === null
    && member.worktreeMode === null;
}

/**
 * Compute the minimum rung according to the normative order. A real bundle has
 * at least one member; rejecting an empty list avoids inventing a weakest rung.
 */
export function weakestProtectionRung(
  rungs: readonly ProtectionRung[],
): ProtectionRung {
  if (rungs.length === 0) {
    throw new Error('cannot compute protection for an empty bundle');
  }
  return rungs.reduce((weakest, rung) =>
    PROTECTION_RUNG_ORDER[rung] < PROTECTION_RUNG_ORDER[weakest] ? rung : weakest,
  );
}

const OID_RE = /^[0-9a-f]{40,64}$/;

/**
 * Resolve which candidate commits are currently reachable from configured
 * remote-tracking refs. The shape is fixed at two Git processes regardless of
 * candidate count: one ref enumeration and one rev-list traversal.
 */
export async function readRemoteReachableCommitOids(options: {
  repoRoot: string;
  candidateOids: readonly string[];
  runGit: LiveEdgeRunGit;
  gitExe?: string;
  remoteRefPatterns?: readonly string[];
}): Promise<Set<string>> {
  const candidates = new Set(options.candidateOids.filter((oid) => OID_RE.test(oid)));
  if (candidates.size === 0) return new Set();
  const patterns = options.remoteRefPatterns ?? ['refs/remotes'];
  if (patterns.length === 0) return new Set();
  const refs = await options.runGit(
    options.repoRoot,
    ['for-each-ref', '--format=%(refname)', ...patterns],
    { gitExe: options.gitExe, allowNonzero: true, timeoutMs: GIT_TIMEOUT_MS, maxBytes: 16 << 20 },
  );
  if (refs.code !== 0) return new Set();
  const refNames = [...new Set(refs.stdout.split(/\r?\n/).filter((ref) => ref.startsWith('refs/')))];
  if (refNames.length === 0) return new Set();
  const reachable = await options.runGit(
    options.repoRoot,
    ['rev-list', '--stdin'],
    {
      gitExe: options.gitExe,
      allowNonzero: true,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBytes: CAT_FILE_MAX_BYTES,
      stdin: `${refNames.join('\n')}\n`,
    },
  );
  if (reachable.code !== 0) return new Set();
  const result = new Set<string>();
  for (const oid of reachable.stdout.split(/\r?\n/)) {
    if (candidates.has(oid)) result.add(oid);
  }
  return result;
}

async function resolvePinnedHead(options: EvaluateCheckpointProtectionOptions): Promise<string | null> {
  if (options.pinnedHeadOid !== undefined) return options.pinnedHeadOid;
  const result = await options.runGit(
    options.repoRoot,
    ['rev-parse', '--verify', 'HEAD'],
    { gitExe: options.gitExe, allowNonzero: true, timeoutMs: GIT_TIMEOUT_MS, maxBytes: 4096 },
  );
  const oid = result.stdout.trim();
  return result.code === 0 && OID_RE.test(oid) ? oid : null;
}

function commitEntryMatches(
  representation: CommitRepresentation,
  link: CommitPathLink,
): boolean {
  return link.expectedState === representation.expectedState
    && link.commitBlobOid === representation.commitBlobOid
    && link.commitMode === representation.commitMode;
}

/** Exact ledger proof. raw_blob_oid_at_commit is intentionally not consulted. */
async function evaluateCommitLedgerProtection(
  options: EvaluateCheckpointProtectionOptions,
): Promise<Map<string, ProtectionRung>> {
  const result = new Map<string, ProtectionRung>();
  if (!options.repositoryKey || !options.readCommitPathLinks) return result;
  const links = await options.readCommitPathLinks(
    options.repositoryKey,
    options.members.map((member) => member.path.pathBytesBase64),
  );
  if (links.length === 0) return result;
  const linksByPath = new Map<string, CommitPathLink[]>();
  for (const link of links) {
    if (link.repositoryKey !== options.repositoryKey || !OID_RE.test(link.commitOid)) continue;
    const atPath = linksByPath.get(link.pathBytesBase64) ?? [];
    atPath.push(link);
    linksByPath.set(link.pathBytesBase64, atPath);
  }
  if (linksByPath.size === 0) return result;

  const pinnedHeadOid = await resolvePinnedHead(options).catch(() => null);
  const representationReader = options.readCurrentRepresentation ?? readCurrentCommitRepresentation;
  const matchingCommitOidsByEntry = new Map<string, string[]>();
  for (const member of options.members) {
    const atPath = linksByPath.get(member.path.pathBytesBase64);
    if (!atPath || !member.commitPathspecs || member.commitPathspecs.length === 0) continue;
    const representation = await representationReader({
      repoRoot: options.repoRoot,
      pinnedHeadOid,
      entry: {
        path: member.path,
        commitPathspecs: member.commitPathspecs,
        expectedWorktreeState: member.expectedWorktreeState,
        rawWorktreeBlobOid: member.rawWorktreeBlobOid,
      },
      gitExe: options.gitExe,
      runGit: options.runGit,
      runGitBytes: options.runGitBytes,
    }).catch(() => null);
    if (!representation) continue;
    const matching = atPath.filter((link) => commitEntryMatches(representation, link));
    if (matching.length === 0) continue;
    result.set(member.entryId, 'locally-committed');
    matchingCommitOidsByEntry.set(member.entryId, matching.map((link) => link.commitOid));
  }

  const candidateOids = [...new Set([...matchingCommitOidsByEntry.values()].flat())];
  const remote = await readRemoteReachableCommitOids({
    repoRoot: options.repoRoot,
    candidateOids,
    runGit: options.runGit,
    gitExe: options.gitExe,
    remoteRefPatterns: options.remoteRefPatterns,
  }).catch(() => new Set<string>());
  for (const [entryId, commitOids] of matchingCommitOidsByEntry) {
    if (commitOids.some((oid) => remote.has(oid))) result.set(entryId, 'remote-reachable');
  }
  return result;
}

/** One `cat-file --batch-check` record, classified. `present` carries the blob OID
 *  at that `<commit>:<path>`; `absent` means git reported the path missing. */
type MembershipLine =
  | { kind: 'present'; blobOid: string }
  | { kind: 'absent' }
  | { kind: 'other' };

function classifyBatchLine(line: Buffer): MembershipLine {
  // Success: "<objectname> <type> <size>"; miss: "<query> missing" (query echoed
  // verbatim, so parse from the RIGHT). Bytes decoded latin1 to survive path bytes.
  const text = line.toString('latin1');
  if (text.endsWith(' missing')) return { kind: 'absent' };
  const match = /^([0-9a-f]{40,64}) blob [0-9]+$/.exec(text);
  return match ? { kind: 'present', blobOid: match[1] } : { kind: 'other' };
}

/**
 * Phase 1 — resolve, over a STREAM of bounded `cat-file --batch-check -z` chunks,
 * whether each live checkpoint commit records a blob at each member path (and, if
 * so, which blob). Collapses the per-(commit × member) `ls-tree` fan-out —
 * thousands of spawns on a real workspace — while keeping peak memory bounded.
 *
 * WP-M peak-memory fix: the former probe built the ENTIRE (commit × member)
 * cross-product as a per-pair `Buffer[]` and one giant `Buffer.concat` (the
 * verified OOM allocator), then buffered the whole response. It now walks the
 * cross-product lazily, emitting at most `chunkBytes` of query stdin per
 * `cat-file` chunk; each chunk's bounded response is parsed and its buffers
 * discarded before the next chunk is built, so no path ever materializes the full
 * pair corpus. The deadline is honored (and control yielded to the event loop)
 * between chunks. Total work stays O(checkpoints × files); this is the
 * peak-memory fix, not the algorithmic one (§6.3, deferred).
 *
 * Returns, per member entryId: the set of commit OIDs whose tree holds a blob with
 * the member's exact worktree OID at its path (`blobHitOids`, still needing a mode
 * check), and whether ANY live commit records the path as absent (`sawAbsent`).
 * Returns `null` on Git failure or a record-count mismatch in ANY chunk — never
 * absence proof.
 */
async function probeCheckpointMembership(options: {
  repoRoot: string;
  liveOids: readonly string[];
  members: readonly ProtectionMember[];
  runGitBytes: RunProtectionGitBytes;
  gitExe?: string;
  deadlineAt?: number;
  chunkBytes?: number;
}): Promise<Map<string, { blobHitOids: string[]; sawAbsent: boolean }> | null> {
  const { repoRoot, liveOids, members } = options;
  const result = new Map<string, { blobHitOids: string[]; sawAbsent: boolean }>(
    members.map((member) => [member.entryId, { blobHitOids: [], sawAbsent: false }]),
  );
  if (liveOids.length === 0 || members.length === 0) return result;
  const chunkByteLimit = Math.max(1, options.chunkBytes ?? PROBE_STDIN_CHUNK_BYTES);
  const checkDeadline = (): void => {
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
      throw new GitCommandError('deadline', 'Checkpoint membership probe deadline elapsed.', null, '');
    }
  };

  // Each member's path bytes are encoded ONCE and reused across every live commit;
  // a chunk references (never re-copies) them, so only the bounded chunk stdin is
  // materialized at a time.
  const memberPathBytes = members.map((member) => Buffer.from(member.path.pathBytesBase64, 'base64'));

  // A chunk accumulates bounded query stdin plus the ordered (oid, member) each
  // NUL-terminated query maps to (cat-file emits one LF response line per query,
  // in order). Peak retained bytes are one chunk's stdin + its bounded response.
  let chunkParts: Buffer[] = [];
  let chunkQueries: Array<{ oid: string; member: ProtectionMember }> = [];
  let chunkBytes = 0;

  /** Run one bounded chunk. Returns false on a Git failure or a per-chunk
   *  record-count desync — either sinks the whole probe to `null` (no proof). */
  const flushChunk = async (): Promise<boolean> => {
    if (chunkQueries.length === 0) return true;
    checkDeadline();
    const probe = await options.runGitBytes(
      repoRoot,
      ['cat-file', '--batch-check', '-z'],
      {
        gitExe: options.gitExe,
        deadlineAt: options.deadlineAt,
        allowNonzero: true,
        timeoutMs: GIT_TIMEOUT_MS,
        // A response is the OID+type+size (shorter than the query) or the query
        // echoed + " missing"; bound the chunk output to a small multiple of its
        // stdin so a single chunk can never buffer unboundedly either.
        maxBytes: chunkBytes * 2 + (1 << 16),
        stdin: Buffer.concat(chunkParts),
      },
    );
    if (probe.code !== 0) return false;
    const lines = splitBatchCheckLines(probe.stdout);
    if (lines.length !== chunkQueries.length) return false; // desync ⇒ no proof
    for (let i = 0; i < chunkQueries.length; i++) {
      const { oid, member } = chunkQueries[i];
      const entry = result.get(member.entryId)!;
      const classified = classifyBatchLine(lines[i]);
      if (classified.kind === 'present' && classified.blobOid === member.rawWorktreeBlobOid) {
        entry.blobHitOids.push(oid);
      } else if (classified.kind === 'absent') {
        entry.sawAbsent = true;
      }
    }
    // Release this chunk's buffers before building the next: peak stays bounded.
    chunkParts = [];
    chunkQueries = [];
    chunkBytes = 0;
    return true;
  };

  for (const oid of liveOids) {
    checkDeadline();
    const prefix = Buffer.from(`${oid}:`, 'ascii');
    for (let m = 0; m < members.length; m++) {
      chunkParts.push(prefix, memberPathBytes[m], NUL_DELIMITER);
      chunkBytes += prefix.length + memberPathBytes[m].length + 1;
      chunkQueries.push({ oid, member: members[m] });
      if (chunkBytes >= chunkByteLimit) {
        if (!(await flushChunk())) return null;
      }
    }
  }
  if (!(await flushChunk())) return null;
  return result;
}

/**
 * Evaluate Stage-1 protection with request-scoped, batched Git probes. Semantics
 * are unchanged — a member is checkpoint-protected iff its exact {path, expected
 * state, raw blob OID, mode} tuple is recorded in the tree of a live-verified
 * checkpoint edge; read failures degrade to unprotected, never to deletion
 * evidence. Only the Git spawn shape changes:
 *
 *  1. Every DISTINCT edge ref is live-verified in ONE `cat-file --batch-check`
 *     (not one `rev-parse` per edge). Repeated / shared refs collapse to one probe.
 *  2. Path membership across ALL unique live commit OIDs is resolved over a STREAM
 *     of bounded `cat-file --batch-check -z` chunks of the `<commit>:<path>`
 *     cross-product — peak memory is one chunk (PROBE_STDIN_CHUNK_BYTES), never
 *     the whole corpus. An absent record protects a deletion outright; a blob-OID
 *     hit is a candidate.
 *  3. Only candidate hits need their tree entry MODE confirmed, via a small
 *     `ls-tree` pass (grouped by commit, early-exiting once every member resolves).
 *
 * On the real ~840-turn / ~1,600-edge workspace this is a handful of spawns rather
 * than the former thousands.
 */
export async function evaluateCheckpointProtection(
  options: EvaluateCheckpointProtectionOptions,
): Promise<CheckpointProtectionResult> {
  if (options.members.length === 0) {
    throw new Error('cannot evaluate protection for an empty bundle');
  }

  // Derive this once. Every subprocess and every between-chunk check below uses
  // the same absolute instant; no phase receives a fresh five-second allowance.
  const deadlineAt = options.deadlineAt ?? Date.now() + SNAPSHOT_TIME_BUDGET.hardMs;
  const observedReasonCodes: CheckpointProtectionBudgetReason[] = [];
  const observe = (reason: CheckpointProtectionBudgetReason): void => {
    if (!observedReasonCodes.includes(reason)) observedReasonCodes.push(reason);
  };
  const observeDeadlineError = (error: unknown): void => {
    if (error instanceof GitCommandError && error.kind === 'deadline') observe('deadline');
  };
  const deadlineRunGit: LiveEdgeRunGit = async (cwd, args, runOptions): Promise<GitRunResult> => {
    if (Date.now() >= deadlineAt) observe('deadline');
    try {
      return await options.runGit(cwd, args, { ...runOptions, deadlineAt });
    } catch (error) {
      observeDeadlineError(error);
      throw error;
    }
  };
  const deadlineRunGitBytes: RunProtectionGitBytes = async (cwd, args, runOptions) => {
    if (Date.now() >= deadlineAt) observe('deadline');
    try {
      return await options.runGitBytes(cwd, args, { ...runOptions, deadlineAt });
    } catch (error) {
      observeDeadlineError(error);
      throw error;
    }
  };
  const budgetedOptions: EvaluateCheckpointProtectionOptions = {
    ...options,
    deadlineAt,
    runGit: deadlineRunGit,
    runGitBytes: deadlineRunGitBytes,
  };

  const finalizationEdges = (options.finalizations ?? [])
    .filter((row) => row.lifecycleStatus === 'active' && row.boundaryStatus === 'ready')
    .map((row) => ({ ref: row.boundaryRef, oid: row.checkpointOid }));

  // (1) One batched liveness probe for turn checkpoints and finalization boundaries.
  const liveKeys = await verifyLiveEdgesBatch({
    repoRoot: options.repoRoot,
    edges: [...options.checkpointEdges, ...finalizationEdges],
    runGit: deadlineRunGit,
    gitExe: options.gitExe,
  });
  if (Date.now() >= deadlineAt) observe('deadline');

  // Live edges → unique commit OIDs, so an OID shared by many turns' before/after
  // edges is inspected exactly once.
  const liveOids = [...new Set(
    options.checkpointEdges
      .filter(
        (edge): edge is { ref: string; oid: string } =>
          Boolean(edge.ref)
          && Boolean(edge.oid)
          && liveKeys.has(liveEdgeKey(edge.ref!, edge.oid!)),
      )
      .map((edge) => edge.oid),
  )];

  // Admission is intentionally before raw-mode reads or any binary Git call.
  // Compute every currently observable reason before refusing so diagnostics do
  // not hide a simultaneous pair, stdin, or deadline trip.
  const batchableBeforeModeRead = options.members.filter((member) => isCatFileSafePath(member.path));
  const maxPairs = options.maxMembershipProbePairs ?? PROBE_PAIR_BUDGET.hard;
  const maxEstimatedStdinBytes = options.maxEstimatedMembershipProbeStdinBytes
    ?? PROBE_ESTIMATED_STDIN_BUDGET.hard;
  const probeStdinChunkBytes = Math.max(1, options.maxProbeStdinChunkBytes ?? PROBE_STDIN_CHUNK_BYTES);
  const totalPathBytes = batchableBeforeModeRead.reduce(
    (sum, item) => sum + Math.floor((item.path.pathBytesBase64.length * 3) / 4),
    0,
  );
  const estimatedStdinBytes = liveOids.length
    * (totalPathBytes + batchableBeforeModeRead.length * 42);
  // WP-M: the probe now streams the cross-product to git in bounded chunks, so
  // peak retained query-stdin is one chunk, not the whole corpus. The estimated-
  // stdin admission is redefined (deliberation §2 post-WP-M note) to gate on that
  // peak CHUNK memory. For a corpus smaller than a chunk the two coincide — which
  // preserves the shipped estimated-stdin guard exactly; a larger corpus streams,
  // capping its peak at the chunk size.
  const estimatedPeakChunkBytes = Math.min(probeStdinChunkBytes, estimatedStdinBytes);
  const cardinality = {
    repositoryKey: options.repositoryKey ?? null,
    liveOids: liveOids.length,
    members: options.members.length,
    batchable: batchableBeforeModeRead.length,
    maxPairs,
    maxEstimatedStdinBytes,
    estimatedStdinBytes,
    estimatedPeakChunkBytes,
  };
  if (
    batchableBeforeModeRead.length > 0
    && liveOids.length > Math.floor(maxPairs / batchableBeforeModeRead.length)
  ) observe('pairs');
  if (estimatedPeakChunkBytes > maxEstimatedStdinBytes) observe('estimated-stdin');
  if (Date.now() >= deadlineAt) observe('deadline');
  const throwObservedBudget = (): never => {
    const label = observedReasonCodes.includes('pairs')
      ? 'membership-probe pair budget exceeded — refusing'
      : 'membership-probe budget exceeded — refusing';
    console.warn(`[checkpoint-protection] ${label}`, {
      ...cardinality,
      reasonCodes: observedReasonCodes,
    });
    throw new CheckpointProtectionBudgetExceededError(cardinality, [...observedReasonCodes]);
  };
  const checkDeadline = (): void => {
    if (Date.now() >= deadlineAt) {
      observe('deadline');
      throwObservedBudget();
    }
  };
  if (observedReasonCodes.length > 0) throwObservedBudget();

  const reader = options.readCheckpointTree ?? readCheckpointTree;
  const protectedIds = new Set<string>();
  const finalizationCoveredPathBytes = new Set<string>();
  const rawModeReader = options.readRawGitMode ?? readRawGitModeFromWorktree;
  const resolvedMembers: ProtectionMember[] = [];
  for (const member of options.members) {
    checkDeadline();
    try {
      resolvedMembers.push({
        ...member,
        worktreeMode: member.expectedWorktreeState === 'present'
          ? await rawModeReader(options.repoRoot, member, options.platform ?? process.platform)
          : null,
      });
    } catch (error) {
      observeDeadlineError(error);
      if (observedReasonCodes.includes('deadline')) throwObservedBudget();
      throw error;
    }
  }
  checkDeadline();

  // A boundary tree covers the whole repository, but a finalization protects only
  // paths named in its frozen manifest. Require active+ready lifecycle, a live ref
  // resolving to the recorded OID, and the exact raw state/blob/mode tuple.
  const memberByPath = new Map(resolvedMembers.map((member) => [member.path.pathBytesBase64, member]));
  for (const finalization of options.finalizations ?? []) {
    if (
      finalization.lifecycleStatus !== 'active'
      || finalization.boundaryStatus !== 'ready'
      || !finalization.boundaryRef
      || !finalization.checkpointOid
      || (options.repositoryKey && finalization.repositoryKey !== options.repositoryKey)
      || !liveKeys.has(liveEdgeKey(finalization.boundaryRef, finalization.checkpointOid))
    ) continue;
    for (const frozen of parseFinalizationManifest(finalization)) {
      const member = memberByPath.get(frozen.pathBytesBase64);
      if (!member) continue;
      if (
        member.expectedWorktreeState !== frozen.expectedState
        || member.rawWorktreeBlobOid !== frozen.rawBlobOid
        || member.worktreeMode !== frozen.commitMode
      ) continue;
      protectedIds.add(member.entryId);
      finalizationCoveredPathBytes.add(member.path.pathBytesBase64);
    }
  }

  // Non-lossless-UTF-8 paths can never be represented as a literal pathspec, so
  // (mirroring the former per-path reader, which rejected them) they are never
  // batchable and remain unprotected. Paths containing LF can't ride the LF-framed
  // batch-check output either → they take the per-commit ls-tree fallback below.
  const batchable = resolvedMembers.filter((member) => isCatFileSafePath(member.path));
  const lsTreeOnly = resolvedMembers.filter(
    (member) => isLosslessUtf8Path(member.path) && !isCatFileSafePath(member.path),
  );

  if (liveOids.length > 0 && batchable.length > 0) {
    const membership = await probeCheckpointMembership({
      repoRoot: options.repoRoot,
      liveOids,
      members: batchable,
      runGitBytes: deadlineRunGitBytes,
      gitExe: options.gitExe,
      deadlineAt,
      chunkBytes: probeStdinChunkBytes,
    }).catch((error) => {
      observeDeadlineError(error);
      return null;
    }); // a failed batch probe is not protection proof
    if (observedReasonCodes.includes('deadline')) throwObservedBudget();
    checkDeadline();
    if (membership) {
      // Absences are fully resolved by the batch — a deletion is protected the
      // moment any live commit records its path as absent.
      const modeCandidates: ProtectionMember[] = [];
      for (const member of batchable) {
        const hit = membership.get(member.entryId)!;
        if (member.expectedWorktreeState === 'absent') {
          if (hit.sawAbsent && member.rawWorktreeBlobOid === null && member.worktreeMode === null) {
            protectedIds.add(member.entryId);
          }
        } else if (member.worktreeMode !== null && hit.blobHitOids.length > 0) {
          // A present member with no worktree mode (e.g. an untracked file, which
          // `git status` reports without a mode) can never equal a checkpoint tree
          // entry's always-present mode, so it is never protected — skip the futile
          // mode-confirm scan across its (often hundreds of) blob-hit commits.
          modeCandidates.push(member);
        }
      }

      // (3) Confirm the tree-entry MODE for blob-OID hits with a GREEDY set cover.
      // A file dirty-unchanged for many turns has its blob in hundreds of live
      // checkpoints, so its candidate-OID set is huge — but its mode is one value,
      // and a single recent checkpoint typically records ALL such members at once.
      // Each round ls-trees the ONE commit covering the most still-pending members;
      // mode mismatches drop that commit from the member's set and retry. This
      // bounds the mode-confirm pass to a handful of spawns instead of one per hit.
      const pendingOids = new Map<string, Set<string>>(
        modeCandidates.map((member) => [
          member.entryId,
          new Set(membership.get(member.entryId)!.blobHitOids),
        ]),
      );
      const byEntryId = new Map(modeCandidates.map((member) => [member.entryId, member]));
      while (pendingOids.size > 0) {
        checkDeadline();
        const coverage = new Map<string, number>();
        for (const oids of pendingOids.values()) {
          for (const oid of oids) coverage.set(oid, (coverage.get(oid) ?? 0) + 1);
        }
        if (coverage.size === 0) break; // remaining candidates have no commit left to try
        let bestOid = '';
        let best = -1;
        for (const [oid, count] of coverage) {
          if (count > best) { best = count; bestOid = oid; }
        }
        const here = [...pendingOids.keys()].filter((id) => pendingOids.get(id)!.has(bestOid));
        const tree = await reader({
          repoRoot: options.repoRoot,
          checkpointOid: bestOid,
          paths: here.map((id) => byEntryId.get(id)!.path),
          runGitBytes: deadlineRunGitBytes,
          gitExe: options.gitExe,
          deadlineAt,
        }).catch((error) => {
          observeDeadlineError(error);
          return null;
        });
        if (observedReasonCodes.includes('deadline')) throwObservedBudget();
        for (const id of here) {
          if (tree && memberMatchesTree(byEntryId.get(id)!, tree)) {
            protectedIds.add(id);
            pendingOids.delete(id); // confirmed
          } else {
            // Not proven at bestOid (mode mismatch, or a failed read): never retry
            // this commit for this member; fall through to its remaining commits.
            const remaining = pendingOids.get(id)!;
            remaining.delete(bestOid);
            if (remaining.size === 0) pendingOids.delete(id); // exhausted ⇒ unprotected
          }
        }
      }
    }
  }

  // Fallback for the rare LF-in-path members: scan the unique live commits with a
  // per-commit ls-tree, early-exiting once each resolves. Preserves exact semantics
  // for paths the batch-check line framing cannot carry.
  if (liveOids.length > 0 && lsTreeOnly.length > 0) {
    const pending = new Set(lsTreeOnly.map((member) => member.entryId));
    for (const checkpointOid of liveOids) {
      if (pending.size === 0) break;
      checkDeadline();
      const tree = await reader({
        repoRoot: options.repoRoot,
        checkpointOid,
        paths: lsTreeOnly.map((member) => member.path),
        runGitBytes: deadlineRunGitBytes,
        gitExe: options.gitExe,
        deadlineAt,
      }).catch((error) => {
        observeDeadlineError(error);
        return null;
      });
      if (observedReasonCodes.includes('deadline')) throwObservedBudget();
      if (!tree) continue;
      for (const member of lsTreeOnly) {
        if (pending.has(member.entryId) && memberMatchesTree(member, tree)) {
          protectedIds.add(member.entryId);
          pending.delete(member.entryId);
        }
      }
    }
  }

  // Ledger/database and temporary-index failures degrade to checkpoint evidence;
  // they never erase a proven live checkpoint rung or invent local protection.
  checkDeadline();
  const ledgerProtection = await evaluateCommitLedgerProtection(budgetedOptions).catch(
    (error) => {
      observeDeadlineError(error);
      return new Map<string, ProtectionRung>();
    },
  );
  if (observedReasonCodes.includes('deadline')) throwObservedBudget();
  checkDeadline();
  const members: MemberProtectionResult[] = resolvedMembers.map((member) => ({
    entryId: member.entryId,
    protection: ledgerProtection.get(member.entryId)
      ?? (protectedIds.has(member.entryId) ? 'checkpoint-protected' : 'unprotected'),
  }));

  return {
    members,
    weakest: weakestProtectionRung(members.map((member) => member.protection)),
    finalizationCoveredPathBytes,
  };
}
