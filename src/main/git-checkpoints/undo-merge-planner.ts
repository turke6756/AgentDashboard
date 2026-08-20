// Read-only planner for inverse, path-isolated checkpoint merges.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  runGit as realRunGit,
  runGitBytes as realRunGitBytes,
  type GitRunBytesResult,
  type GitRunResult,
  type RunGitOptions,
} from './git-command';
import {
  runMergeTreeCore as realRunMergeTreeCore,
  type MergeTreeCoreDeps,
  type MergeTreeCoreResult,
  type MergeTreeStageRecord,
} from './merge-tree-core';

const OID_RE = /^[0-9a-f]{40,64}$/;
const REGULAR_MODES = new Set(['100644', '100755']);
const GIT_OPTS: RunGitOptions = { allowNonzero: true, timeoutMs: 60_000, maxBytes: 64 << 20 };
const PATCH_PATH_LIMIT = 64 << 10;
const PATCH_TOTAL_LIMIT = 256 << 10;

export type MergeUndoPathState =
  | 'clean'
  | 'merged'
  | 'conflicted'
  | 'refused-live-contention'
  | 'rename-pair-incomplete'
  | 'not-witnessed-for-undo'
  | 'unsupported-content-conversion'
  | 'unsupported-entry'
  | 'unsupported-symlink'
  | 'ignored'
  | 'index-worktree-diverged';

export interface MergeUndoTreeEntry {
  mode: string;
  blobOid: string;
}

export interface MergeUndoCurrentEntry extends MergeUndoTreeEntry {
  rawWorktreeOid: string;
  normalizationFingerprint: string;
}

export interface MergeUndoPathPreview {
  path: string;
  state: MergeUndoPathState;
  before: MergeUndoTreeEntry | null;
  after: MergeUndoTreeEntry | null;
  current: MergeUndoCurrentEntry | null;
  index: MergeUndoTreeEntry | null;
  result: MergeUndoTreeEntry | null;
  normalizationFingerprint: string | null;
  conflictStages: MergeTreeStageRecord[];
  patch: string | null;
  patchTruncated: boolean;
  omittedBytes: number;
}

export interface UndoMergePlannerInput {
  cwd: string;
  beforeOid: string;
  afterOid: string;
  requestedPaths: readonly string[];
  witnessedPaths: readonly string[];
  liveContentionPaths?: readonly string[];
}

export interface UndoMergePlannerDeps extends MergeTreeCoreDeps {
  runMergeTreeCore?: (input: Parameters<typeof realRunMergeTreeCore>[0], deps?: MergeTreeCoreDeps) => Promise<MergeTreeCoreResult>;
}

export type UndoMergePlannerResult =
  | {
      kind: 'ready';
      paths: MergeUndoPathPreview[];
      renameGroups: [string, string][];
      currentTreeOid: string;
      inverseTreeOid: string;
      resultTreeOid: string;
      patchTruncated: boolean;
      omittedBytes: number;
      omittedPathCount: number;
    }
  | {
      kind: 'conflicted';
      reason: 'merge-undo-conflict';
      paths: MergeUndoPathPreview[];
      renameGroups: [string, string][];
      currentTreeOid: string;
      inverseTreeOid: string;
      diagnosticTreeOid: string;
      patchTruncated: boolean;
      omittedBytes: number;
      omittedPathCount: number;
    }
  | {
      kind: 'refused';
      reason: MergeUndoPathState;
      paths: MergeUndoPathPreview[];
      renameGroups: [string, string][];
    }
  | { kind: 'failed'; reason: string; paths: MergeUndoPathPreview[]; renameGroups: [string, string][] };

interface Edge {
  status: string;
  paths: string[];
}

interface InspectedPath {
  before: MergeUndoTreeEntry | null;
  after: MergeUndoTreeEntry | null;
  current: MergeUndoCurrentEntry | null;
  index: MergeUndoTreeEntry | null;
  normalizationFingerprint: string;
  refusal: MergeUndoPathState | null;
}

type RunGit = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunResult>;
type RunGitBytes = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunBytesResult>;

function opts(deps: UndoMergePlannerDeps, extra: Partial<RunGitOptions> = {}): RunGitOptions {
  return { ...GIT_OPTS, gitExe: deps.gitExe, ...extra };
}

function validateRepoPath(repoPath: string): void {
  if (!repoPath || path.isAbsolute(repoPath) || repoPath.includes('\0')) throw new Error('merge-undo-path-invalid');
  const normalized = repoPath.replace(/\\/g, '/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('merge-undo-path-invalid');
  }
}

function parseTreeEntry(stdout: Buffer | string): MergeUndoTreeEntry | null {
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (bytes.length === 0) return null;
  const tab = bytes.indexOf(9);
  if (tab < 0) throw new Error('merge-undo-tree-entry-invalid');
  const metadata = bytes.subarray(0, tab).toString('ascii').split(' ');
  if (metadata.length !== 3 || !/^[0-7]{6}$/.test(metadata[0]) || !OID_RE.test(metadata[2])) {
    throw new Error('merge-undo-tree-entry-invalid');
  }
  return { mode: metadata[0], blobOid: metadata[2] };
}

async function treeEntry(runGitBytes: RunGitBytes, cwd: string, treeish: string, repoPath: string, deps: UndoMergePlannerDeps): Promise<MergeUndoTreeEntry | null> {
  const result = await runGitBytes(cwd, ['ls-tree', '-z', treeish, '--', repoPath], opts(deps));
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'merge-undo-ls-tree-failed');
  return parseTreeEntry(result.stdout);
}

function parseIndexEntry(stdout: Buffer): { entry: MergeUndoTreeEntry | null; coherentShape: boolean } {
  if (stdout.length === 0) return { entry: null, coherentShape: true };
  const records = stdout.toString('utf8').split('\0').filter(Boolean);
  if (records.length !== 1) return { entry: null, coherentShape: false };
  const tab = records[0].indexOf('\t');
  const metadata = tab < 0 ? [] : records[0].slice(0, tab).split(' ');
  if (metadata.length !== 3 || metadata[2] !== '0' || !OID_RE.test(metadata[1])) {
    return { entry: null, coherentShape: false };
  }
  return { entry: { mode: metadata[0], blobOid: metadata[1] }, coherentShape: true };
}

function parseAttributes(stdout: Buffer): Record<string, string> {
  const fields = stdout.toString('utf8').split('\0');
  const values: Record<string, string> = {};
  for (let i = 0; i + 2 < fields.length; i += 3) values[fields[i + 1]] = fields[i + 2];
  return values;
}

async function configValue(runGit: RunGit, cwd: string, key: string, deps: UndoMergePlannerDeps): Promise<string> {
  const result = await runGit(cwd, ['config', '--get', key], opts(deps));
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr.trim() || 'merge-undo-config-failed');
  return result.code === 0 ? result.stdout.trim().toLowerCase() : 'unspecified';
}

function sameEntry(a: MergeUndoTreeEntry | null, b: MergeUndoTreeEntry | null): boolean {
  return a === null ? b === null : b !== null && a.mode === b.mode && a.blobOid === b.blobOid;
}

function unsupportedMode(...entries: (MergeUndoTreeEntry | null)[]): MergeUndoPathState | null {
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.mode === '120000') return 'unsupported-symlink';
    if (!REGULAR_MODES.has(entry.mode)) return 'unsupported-entry';
  }
  return null;
}

async function cleanCapturedEntry(
  entry: MergeUndoTreeEntry | null,
  cwd: string,
  repoPath: string,
  runGit: RunGit,
  runGitBytes: RunGitBytes,
  deps: UndoMergePlannerDeps,
): Promise<MergeUndoTreeEntry | null> {
  if (!entry || !REGULAR_MODES.has(entry.mode)) return entry;
  const raw = await runGitBytes(cwd, ['cat-file', 'blob', entry.blobOid], opts(deps));
  if (raw.code !== 0) throw new Error(raw.stderr.trim() || 'merge-undo-captured-blob-read-failed');
  const clean = await runGit(cwd, ['hash-object', '-w', `--path=${repoPath}`, '--stdin'], opts(deps, { stdin: raw.stdout }));
  const blobOid = clean.stdout.trim();
  if (clean.code !== 0 || !OID_RE.test(blobOid)) throw new Error(clean.stderr.trim() || 'merge-undo-captured-clean-hash-failed');
  return { mode: entry.mode, blobOid };
}

async function inspectPath(
  cwd: string,
  repoPath: string,
  beforeOid: string,
  afterOid: string,
  runGit: RunGit,
  runGitBytes: RunGitBytes,
  deps: UndoMergePlannerDeps,
): Promise<InspectedPath> {
  const [before, after, ignored, attrResult, autocrlf, coreEol, filemode, indexResult] = await Promise.all([
    treeEntry(runGitBytes, cwd, beforeOid, repoPath, deps),
    treeEntry(runGitBytes, cwd, afterOid, repoPath, deps),
    runGit(cwd, ['check-ignore', '-q', '--no-index', '--', repoPath], opts(deps)),
    runGitBytes(cwd, ['check-attr', '-z', 'text', 'eol', 'filter', 'working-tree-encoding', '--', repoPath], opts(deps)),
    configValue(runGit, cwd, 'core.autocrlf', deps),
    configValue(runGit, cwd, 'core.eol', deps),
    configValue(runGit, cwd, 'core.filemode', deps),
    runGitBytes(cwd, ['ls-files', '--stage', '-z', '--', repoPath], opts(deps)),
  ]);
  if (ignored.code !== 0 && ignored.code !== 1) throw new Error(ignored.stderr.trim() || 'merge-undo-ignore-check-failed');
  if (attrResult.code !== 0) throw new Error(attrResult.stderr.trim() || 'merge-undo-attribute-check-failed');
  if (indexResult.code !== 0) throw new Error(indexResult.stderr.trim() || 'merge-undo-index-read-failed');
  const parsedIndex = parseIndexEntry(indexResult.stdout);
  const attributes = parseAttributes(attrResult.stdout);
  const fingerprint = createHash('sha256').update(JSON.stringify({
    text: attributes.text ?? 'unspecified',
    eol: attributes.eol ?? 'unspecified',
    filter: attributes.filter ?? 'unspecified',
    workingTreeEncoding: attributes['working-tree-encoding'] ?? 'unspecified',
    autocrlf,
    coreEol,
  })).digest('hex');
  const filter = attributes.filter ?? 'unspecified';
  const encoding = attributes['working-tree-encoding'] ?? 'unspecified';
  const conversionRefusal = (filter !== 'unspecified' && filter !== 'unset') || (encoding !== 'unspecified' && encoding !== 'unset')
    ? 'unsupported-content-conversion' as const : null;

  let current: MergeUndoCurrentEntry | null = null;
  let occupantRefusal: MergeUndoPathState | null = null;
  const absolutePath = path.join(cwd, ...repoPath.split('/'));
  let stat: fs.Stats | null = null;
  try { stat = await fs.promises.lstat(absolutePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (stat?.isSymbolicLink()) occupantRefusal = 'unsupported-symlink';
  else if (stat && !stat.isFile()) occupantRefusal = 'unsupported-entry';
  else if (stat && !conversionRefusal) {
    const clean = await runGit(cwd, ['hash-object', '-w', `--path=${repoPath}`, '--', repoPath], opts(deps));
    const raw = await runGit(cwd, ['hash-object', '-w', '--no-filters', '--', repoPath], opts(deps));
    if (clean.code !== 0 || !OID_RE.test(clean.stdout.trim())) throw new Error(clean.stderr.trim() || 'merge-undo-clean-hash-failed');
    if (raw.code !== 0 || !OID_RE.test(raw.stdout.trim())) throw new Error(raw.stderr.trim() || 'merge-undo-raw-hash-failed');
    const executable = (stat.mode & 0o111) !== 0;
    const mode = filemode === 'true'
      ? (executable ? '100755' : '100644')
      : (parsedIndex.entry?.mode ?? (executable ? '100755' : '100644'));
    current = { mode, blobOid: clean.stdout.trim(), rawWorktreeOid: raw.stdout.trim(), normalizationFingerprint: fingerprint };
  }

  const modeRefusal = unsupportedMode(before, after, parsedIndex.entry, current);
  let refusal: MergeUndoPathState | null = null;
  if (ignored.code === 0) refusal = 'ignored';
  else if (conversionRefusal) refusal = conversionRefusal;
  else if (occupantRefusal) refusal = occupantRefusal;
  else if (modeRefusal) refusal = modeRefusal;
  else if (!parsedIndex.coherentShape || !sameEntry(parsedIndex.entry, current)) refusal = 'index-worktree-diverged';
  const [cleanBefore, cleanAfter] = !refusal
    ? await Promise.all([
        cleanCapturedEntry(before, cwd, repoPath, runGit, runGitBytes, deps),
        cleanCapturedEntry(after, cwd, repoPath, runGit, runGitBytes, deps),
      ])
    : [before, after];
  return { before: cleanBefore, after: cleanAfter, current, index: parsedIndex.entry, normalizationFingerprint: fingerprint, refusal };
}

function parseEdges(stdout: Buffer): Edge[] {
  const fields = stdout.toString('utf8').split('\0');
  const edges: Edge[] = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++];
    const count = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    const paths = fields.slice(index, index + count);
    if (paths.length !== count || paths.some((p) => !p)) throw new Error('merge-undo-diff-tree-invalid');
    edges.push({ status, paths });
    index += count;
  }
  return edges;
}

async function classifyEdges(
  input: UndoMergePlannerInput,
  runGitBytes: RunGitBytes,
  deps: UndoMergePlannerDeps,
): Promise<{ states: Map<string, MergeUndoPathState>; renameGroups: [string, string][] }> {
  const diff = await runGitBytes(input.cwd, ['diff-tree', '--no-commit-id', '-r', '-M', '--name-status', '-z', input.beforeOid, input.afterOid], opts(deps));
  if (diff.code !== 0) throw new Error(diff.stderr.trim() || 'merge-undo-diff-tree-failed');
  const requested = new Set(input.requestedPaths);
  const witnessed = new Set(input.witnessedPaths);
  const states = new Map<string, MergeUndoPathState>();
  const renameGroups: [string, string][] = [];
  const covered = new Set<string>();
  for (const edge of parseEdges(diff.stdout)) {
    if (edge.paths.length === 2 && edge.status.startsWith('R')) {
      const [source, destination] = edge.paths;
      if (!requested.has(source) && !requested.has(destination)) continue;
      renameGroups.push([source, destination]);
      if (!requested.has(source) || !requested.has(destination)) {
        for (const repoPath of edge.paths) if (requested.has(repoPath)) states.set(repoPath, 'rename-pair-incomplete');
      } else if (!witnessed.has(source) || !witnessed.has(destination)) {
        for (const repoPath of edge.paths) states.set(repoPath, 'not-witnessed-for-undo');
      }
      edge.paths.forEach((repoPath) => covered.add(repoPath));
      continue;
    }
    for (const repoPath of edge.paths) {
      if (!requested.has(repoPath)) continue;
      covered.add(repoPath);
      if (!witnessed.has(repoPath)) states.set(repoPath, 'not-witnessed-for-undo');
    }
  }
  for (const repoPath of requested) {
    if (!covered.has(repoPath)) states.set(repoPath, 'not-witnessed-for-undo');
  }
  return { states, renameGroups };
}

async function writeSyntheticTree(
  cwd: string,
  afterOid: string,
  requestedPaths: readonly string[],
  entries: ReadonlyMap<string, MergeUndoTreeEntry | null>,
  indexFile: string,
  runGit: RunGit,
  deps: UndoMergePlannerDeps,
): Promise<string> {
  const read = await runGit(cwd, ['read-tree', afterOid], opts(deps, { indexFile }));
  if (read.code !== 0) throw new Error(read.stderr.trim() || 'merge-undo-read-tree-failed');
  for (const repoPath of requestedPaths) {
    const entry = entries.get(repoPath) ?? null;
    const update = entry
      ? await runGit(cwd, ['update-index', '--add', '--cacheinfo', entry.mode, entry.blobOid, repoPath], opts(deps, { indexFile }))
      : await runGit(cwd, ['update-index', '--force-remove', '--', repoPath], opts(deps, { indexFile }));
    if (update.code !== 0) throw new Error(update.stderr.trim() || 'merge-undo-update-index-failed');
  }
  const written = await runGit(cwd, ['write-tree'], opts(deps, { indexFile }));
  const oid = written.stdout.trim();
  if (written.code !== 0 || !OID_RE.test(oid)) throw new Error(written.stderr.trim() || 'merge-undo-write-tree-failed');
  return oid;
}

function emptyPreview(repoPath: string, state: MergeUndoPathState, inspected?: InspectedPath): MergeUndoPathPreview {
  return {
    path: repoPath, state,
    before: inspected?.before ?? null, after: inspected?.after ?? null,
    current: inspected?.current ?? null, index: inspected?.index ?? null,
    result: null, normalizationFingerprint: inspected?.normalizationFingerprint ?? null,
    conflictStages: [], patch: null, patchTruncated: false, omittedBytes: 0,
  };
}

function findLineSequence(haystack: readonly string[], needle: readonly string[], from: number): number {
  if (needle.length === 0) return from;
  for (let start = from; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((line, offset) => haystack[start + offset] === line)) return start;
  }
  return from;
}

function conflictHunks(diff3: string, currentText: string, inverseText: string): string | null {
  const lines = diff3.replace(/\r\n/g, '\n').split('\n');
  const currentLines = currentText.replace(/\r\n/g, '\n').split('\n');
  const inverseLines = inverseText.replace(/\r\n/g, '\n').split('\n');
  const hunks: string[] = [];
  let currentCursor = 0;
  let inverseCursor = 0;
  for (let start = 0; start < lines.length; start += 1) {
    if (!lines[start].startsWith('<<<<<<< current:')) continue;
    const baseMarker = lines.findIndex((line, index) => index > start && line.startsWith('||||||| base:'));
    const divider = lines.findIndex((line, index) => index > baseMarker && line === '=======');
    const end = lines.findIndex((line, index) => index > divider && line.startsWith('>>>>>>> inverse:'));
    if (baseMarker < 0 || divider < 0 || end < 0) return null;
    const currentPart = lines.slice(start + 1, baseMarker);
    const inversePart = lines.slice(divider + 1, end);
    const currentIndex = findLineSequence(currentLines, currentPart, currentCursor);
    const inverseIndex = findLineSequence(inverseLines, inversePart, inverseCursor);
    currentCursor = currentIndex + currentPart.length;
    inverseCursor = inverseIndex + inversePart.length;
    const currentCount = Math.max(1, currentPart.length);
    const inverseCount = Math.max(1, inversePart.length);
    hunks.push([
      `@@ -${currentIndex + 1},${currentCount} +${inverseIndex + 1},${inverseCount} @@ current/base/inverse conflict`,
      ...lines.slice(start, end + 1),
    ].join('\n'));
    start = end;
  }
  return hunks.length > 0 ? hunks.join('\n') + '\n' : null;
}

async function conflictDiagnostic(
  preview: MergeUndoPathPreview,
  cwd: string,
  tempDir: string,
  runGitBytes: RunGitBytes,
  deps: UndoMergePlannerDeps,
): Promise<Buffer> {
  const byStage = new Map(preview.conflictStages.map((stage) => [stage.stage, stage]));
  const base = byStage.get(1);
  const current = byStage.get(2);
  const inverse = byStage.get(3);
  if (!base || !current || !inverse || [base, current, inverse].some((stage) => !REGULAR_MODES.has(stage.mode))) {
    return Buffer.from('Binary or structural conflict; text line ranges unavailable.\n');
  }
  const blobs = await Promise.all([base, current, inverse].map(async (stage) => {
    const result = await runGitBytes(cwd, ['cat-file', 'blob', stage.blobOid], opts(deps));
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'merge-undo-conflict-blob-read-failed');
    return result.stdout;
  }));
  if (blobs.some((blob) => blob.includes(0))) {
    return Buffer.from('Binary conflict; text line ranges unavailable.\n');
  }
  let texts: string[];
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    texts = blobs.map((blob) => decoder.decode(blob));
  } catch {
    return Buffer.from('Binary conflict; text line ranges unavailable.\n');
  }
  const stem = createHash('sha256').update(preview.path).digest('hex').slice(0, 16);
  const currentFile = path.join(tempDir, `${stem}-current`);
  const baseFile = path.join(tempDir, `${stem}-base`);
  const inverseFile = path.join(tempDir, `${stem}-inverse`);
  await Promise.all([
    fs.promises.writeFile(currentFile, blobs[1]),
    fs.promises.writeFile(baseFile, blobs[0]),
    fs.promises.writeFile(inverseFile, blobs[2]),
  ]);
  const merged = await runGitBytes(cwd, [
    'merge-file', '-p', '--diff3',
    '-L', `current:${preview.path}`, '-L', `base:${preview.path}`, '-L', `inverse:${preview.path}`,
    currentFile, baseFile, inverseFile,
  ], opts(deps));
  const hunks = conflictHunks(merged.stdout.toString('utf8'), texts[1], texts[2]);
  return Buffer.from(hunks ?? 'Binary or structural conflict; text line ranges unavailable.\n');
}

function boundedUtf8(bytes: Buffer, allowance: number): { text: string; includedBytes: number } {
  if (bytes.length <= allowance) return { text: bytes.toString('utf8'), includedBytes: bytes.length };
  const decoder = new TextDecoder('utf-8');
  const text = decoder.decode(bytes.subarray(0, allowance), { stream: true });
  return { text, includedBytes: Buffer.byteLength(text, 'utf8') };
}

async function addPatches(
  previews: MergeUndoPathPreview[], cwd: string, currentTreeOid: string, resultTreeOid: string,
  tempDir: string, runGit: RunGit, runGitBytes: RunGitBytes, deps: UndoMergePlannerDeps,
): Promise<{ patchTruncated: boolean; omittedBytes: number; omittedPathCount: number }> {
  let remaining = PATCH_TOTAL_LIMIT;
  let omittedBytes = 0;
  let omittedPathCount = 0;
  for (const preview of previews) {
    let bytes: Buffer;
    if (preview.state === 'conflicted') {
      bytes = await conflictDiagnostic(preview, cwd, tempDir, runGitBytes, deps);
    } else if (preview.state === 'clean' || preview.state === 'merged') {
      const diff = await runGit(cwd, ['diff', '--no-ext-diff', '--no-color', '--binary', currentTreeOid, resultTreeOid, '--', preview.path], opts(deps));
      if (diff.code !== 0) throw new Error(diff.stderr.trim() || 'merge-undo-patch-failed');
      bytes = Buffer.from(diff.stdout, 'utf8');
    } else continue;
    const allowance = Math.min(PATCH_PATH_LIMIT, remaining);
    const bounded = boundedUtf8(bytes, allowance);
    preview.patch = bounded.text;
    preview.omittedBytes = bytes.length - bounded.includedBytes;
    preview.patchTruncated = preview.omittedBytes > 0;
    remaining -= bounded.includedBytes;
    omittedBytes += preview.omittedBytes;
    if (preview.patchTruncated) omittedPathCount += 1;
  }
  return { patchTruncated: omittedBytes > 0, omittedBytes, omittedPathCount };
}

export async function planUndoMerge(input: UndoMergePlannerInput, deps: UndoMergePlannerDeps = {}): Promise<UndoMergePlannerResult> {
  const requestedPaths = [...new Set(input.requestedPaths)];
  if (requestedPaths.length === 0) throw new Error('merge-undo-paths-empty');
  requestedPaths.forEach(validateRepoPath);
  const runGit = deps.runGit ?? realRunGit;
  const runGitBytes = deps.runGitBytes ?? realRunGitBytes;
  const mergeTree = deps.runMergeTreeCore ?? realRunMergeTreeCore;
  const classified = await classifyEdges({ ...input, requestedPaths }, runGitBytes, deps);
  const inspected = new Map<string, InspectedPath>();
  const live = new Set(input.liveContentionPaths ?? []);
  for (const repoPath of requestedPaths) {
    const value = await inspectPath(input.cwd, repoPath, input.beforeOid, input.afterOid, runGit, runGitBytes, deps);
    if (live.has(repoPath)) value.refusal = 'refused-live-contention';
    if (classified.states.has(repoPath)) value.refusal = classified.states.get(repoPath)!;
    inspected.set(repoPath, value);
  }
  const refused = requestedPaths.filter((repoPath) => inspected.get(repoPath)!.refusal !== null);
  if (refused.length > 0) {
    const paths = requestedPaths.map((repoPath) => {
      const value = inspected.get(repoPath)!;
      return emptyPreview(repoPath, value.refusal ?? (sameEntry(value.current, value.after) ? 'clean' : 'merged'), value);
    });
    return { kind: 'refused', reason: inspected.get(refused[0])!.refusal!, paths, renameGroups: classified.renameGroups };
  }

  const tempDir = await fs.promises.mkdtemp(path.join(deps.tmpDir ?? os.tmpdir(), 'lares-undo-merge-plan-'));
  try {
    const currentEntries = new Map(requestedPaths.map((repoPath) => [repoPath, inspected.get(repoPath)!.current]));
    const beforeEntries = new Map(requestedPaths.map((repoPath) => [repoPath, inspected.get(repoPath)!.before]));
    const afterEntries = new Map(requestedPaths.map((repoPath) => [repoPath, inspected.get(repoPath)!.after]));
    const baseTreeOid = await writeSyntheticTree(input.cwd, input.afterOid, requestedPaths, afterEntries, path.join(tempDir, 'base-index'), runGit, deps);
    const currentTreeOid = await writeSyntheticTree(input.cwd, baseTreeOid, requestedPaths, currentEntries, path.join(tempDir, 'current-index'), runGit, deps);
    const inverseTreeOid = await writeSyntheticTree(input.cwd, baseTreeOid, requestedPaths, beforeEntries, path.join(tempDir, 'inverse-index'), runGit, deps);
    const merged = await mergeTree({ cwd: input.cwd, baseOid: baseTreeOid, currentOid: currentTreeOid, incomingOid: inverseTreeOid }, {
      gitExe: deps.gitExe, runGit, runGitBytes, tmpDir: tempDir,
    });
    if (merged.kind === 'failed' || merged.kind === 'resolved') {
      return { kind: 'failed', reason: merged.kind === 'failed' ? merged.reason : 'merge-undo-resolved-exit-one-not-applicable', paths: [], renameGroups: classified.renameGroups };
    }
    const stagesByPath = new Map<string, MergeTreeStageRecord[]>();
    for (const stage of merged.stages) {
      const repoPath = Buffer.from(stage.pathBytesBase64, 'base64').toString('utf8');
      if (!requestedPaths.includes(repoPath)) return { kind: 'failed', reason: 'merge-undo-conflict-outside-selection', paths: [], renameGroups: classified.renameGroups };
      const records = stagesByPath.get(repoPath) ?? [];
      records.push(stage); stagesByPath.set(repoPath, records);
    }
    const previewTreeOid = merged.kind === 'clean' ? merged.applyTreeOid : merged.diagnosticTreeOid;
    const previews: MergeUndoPathPreview[] = [];
    for (const repoPath of requestedPaths) {
      const value = inspected.get(repoPath)!;
      const conflictStages = stagesByPath.get(repoPath) ?? [];
      const result = conflictStages.length === 0 ? await treeEntry(runGitBytes, input.cwd, previewTreeOid, repoPath, deps) : null;
      const state: MergeUndoPathState = conflictStages.length > 0 ? 'conflicted' : sameEntry(value.current, value.after) ? 'clean' : 'merged';
      previews.push({ ...emptyPreview(repoPath, state, value), result, conflictStages });
    }
    const patchSummary = await addPatches(previews, input.cwd, currentTreeOid, previewTreeOid, tempDir, runGit, runGitBytes, deps);
    if (merged.kind === 'conflicted') {
      return { kind: 'conflicted', reason: 'merge-undo-conflict', paths: previews, renameGroups: classified.renameGroups,
        currentTreeOid, inverseTreeOid, diagnosticTreeOid: merged.diagnosticTreeOid, ...patchSummary };
    }
    return { kind: 'ready', paths: previews, renameGroups: classified.renameGroups,
      currentTreeOid, inverseTreeOid, resultTreeOid: merged.applyTreeOid, ...patchSummary };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}
