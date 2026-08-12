// SC-WP-1B — DirtyInventory producer (bundle contract v1 §2). MAIN-PROCESS ONLY.
//
// Turns the raw, scoped worktree dirt of ONE repository into a list of
// `DirtyEntry` records + the `RepositoryIdentity` they belong to. This is the
// "raw half" of the inventory: it does NOT compute witness attribution, topology,
// `unattributedEntryIds`, or `topologyDigest` (all WP-1D), and it does NOT compute
// `expectedCommitBlobOid` (needs a temp index; a later WP). It returns an honest
// PARTIAL — `{ repository, entries }` — never a faked `DirtyInventory`.
//
// Source of truth (normative §2):
//   git status --porcelain=v2 -z --untracked-files=no, then
//   git ls-files --others --exclude-standard -z
// Both are streamed so authoritative Git path bytes survive without buffering
// the full output. Records are split on NUL BYTES; `pathBytesBase64` is the
// authoritative transport form; `displayPath`/`utf8Clean` are derived AFTER and
// are DISPLAY-ONLY (control chars escaped; a lossy UTF-8 decode ⇒ utf8Clean:false).
//
// Scope (normative): `enumerationPathspec(workspacePrefix)` + `--exclude-standard`
// semantics ONLY (status without `--ignored` already excludes ignored files).
// We deliberately do NOT call `enumerateScope()` — it string-decodes paths, applies
// capture path/byte caps, and lstats, and can report `oversized` for an inventory
// the card must still render. This producer matches raw scoped `git status` even
// when checkpoint capture would report `oversized`.
//
// Everything that shells out routes through injected seams (`runGitBytes` for the
// authoritative status bytes + batched raw-path hashing; text `runGit` for the
// ascii-only per-entry hash fallback), so unit tests drive it with either a real
// git in a throwaway temp repo or crafted byte fixtures (the only way to exercise
// non-UTF-8 paths on Windows).

import { createHash } from 'crypto';
import { spawn } from 'child_process';

import { enumerationPathspec } from '../git-checkpoints/checkpoint-gating';
import { GitCommandError } from '../git-checkpoints/git-command';
import type { GitRunBytesResult, GitRunResult, RunGitOptions } from '../git-checkpoints/git-command';
import { buildGitEnv, resolveInternalGit } from '../git/git-runtime';
import type { DirtyEntry, EncodedGitPath, RepositoryIdentity } from '../../shared/commit-candidates';

/** Injectable binary git seam — structurally `git-command.runGitBytes`. */
export type RunGitBytesLike = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunBytesResult>;
/** Injectable text git seam — structurally `git-command.runGit` (ascii output only). */
export type RunGitTextLike = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunResult>;

export interface GitStreamResult {
  code: number;
  stderr: string;
  stoppedEarly: boolean;
}

/** Injectable streaming Git seam. Returning false from `onStdout` stops the
 * child and, critically, prevents any later stdout chunk from being pulled. */
export type RunGitStreamLike = (
  cwd: string,
  args: string[],
  opts: RunGitOptions,
  onStdout: (chunk: Buffer) => boolean,
) => Promise<GitStreamResult>;

export interface ProduceDirtyInventoryOptions {
  /** Repo-root cwd for git; status paths come back repo-root-relative. */
  repoRoot: string;
  /** Top-anchored POSIX workspace prefix ('' ⇒ whole repo, no pathspec). */
  workspacePrefix: string;
  /** The already-derived identity (WP-1A); embedded verbatim + supplies `repositoryKey`. */
  repository: RepositoryIdentity;
  runGitBytes: RunGitBytesLike;
  runGit: RunGitTextLike;
  runGitStream?: RunGitStreamLike;
  gitExe?: string;
  deadlineAt?: number;
  timeBudgetMs?: number;
  /** Status-byte hard cap. Retained for compatibility; status is not buffered. */
  maxBytes?: number;
  /** WP-A test seam; WP-B replaces this with its named entry budget. */
  maxEntries?: number;
  /** WP-A test seam; WP-B replaces this with its named path-byte budget. */
  maxPathBytes?: number;
}

export type DirtyBudgetReason = 'entries' | 'status-bytes' | 'path-bytes' | 'deadline';

/** The producer's honest partial of `DirtyInventory`. `unattributedEntryIds` and
 *  `topologyDigest` are deliberately ABSENT — the WP-1D assembler owns them; we
 *  never fabricate them. */
export interface DirtyInventoryDraft {
  repository: RepositoryIdentity;
  entries: DirtyEntry[];
}

/** The bounded producer's typed result. `DirtyInventoryDraft` remains the
 * assembler input shape so existing non-producing fixtures need not fabricate
 * completeness evidence. */
export interface DirtyInventoryResult extends DirtyInventoryDraft {
  completeness: 'complete' | 'partial';
  observedStopReasons: DirtyBudgetReason[];
  observedEntries: number;
  observedStatusBytes: number;
  observedPathBytes: number;
  totalsExact: boolean;
}

/** Approved dirty-corpus budgets. Soft limits are presentation/telemetry signals
 * only; this producer enforces only the hard limits. */
export const DIRTY_ENTRY_BUDGET = Object.freeze({ soft: 5_000, hard: 10_000 });
export const STATUS_OUTPUT_BYTE_BUDGET = Object.freeze({ hard: 64 << 20 });
export const PATH_BYTES_BUDGET = Object.freeze({ hard: 16 << 20 });
export const SNAPSHOT_TIME_BUDGET = Object.freeze({ softMs: 2_000, hardMs: 12_000 });
const STATUS_TIMEOUT_MS = 30_000;

// ── Path encoding (§2: bytes authoritative; display derived after) ─────────────

// Control chars (C0 + DEL) that must be escaped for DISPLAY. Kept as a codepoint
// test so the source carries no literal control bytes.
function isControlChar(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

/** C-style escape of control chars for DISPLAY ONLY — never fed back to git. */
function escapeForDisplay(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (!isControlChar(code)) {
      out += ch;
      continue;
    }
    if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += `\\x${code.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/** Encode raw Git path bytes into an `EncodedGitPath`. `pathBytesBase64` is
 *  authoritative; `utf8Clean` is a lossless round-trip test; `displayPath` is a
 *  best-effort, control-char-escaped rendering. */
export function encodeGitPath(pathBytes: Buffer): EncodedGitPath {
  const decoded = pathBytes.toString('utf8');
  const utf8Clean = Buffer.compare(Buffer.from(decoded, 'utf8'), pathBytes) === 0;
  return {
    pathBytesBase64: pathBytes.toString('base64'),
    displayPath: escapeForDisplay(decoded),
    utf8Clean,
  };
}

/**
 * Encode one raw path for `hash-object --stdin-paths`.
 *
 * Git reads one line at a time and C-unquotes any line beginning with `"`.
 * Ordinary paths can therefore pass through byte-for-byte, but paths containing
 * a line terminator or beginning with `"` must use Git's C-style quoted form.
 * Quoted non-printable/high bytes use three-digit octal so arbitrary path bytes
 * (including non-UTF-8) survive `unquote_c_style` exactly.
 */
export function encodeHashObjectStdinPathLine(pathBytes: Buffer): Buffer {
  const mustQuote =
    pathBytes.includes(0x0a) ||
    pathBytes.includes(0x0d) ||
    pathBytes[0] === 0x22;

  if (!mustQuote) return Buffer.concat([pathBytes, Buffer.from([0x0a])]);

  const encoded: number[] = [0x22];
  for (const byte of pathBytes) {
    if (byte === 0x5c || byte === 0x22) {
      encoded.push(0x5c, byte);
    } else if (byte < 0x20 || byte >= 0x7f) {
      const octal = byte.toString(8).padStart(3, '0');
      encoded.push(0x5c, octal.charCodeAt(0), octal.charCodeAt(1), octal.charCodeAt(2));
    } else {
      encoded.push(byte);
    }
  }
  encoded.push(0x22, 0x0a);
  return Buffer.from(encoded);
}

// ── porcelain=v2 -z parsing (byte-exact) ───────────────────────────────────────

/** Split a Buffer on NUL bytes, preserving each segment's exact bytes. Empty
 *  trailing segments are dropped; interior empties (never produced by porcelain)
 *  are kept and skipped by the caller. */
function splitNulBytes(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      out.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
}

/**
 * Split a porcelain-v2 record token into its ASCII header fields and the raw path
 * bytes. `fieldCount` = number of space-separated header fields BEFORE the path
 * (8 for type-1, 9 for type-2, 10 for type-u, 1 for type-`?`). The header is pure
 * ASCII (status chars, octal modes, hex OIDs, `N...`/`S...` sub); only the path can
 * carry arbitrary bytes, so it is sliced out as a Buffer and never decoded here.
 */
function splitHeaderAndPath(token: Buffer, fieldCount: number): { fields: string[]; pathBytes: Buffer } {
  let spaces = 0;
  let idx = 0;
  for (; idx < token.length; idx++) {
    if (token[idx] === 0x20) {
      spaces++;
      if (spaces === fieldCount) {
        idx++;
        break;
      }
    }
  }
  const fields = token.subarray(0, Math.max(0, idx - 1)).toString('latin1').split(' ');
  const pathBytes = token.subarray(idx);
  return { fields, pathBytes };
}

/** '000000' is git's "no entry at this level" sentinel — surfaced as null so the
 *  stored modes match the §2 enumerated set (`100644|100755|120000|160000|null`). */
function normalizeMode(raw: string | undefined): string | null {
  return raw && raw !== '000000' ? raw : null;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Production streaming implementation kept local to WP-A so the existing
 * buffered `runGitBytes` contract does not need to change. */
async function runGitStreaming(
  cwd: string,
  args: string[],
  opts: RunGitOptions,
  onStdout: (chunk: Buffer) => boolean,
): Promise<GitStreamResult> {
  const resolved = opts.gitExe ? { execPath: opts.gitExe } : await resolveInternalGit();
  if (!resolved) throw new GitCommandError('spawn', 'No compatible git is available.', null, '');
  const now = Date.now();
  if (opts.deadlineAt !== undefined && opts.deadlineAt <= now) {
    throw new GitCommandError('deadline', 'Deadline already elapsed before spawn.', null, '');
  }
  const timeoutMs = Math.min(
    opts.timeoutMs ?? Number.POSITIVE_INFINITY,
    opts.deadlineAt === undefined ? Number.POSITIVE_INFINITY : opts.deadlineAt - now,
  );

  return new Promise<GitStreamResult>((resolve, reject) => {
    let stderr = '';
    let stoppedEarly = false;
    let timedOut = false;
    let settled = false;
    const child = spawn(resolved.execPath, args, {
      cwd,
      env: buildGitEnv(opts.env ?? process.env, { mode: opts.mode ?? 'read' }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = Number.isFinite(timeoutMs)
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Math.max(0, timeoutMs))
      : null;
    timer?.unref?.();
    child.stdout.on('data', (raw: Buffer | string) => {
      if (stoppedEarly) return;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (!onStdout(chunk)) {
        stoppedEarly = true;
        child.stdout.pause();
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (raw: Buffer | string) => {
      stderr = (stderr + (Buffer.isBuffer(raw) ? raw.toString('utf8') : raw)).slice(-4096);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new GitCommandError('spawn', `git failed to run: ${error.message}`, null, stderr));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (stoppedEarly) resolve({ code: code ?? 0, stderr, stoppedEarly: true });
      else if (timedOut) {
        const deadlineWon = opts.deadlineAt !== undefined
          && opts.deadlineAt - now <= (opts.timeoutMs ?? Number.POSITIVE_INFINITY);
        const kind = deadlineWon ? 'deadline' : 'timeout';
        reject(new GitCommandError(kind, `git ${args[0] ?? ''} exceeded its ${kind}.`, null, stderr));
      } else if (code === 0 || opts.allowNonzero) resolve({ code: code ?? 0, stderr, stoppedEarly: false });
      else reject(new GitCommandError('nonzero', `git ${args[0] ?? ''} exited ${code}.`, code, stderr));
    });
  });
}

/** GIT-LEVEL eligibility ONLY (no package/byte verdicts here): unmerged, gitlink
 *  (`160000`) / submodule (`S...`), and non-UTF-8 paths are visible but never
 *  eligible. Symlinks (`120000`) ARE supported. */
function computeEligibility(
  entryKind: DirtyEntry['entryKind'],
  rawModes: (string | null)[],
  submoduleState: string | null,
  utf8Clean: boolean,
): DirtyEntry['gitLevelEligibility'] {
  if (!utf8Clean) return 'unsupported-git-state';
  if (entryKind === 'unmerged') return 'unsupported-git-state';
  if (rawModes.some((m) => m === '160000')) return 'unsupported-git-state';
  if (submoduleState && submoduleState.startsWith('S')) return 'unsupported-git-state';
  return 'supported';
}

/** Intermediate parse result before the (async) raw-hash pass. */
interface ParsedEntry {
  entry: DirtyEntry;
  /** Authoritative repo-relative path bytes for hash-object. Absent worktree
   *  entries alone are omitted; non-UTF-8 paths remain hashable. */
  hashPathBytes: Buffer | null;
}

export interface BatchHashEntry {
  /** Null means the worktree entry is absent and must never be sent to Git. */
  hashPathBytes: Buffer | null;
}

export interface HashEntriesBatchedOptions {
  repoRoot: string;
  entries: readonly BatchHashEntry[];
  runGitBytes: RunGitBytesLike;
  runGit: RunGitTextLike;
  gitExe?: string;
  deadlineAt: number;
}

function parseHashObjectOids(stdout: Buffer | string, expected: number): string[] | null {
  const lines = (Buffer.isBuffer(stdout) ? stdout.toString('ascii') : stdout).split('\n');
  if (lines.at(-1) === '') lines.pop();
  const oids = lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
  return oids.length === expected && oids.every((oid) => /^[0-9a-f]{40,64}$/.test(oid))
    ? oids
    : null;
}

/** Hash present entries in resilient batches while preserving input alignment. */
export async function hashEntriesBatched(opts: HashEntriesBatchedOptions): Promise<Array<string | null>> {
  const results: Array<string | null> = opts.entries.map(() => null);
  const present = opts.entries
    .map((entry, index) => ({ index, hashPathBytes: entry.hashPathBytes }))
    .filter((entry): entry is { index: number; hashPathBytes: Buffer } => entry.hashPathBytes !== null);
  const hashArgs = ['hash-object', '--no-filters', '--stdin-paths'];

  const hashBatch = async (batch: typeof present, retrySingleton = false): Promise<void> => {
    if (batch.length === 0) return;
    if (Date.now() >= opts.deadlineAt) {
      throw new GitCommandError('deadline', 'dirty inventory hash deadline exceeded', null, '');
    }

    let oids: string[] | null = null;
    try {
      const runOptions: RunGitOptions = {
        maxBytes: Math.max(4096, batch.length * 66),
        gitExe: opts.gitExe,
        deadlineAt: opts.deadlineAt,
        timeoutMs: STATUS_TIMEOUT_MS,
        allowNonzero: true,
        stdin: Buffer.concat(batch.map((entry) => encodeHashObjectStdinPathLine(entry.hashPathBytes))),
      };
      const res = retrySingleton && batch.length === 1
        ? await opts.runGit(opts.repoRoot, hashArgs, runOptions)
        : await opts.runGitBytes(opts.repoRoot, hashArgs, runOptions);
      if (res.code === 0) oids = parseHashObjectOids(res.stdout, batch.length);
    } catch (error) {
      if (error instanceof GitCommandError && error.kind === 'deadline') throw error;
      // An ordinary execution failure is isolated in the same way as a nonzero
      // or malformed response so independently hashable siblings are retained.
    }

    if (oids) {
      batch.forEach((entry, offset) => {
        results[entry.index] = oids![offset];
      });
      return;
    }
    if (batch.length === 1) return;

    const midpoint = Math.floor(batch.length / 2);
    await hashBatch(batch.slice(0, midpoint), true);
    await hashBatch(batch.slice(midpoint), true);
  };

  await hashBatch(present);
  return results;
}

function buildEntry(args: {
  repositoryKey: string;
  entryKind: DirtyEntry['entryKind'];
  indexStatus: string;
  worktreeStatus: string;
  headModeRaw: string | undefined;
  indexModeRaw: string | undefined;
  worktreeModeRaw: string | undefined;
  submoduleState: string | null;
  renameOrCopyScore: string | null;
  pathBytes: Buffer;
  originalPathBytes: Buffer | null;
}): ParsedEntry {
  const path = encodeGitPath(args.pathBytes);
  const originalPath = args.originalPathBytes ? encodeGitPath(args.originalPathBytes) : null;

  // Deletion is decided from the RAW worktree mode ('000000') BEFORE normalization,
  // so 'absent' stays distinct from an unavailable hash (§2).
  const expectedWorktreeState: DirtyEntry['expectedWorktreeState'] =
    args.worktreeModeRaw === '000000' ? 'absent' : 'present';

  const headMode = normalizeMode(args.headModeRaw);
  const indexMode = normalizeMode(args.indexModeRaw);
  const worktreeMode = normalizeMode(args.worktreeModeRaw);

  const gitLevelEligibility = computeEligibility(
    args.entryKind,
    [args.headModeRaw ?? null, args.indexModeRaw ?? null, args.worktreeModeRaw ?? null],
    args.submoduleState,
    path.utf8Clean,
  );

  // Every old/new path a rename/delete/copy commit needs (§2): the path always,
  // plus the rename/copy source when present.
  const commitPathspecs: EncodedGitPath[] = [path];
  if (originalPath) commitPathspecs.push(originalPath);

  const entry: DirtyEntry = {
    entryId: sha256Hex(args.repositoryKey + path.pathBytesBase64),
    path,
    originalPath,
    entryKind: args.entryKind,
    indexStatus: args.indexStatus,
    worktreeStatus: args.worktreeStatus,
    headMode,
    indexMode,
    worktreeMode,
    submoduleState: args.submoduleState,
    renameOrCopyScore: args.renameOrCopyScore,
    expectedWorktreeState,
    rawWorktreeBlobOid: null, // filled by the raw-hash pass below
    gitLevelEligibility,
    commitPathspecs,
  };

  // `--stdin-paths` accepts authoritative bytes, so every present path is
  // hashable regardless of whether it round-trips through UTF-8.
  const hashPathBytes = expectedWorktreeState === 'present' ? args.pathBytes : null;

  return { entry, hashPathBytes };
}

/** Parse the tokens for one already-bounded tracked record (sync; no hashing). */
function parseBoundedTrackedRecordTokens(stdout: Buffer, repositoryKey: string): ParsedEntry[] {
  const tokens = splitNulBytes(stdout);
  const parsed: ParsedEntry[] = [];

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.length === 0) { i++; continue; }
    const kind = tok[0];

    if (kind === 0x31) {
      // '1' ordinary: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const { fields, pathBytes } = splitHeaderAndPath(tok, 8);
      const xy = fields[1] ?? '..';
      parsed.push(buildEntry({
        repositoryKey,
        entryKind: 'ordinary',
        indexStatus: xy[0] ?? '.',
        worktreeStatus: xy[1] ?? '.',
        submoduleState: fields[2] ?? null,
        headModeRaw: fields[3],
        indexModeRaw: fields[4],
        worktreeModeRaw: fields[5],
        renameOrCopyScore: null,
        pathBytes,
        originalPathBytes: null,
      }));
      i += 1;
    } else if (kind === 0x32) {
      // '2' rename/copy: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>
      const { fields, pathBytes } = splitHeaderAndPath(tok, 9);
      const originalPathBytes = tokens[i + 1] ?? Buffer.alloc(0);
      const xy = fields[1] ?? '..';
      const xscore = fields[8] ?? '';
      parsed.push(buildEntry({
        repositoryKey,
        entryKind: 'rename-or-copy',
        indexStatus: xy[0] ?? '.',
        worktreeStatus: xy[1] ?? '.',
        submoduleState: fields[2] ?? null,
        headModeRaw: fields[3],
        indexModeRaw: fields[4],
        worktreeModeRaw: fields[5],
        renameOrCopyScore: xscore.slice(1) || null,
        pathBytes,
        originalPathBytes,
      }));
      i += 2; // consume the origPath token
    } else if (kind === 0x75) {
      // 'u' unmerged: u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const { fields, pathBytes } = splitHeaderAndPath(tok, 10);
      const xy = fields[1] ?? '..';
      parsed.push(buildEntry({
        repositoryKey,
        entryKind: 'unmerged',
        indexStatus: xy[0] ?? '.',
        worktreeStatus: xy[1] ?? '.',
        submoduleState: fields[2] ?? null,
        // Three merge stages (base/ours/theirs) don't map onto head/index; only the
        // worktree mode is meaningful. Unmerged is unsupported-git-state regardless.
        headModeRaw: undefined,
        indexModeRaw: undefined,
        worktreeModeRaw: fields[6],
        renameOrCopyScore: null,
        pathBytes,
        originalPathBytes: null,
      }));
      i += 1;
    } else if (kind === 0x3f) {
      // '?' untracked: ? <path>   (no modes/sub reported by git)
      const { pathBytes } = splitHeaderAndPath(tok, 1);
      parsed.push(buildEntry({
        repositoryKey,
        entryKind: 'untracked',
        indexStatus: '?',
        worktreeStatus: '?',
        submoduleState: null,
        headModeRaw: undefined,
        indexModeRaw: undefined,
        worktreeModeRaw: undefined,
        renameOrCopyScore: null,
        pathBytes,
        originalPathBytes: null,
      }));
      i += 1;
    } else {
      // '!' ignored (never emitted without --ignored) or an unknown line → skip
      // defensively so junk never chokes the producer.
      i += 1;
    }
  }

  return parsed;
}

/** Parse a single tracked porcelain-v2 record. Rename/copy records receive their
 * second NUL token separately. */
function parseTrackedRecord(token: Buffer, repositoryKey: string, originalPathBytes?: Buffer): ParsedEntry | null {
  const combined = originalPathBytes === undefined
    ? Buffer.concat([token, Buffer.from([0])])
    : Buffer.concat([token, Buffer.from([0]), originalPathBytes, Buffer.from([0])]);
  return parseBoundedTrackedRecordTokens(combined, repositoryKey)[0] ?? null;
}

function parseUntrackedRecord(pathBytes: Buffer, repositoryKey: string): ParsedEntry | null {
  if (pathBytes.length === 0) return null;
  return buildEntry({
    repositoryKey,
    entryKind: 'untracked',
    indexStatus: '?',
    worktreeStatus: '?',
    headModeRaw: undefined,
    indexModeRaw: undefined,
    worktreeModeRaw: undefined,
    submoduleState: null,
    renameOrCopyScore: null,
    pathBytes,
    originalPathBytes: null,
  });
}

/**
 * Produce the raw-half `DirtyInventory` for one repository, scoped to one
 * workspace prefix. Returns `{ repository, entries }` — the WP-1D assembler adds
 * `unattributedEntryIds` + `topologyDigest`.
 */
export async function produceDirtyInventory(opts: ProduceDirtyInventoryOptions): Promise<DirtyInventoryResult> {
  const { repoRoot, workspacePrefix, repository, runGitBytes, runGit, gitExe } = opts;
  const maxBytes = opts.maxBytes ?? STATUS_OUTPUT_BYTE_BUDGET.hard;
  const maxEntries = opts.maxEntries ?? DIRTY_ENTRY_BUDGET.hard;
  const maxPathBytes = opts.maxPathBytes ?? PATH_BYTES_BUDGET.hard;
  const deadlineAt = opts.deadlineAt ?? Date.now() + (opts.timeBudgetMs ?? SNAPSHOT_TIME_BUDGET.hardMs);
  const runStream = opts.runGitStream ?? runGitStreaming;

  // §2 source command. `--no-optional-locks` avoids touching index.lock on a
  // read; NOT passing `--ignored` gives `--exclude-standard` semantics (ignored
  // files never appear). Scope via the workspace pathspec ONLY.
  const pathspec = enumerationPathspec(workspacePrefix);
  const scopedArgs = (args: string[]): string[] => pathspec === null ? [...args, '--'] : [...args, '--', pathspec];
  const parsed: ParsedEntry[] = [];
  const observedStopReasons: DirtyBudgetReason[] = [];
  let observedEntries = 0;
  let observedStatusBytes = 0;
  let observedPathBytes = 0;

  const stop = (reason: DirtyBudgetReason): false => {
    if (!observedStopReasons.includes(reason)) observedStopReasons.push(reason);
    return false;
  };
  const admit = (candidate: ParsedEntry | null): boolean => {
    if (!candidate) return true;
    observedEntries++;
    const candidatePathBytes = Buffer.from(candidate.entry.path.pathBytesBase64, 'base64').length
      + (candidate.entry.originalPath ? Buffer.from(candidate.entry.originalPath.pathBytesBase64, 'base64').length : 0);
    observedPathBytes += candidatePathBytes;
    const withinEntryBudget = observedEntries <= maxEntries;
    const withinPathBudget = observedPathBytes <= maxPathBytes;
    if (!withinEntryBudget) stop('entries');
    if (!withinPathBudget) stop('path-bytes');
    if (withinEntryBudget && withinPathBudget && observedStopReasons.length === 0) parsed.push(candidate);
    return withinEntryBudget && withinPathBudget;
  };

  const readPhase = async (phase: 'tracked' | 'untracked', args: string[]): Promise<void> => {
    let tokenParts: Buffer[] = [];
    let tokenLength = 0;
    let pendingRename: Buffer | null = null;
    const consume = (data: Buffer): boolean => {
      let offset = 0;
      let withinBudgets = true;
      while (offset < data.length) {
        if (Date.now() >= deadlineAt) {
          stop('deadline');
          withinBudgets = false;
        }
        const nul = data.indexOf(0, offset);
        if (nul < 0) {
          tokenParts.push(data.subarray(offset));
          tokenLength += data.length - offset;
          return withinBudgets;
        }
        tokenParts.push(data.subarray(offset, nul));
        tokenLength += nul - offset;
        const token = Buffer.concat(tokenParts, tokenLength);
        tokenParts = [];
        tokenLength = 0;
        offset = nul + 1;
        let candidate: ParsedEntry | null = null;
        if (phase === 'untracked') candidate = parseUntrackedRecord(token, repository.repositoryKey);
        else if (pendingRename) {
          candidate = parseTrackedRecord(pendingRename, repository.repositoryKey, token);
          pendingRename = null;
        } else if (token[0] === 0x32) {
          pendingRename = Buffer.from(token);
          continue;
        } else candidate = parseTrackedRecord(token, repository.repositoryKey);
        if (!admit(candidate)) withinBudgets = false;
      }
      return withinBudgets;
    };

    try {
      await runStream(repoRoot, scopedArgs(args), {
        maxBytes,
        gitExe,
        deadlineAt,
        timeoutMs: STATUS_TIMEOUT_MS,
      }, (chunk) => {
        let withinBudgets = true;
        if (Date.now() >= deadlineAt) {
          stop('deadline');
          withinBudgets = false;
        }
        const remaining = maxBytes - observedStatusBytes;
        if (chunk.length > remaining) {
          const withinBudget = remaining > 0 ? chunk.subarray(0, remaining) : Buffer.alloc(0);
          observedStatusBytes = maxBytes + 1;
          if (withinBudget.length > 0 && !consume(withinBudget)) withinBudgets = false;
          stop('status-bytes');
          return false;
        }
        observedStatusBytes += chunk.length;
        if (!consume(chunk)) withinBudgets = false;
        return withinBudgets && observedStopReasons.length === 0;
      });
    } catch (error) {
      if (error instanceof GitCommandError && error.kind === 'deadline') {
        stop('deadline');
        return;
      }
      throw error;
    }
  };

  await readPhase('tracked', ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=no']);
  if (observedStopReasons.length === 0) {
    await readPhase('untracked', ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z']);
  }

  if (parsed.some((entry) => entry.hashPathBytes !== null) && observedStopReasons.length === 0) {
    try {
      const hashOids = await hashEntriesBatched({
        repoRoot,
        entries: parsed,
        runGitBytes,
        runGit,
        gitExe,
        deadlineAt,
      });
      parsed.forEach((entry, index) => {
        entry.entry.rawWorktreeBlobOid = hashOids[index];
      });
    } catch (error) {
      if (error instanceof GitCommandError && error.kind === 'deadline') stop('deadline');
      else throw error;
    }
  }

  // Deterministic order by authoritative bytes (identity is per-entry regardless).
  const entries = parsed.map((p) => p.entry).sort((a, b) =>
    a.path.pathBytesBase64 < b.path.pathBytesBase64 ? -1 : a.path.pathBytesBase64 > b.path.pathBytesBase64 ? 1 : 0,
  );

  const completeness = observedStopReasons.length === 0 ? 'complete' : 'partial';
  return {
    repository,
    entries,
    completeness,
    observedStopReasons,
    observedEntries,
    observedStatusBytes,
    observedPathBytes,
    totalsExact: completeness === 'complete',
  };
}
