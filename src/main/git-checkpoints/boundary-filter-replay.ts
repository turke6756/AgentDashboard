// Boundary-backed manifest freezing for save-card finalization.
//
// The boundary tree and tracked .gitattributes are immutable inputs. Filter
// definitions themselves remain trusted live configuration (Git config,
// .git/info/attributes, and global attributes are intentionally not part of
// snapshot identity).

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { EncodedGitPath } from '../../shared/commit-candidates';
import type { RunGitLike } from './checkpoint-service';
import type { GitRunBytesResult, RunGitOptions } from './git-command';
import type { CommitRepresentation, CommitRepresentationEntry } from '../commit-candidates/commit-representation';

export interface BoundaryFilterReplayRuntime {
  repoRoot: string;
  gitExe?: string;
  deadlineAt?: number;
  runGit?: RunGitLike;
  runGitBytes?: RunGitBytes;
  tmpDir?: string;
}

interface BoundaryTreeEntry { mode: string; oid: string; path: Buffer; }
interface StageEntry { mode: string; oid: string; stage: string; path: Buffer; }
type RunGitBytes = (cwd: string, args: string[], options: RunGitOptions) => Promise<GitRunBytesResult>;

const options = (runtime: BoundaryFilterReplayRuntime, indexFile?: string): RunGitOptions => ({
  gitExe: runtime.gitExe,
  deadlineAt: runtime.deadlineAt,
  timeoutMs: 30_000,
  maxBytes: 128 << 20,
  ...(indexFile ? { indexFile } : {}),
});

function pathBytes(encoded: EncodedGitPath): Buffer {
  const bytes = Buffer.from(encoded.pathBytesBase64, 'base64');
  if (!bytes.length || bytes.includes(0) || bytes.toString('base64') !== encoded.pathBytesBase64) {
    throw new Error('Boundary path must be canonical, non-empty, NUL-free base64.');
  }
  return bytes;
}

function parseLsTree(bytes: Buffer): BoundaryTreeEntry[] {
  const result: BoundaryTreeEntry[] = [];
  let start = 0;
  for (let end = 0; end <= bytes.length; end += 1) {
    if (end < bytes.length && bytes[end] !== 0) continue;
    const record = bytes.subarray(start, end);
    start = end + 1;
    if (!record.length) continue;
    const tab = record.indexOf(0x09);
    const meta = record.subarray(0, tab).toString('ascii').split(' ');
    if (tab < 0 || meta.length !== 3 || !/^[0-9]{6}$/.test(meta[0]) || !/^[0-9a-f]{40,64}$/.test(meta[2])) {
      throw new Error('Malformed boundary ls-tree record.');
    }
    result.push({ mode: meta[0], oid: meta[2], path: record.subarray(tab + 1) });
  }
  return result;
}

function parseStages(bytes: Buffer): StageEntry[] {
  const result: StageEntry[] = [];
  let start = 0;
  for (let end = 0; end <= bytes.length; end += 1) {
    if (end < bytes.length && bytes[end] !== 0) continue;
    const record = bytes.subarray(start, end);
    start = end + 1;
    if (!record.length) continue;
    const tab = record.indexOf(0x09);
    const meta = record.subarray(0, tab).toString('ascii').split(' ');
    if (tab < 0 || meta.length !== 3) throw new Error('Malformed temporary-index record.');
    result.push({ mode: meta[0], oid: meta[1], stage: meta[2], path: record.subarray(tab + 1) });
  }
  return result;
}

async function catBlobs(runtime: BoundaryFilterReplayRuntime, oids: readonly string[]): Promise<Map<string, Buffer>> {
  if (!oids.length) return new Map();
  const runGitBytes = runtime.runGitBytes;
  if (!runGitBytes) throw new Error('Boundary filter replay requires runGitBytes.');
  const input = Buffer.concat(oids.map((oid) => Buffer.from(`${oid}\n`, 'ascii')));
  const result: GitRunBytesResult = await runGitBytes(runtime.repoRoot, ['cat-file', '--batch'], {
    ...options(runtime), stdin: input,
  });
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const oid of oids) {
    const lineEnd = result.stdout.indexOf(0x0a, offset);
    if (lineEnd < 0) throw new Error('Malformed cat-file --batch header.');
    const header = result.stdout.subarray(offset, lineEnd).toString('ascii').split(' ');
    offset = lineEnd + 1;
    if (header.length !== 3 || header[1] !== 'blob') throw new Error(`Boundary object ${oid} is not a blob.`);
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size >= result.stdout.length) throw new Error('Malformed cat-file blob size.');
    blobs.set(oid, Buffer.from(result.stdout.subarray(offset, offset + size)));
    offset += size;
    if (result.stdout[offset] !== 0x0a) throw new Error('Malformed cat-file --batch delimiter.');
    offset += 1;
  }
  return blobs;
}

function nul(paths: readonly Buffer[]): Buffer {
  return Buffer.concat(paths.flatMap((value) => [value, Buffer.from([0])]));
}

/**
 * Freeze selected members from boundaryOid and replay Git's clean filter in an
 * isolated index/worktree. The returned map is keyed by authoritative path
 * bytes; callers must inject it through the existing per-entry freeze seam.
 */
export async function freezeMembersFromBoundary(input: {
  boundaryOid: string;
  pinnedHeadOid: string | null;
  members: readonly CommitRepresentationEntry[];
  repoRuntime: BoundaryFilterReplayRuntime;
}): Promise<Map<string, CommitRepresentation>> {
  const { boundaryOid, members, repoRuntime } = input;
  const runGit = repoRuntime.runGit;
  const runGitBytes = repoRuntime.runGitBytes;
  if (!runGit || !runGitBytes) throw new Error('Boundary filter replay requires runGit and runGitBytes.');
  const treeResult = await runGitBytes(repoRuntime.repoRoot, ['ls-tree', '-r', '-z', '--full-tree', boundaryOid], options(repoRuntime));
  const tree = parseLsTree(treeResult.stdout);
  const byPath = new Map(tree.map((entry) => [entry.path.toString('base64'), entry]));
  const selected = members.map((member) => ({ member, path: pathBytes(member.path) }));
  const attrs = tree.filter((entry) => entry.path.toString('utf8').endsWith('/.gitattributes') || entry.path.toString('utf8') === '.gitattributes');
  const needed = [...selected.map((item) => byPath.get(item.path.toString('base64'))), ...attrs]
    .filter((entry): entry is BoundaryTreeEntry => !!entry);
  const blobs = await catBlobs(repoRuntime, [...new Map(needed.map((entry) => [entry.oid, entry])).keys()]);
  const root = await fs.mkdtemp(path.join(repoRuntime.tmpDir ?? os.tmpdir(), 'lares-boundary-freeze-'));
  const indexFile = path.join(root, `${randomUUID()}.index`);
  const pathFile = path.join(root, `${randomUUID()}.paths`);
  const gitOptions = options(repoRuntime, indexFile);
  const result = new Map<string, CommitRepresentation>();
  try {
    await runGit(repoRuntime.repoRoot, ['read-tree', boundaryOid], gitOptions);
    for (const entry of attrs) {
      const file = path.join(root, entry.path.toString());
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, blobs.get(entry.oid)!);
    }
    const presentPaths: Buffer[] = [];
    for (const { member, path: memberPath } of selected) {
      const boundary = byPath.get(memberPath.toString('base64'));
      if (member.expectedWorktreeState === 'absent') {
        result.set(member.path.pathBytesBase64, { expectedState: 'absent', rawBlobOid: member.rawWorktreeBlobOid, commitBlobOid: null, commitMode: null });
        continue;
      }
      if (!boundary) throw new Error(`Boundary is missing present member ${member.path.pathBytesBase64}.`);
      const file = path.join(root, memberPath.toString());
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, blobs.get(boundary.oid)!);
      presentPaths.push(memberPath);
    }
    await fs.writeFile(pathFile, nul(presentPaths));
    // GIT_WORK_TREE is deliberately stripped by the shared Git runtime. Use
    // Git's argv-level work-tree option so the isolated materialization remains
    // explicit without mutating process environment or performing a checkout.
    if (presentPaths.length) await runGit(repoRuntime.repoRoot, ['--work-tree', root, 'add', `--pathspec-from-file=${pathFile}`, '--pathspec-file-nul'], gitOptions);
    const staged = parseStages((await runGitBytes(repoRuntime.repoRoot, ['ls-files', '--stage', '-z'], gitOptions)).stdout);
    const stages = new Map(staged.map((entry) => [entry.path.toString('base64'), entry]));
    for (const { member, path: memberPath } of selected) {
      if (member.expectedWorktreeState === 'absent') continue;
      const stage = stages.get(memberPath.toString('base64'));
      if (!stage || stage.stage !== '0') throw new Error('Boundary filter replay did not produce a stage-0 entry.');
      result.set(member.path.pathBytesBase64, { expectedState: 'present', rawBlobOid: byPath.get(memberPath.toString('base64'))!.oid, commitBlobOid: stage.oid, commitMode: stage.mode });
    }
    return result;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
