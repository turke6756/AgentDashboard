// Stateless, worktree-free three-way merge plumbing shared by checkpoint callers.

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

const OID_RE = /^[0-9a-f]{40,64}$/;
const MODE_RE = /^[0-7]{6}$/;
const CORE_OPTS: RunGitOptions = { allowNonzero: true, timeoutMs: 60_000, maxBytes: 64 << 20 };

export type MergeTreeRunGit = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunResult>;
export type MergeTreeRunGitBytes = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunBytesResult>;

export interface MergeTreeStageRecord {
  pathBytesBase64: string;
  mode: string;
  blobOid: string;
  stage: 1 | 2 | 3;
}

export interface MergeTreeResolution {
  pathBytesBase64: string;
  blobOid: string | null;
}

export interface MergeTreeCoreInput {
  cwd: string;
  baseOid: string;
  currentOid: string;
  incomingOid: string;
  resolutions?: readonly MergeTreeResolution[];
}

export interface MergeTreeCoreDeps {
  gitExe?: string;
  runGit?: MergeTreeRunGit;
  runGitBytes?: MergeTreeRunGitBytes;
  tmpDir?: string;
  privateIndexFile?: string;
}

export type MergeTreeCoreResult =
  | { kind: 'clean'; exitCode: 0; stages: []; applyTreeOid: string }
  | { kind: 'conflicted'; exitCode: 1; stages: MergeTreeStageRecord[]; diagnosticTreeOid: string; applyTreeOid: null }
  | { kind: 'resolved'; exitCode: 1; stages: MergeTreeStageRecord[]; diagnosticTreeOid: string; applyTreeOid: string }
  | { kind: 'failed'; exitCode: number; reason: string; applyTreeOid: null };

export function splitNulRecords(bytes: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index > start) records.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start < bytes.length) records.push(bytes.subarray(start));
  return records;
}

export function parseMergeTreeStages(records: readonly Buffer[]): MergeTreeStageRecord[] {
  const stages: MergeTreeStageRecord[] = [];
  for (const record of records) {
    const tab = record.indexOf(9);
    if (tab < 0) continue; // merge-tree also emits structured message records.
    const metadataText = record.subarray(0, tab).toString('ascii');
    if (!/^[0-9]{6} /.test(metadataText)) continue;
    const metadata = metadataText.split(' ');
    if (metadata.length !== 3 || !MODE_RE.test(metadata[0]) || !OID_RE.test(metadata[1])) {
      throw new Error('merge-tree-stage-record-invalid');
    }
    const stage = Number(metadata[2]);
    if (stage !== 1 && stage !== 2 && stage !== 3) throw new Error('merge-tree-stage-record-invalid');
    const pathBytes = record.subarray(tab + 1);
    if (pathBytes.length === 0) throw new Error('merge-tree-stage-record-invalid');
    stages.push({
      pathBytesBase64: pathBytes.toString('base64'),
      mode: metadata[0],
      blobOid: metadata[1],
      stage,
    });
  }
  return stages;
}

function commandFailure(result: GitRunResult, fallback: string): string {
  return result.stderr.trim() || fallback;
}

export async function runMergeTreeCore(
  input: MergeTreeCoreInput,
  deps: MergeTreeCoreDeps = {},
): Promise<MergeTreeCoreResult> {
  for (const oid of [input.baseOid, input.currentOid, input.incomingOid]) {
    if (!OID_RE.test(oid)) throw new Error('merge-tree-input-oid-invalid');
  }
  const runGit = deps.runGit ?? realRunGit;
  const runGitBytes = deps.runGitBytes ?? realRunGitBytes;
  const opts = { ...CORE_OPTS, gitExe: deps.gitExe };
  const merged = await runGitBytes(input.cwd, [
    'merge-tree', '--write-tree', '--merge-base', input.baseOid,
    '--messages', '-z', input.currentOid, input.incomingOid,
  ], opts);

  if (merged.code !== 0 && merged.code !== 1) {
    return { kind: 'failed', exitCode: merged.code, reason: merged.stderr.trim() || 'merge-tree-three-way-failed', applyTreeOid: null };
  }
  const records = splitNulRecords(merged.stdout);
  const resultTreeOid = records.shift()?.toString('ascii').trim() ?? '';
  if (!OID_RE.test(resultTreeOid)) throw new Error('merge-tree-result-missing');
  const stages = parseMergeTreeStages(records);
  if (merged.code === 0) {
    if (stages.length > 0) throw new Error('merge-tree-clean-result-has-stages');
    if (deps.privateIndexFile) {
      const readTree = await runGit(input.cwd, ['read-tree', resultTreeOid], { ...opts, indexFile: deps.privateIndexFile });
      if (readTree.code !== 0) throw new Error(commandFailure(readTree, 'merge-result-read-tree-failed'));
    }
    return { kind: 'clean', exitCode: 0, stages: [], applyTreeOid: resultTreeOid };
  }
  if (stages.length === 0) throw new Error('merge-tree-conflict-result-missing-stages');

  const resolutions = new Map((input.resolutions ?? []).map((resolution) => [resolution.pathBytesBase64, resolution]));
  const conflictedPaths = new Set(stages.map((stage) => stage.pathBytesBase64));
  const unresolved = [...conflictedPaths].filter((pathBytesBase64) => !resolutions.has(pathBytesBase64));
  if (unresolved.length > 0) {
    return { kind: 'conflicted', exitCode: 1, stages, diagnosticTreeOid: resultTreeOid, applyTreeOid: null };
  }

  const tempDir = deps.privateIndexFile
    ? null
    : await fs.promises.mkdtemp(path.join(deps.tmpDir ?? os.tmpdir(), 'lares-merge-tree-core-'));
  const privateOpts = { ...opts, indexFile: deps.privateIndexFile ?? path.join(tempDir!, 'index') };
  try {
    const readTree = await runGit(input.cwd, ['read-tree', resultTreeOid], privateOpts);
    if (readTree.code !== 0) throw new Error(commandFailure(readTree, 'merge-result-read-tree-failed'));
    for (const pathBytesBase64 of conflictedPaths) {
      const resolution = resolutions.get(pathBytesBase64)!;
      const repoPath = Buffer.from(pathBytesBase64, 'base64').toString('utf8');
      let update: GitRunResult;
      if (resolution.blobOid) {
        if (!OID_RE.test(resolution.blobOid)) throw new Error('merge-resolution-blob-invalid');
        const mode = stages.find((stage) => stage.pathBytesBase64 === pathBytesBase64 && stage.stage === 2)?.mode
          ?? stages.find((stage) => stage.pathBytesBase64 === pathBytesBase64)?.mode;
        if (!mode) throw new Error('merge-resolution-mode-missing');
        update = await runGit(input.cwd, ['update-index', '--add', '--cacheinfo', mode, resolution.blobOid, repoPath], privateOpts);
      } else {
        update = await runGit(input.cwd, ['update-index', '--force-remove', '--', repoPath], privateOpts);
      }
      if (update.code !== 0) throw new Error(commandFailure(update, 'merge-resolution-index-update-failed'));
    }
    const writeTree = await runGit(input.cwd, ['write-tree'], privateOpts);
    const applyTreeOid = writeTree.stdout.trim();
    if (writeTree.code !== 0 || !OID_RE.test(applyTreeOid)) throw new Error(commandFailure(writeTree, 'merge-write-tree-failed'));
    return { kind: 'resolved', exitCode: 1, stages, diagnosticTreeOid: resultTreeOid, applyTreeOid };
  } finally {
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}
