import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type { GitRunBytesResult, GitRunResult, RunGitOptions } from './git-command';
import { planUndoMerge, type UndoMergePlannerDeps } from './undo-merge-planner';

function exec(cwd: string, args: string[], options: RunGitOptions, bytes: true): Promise<GitRunBytesResult>;
function exec(cwd: string, args: string[], options: RunGitOptions, bytes?: false): Promise<GitRunResult>;
function exec(cwd: string, args: string[], options: RunGitOptions, bytes = false): Promise<GitRunResult | GitRunBytesResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...options.env, ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}) };
    const child = execFile('git', args, { cwd, env, windowsHide: true, encoding: bytes ? 'buffer' : 'utf8',
      timeout: options.timeoutMs, maxBuffer: options.maxBytes }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
        ? (error as NodeJS.ErrnoException & { code: number }).code : error ? 1 : 0;
      if (error && !options.allowNonzero) reject(error);
      else resolve({ code, stdout: bytes ? Buffer.from(stdout as Buffer) : String(stdout), stderr: String(stderr) } as GitRunResult & GitRunBytesResult);
    });
    child.stdin?.end(options.stdin);
  });
}
const runGit = (cwd: string, args: string[], options: RunGitOptions) => exec(cwd, args, options);
const runGitBytes = (cwd: string, args: string[], options: RunGitOptions) => exec(cwd, args, options, true);
const deps: UndoMergePlannerDeps = { runGit, runGitBytes };
const git = (cwd: string, ...args: string[]) => String(execFileSync('git', args, { cwd, windowsHide: true })).trim();
const gitInput = (cwd: string, args: string[], input: Buffer | string) =>
  String(execFileSync('git', args, { cwd, input, windowsHide: true })).trim();

function createRepo(autocrlf = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-undo-plan-test-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@lares.local');
  git(root, 'config', 'user.name', 'Lares Test');
  git(root, 'config', 'core.autocrlf', autocrlf ? 'true' : 'false');
  git(root, 'config', 'core.filemode', 'false');
  return root;
}

function commit(root: string, message: string, paths: string[]): string {
  git(root, 'add', '--', ...paths);
  git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function lines(changes: Record<number, string> = {}, eol = '\n'): string {
  return `${Array.from({ length: 40 }, (_, index) => changes[index + 1] ?? `line-${index + 1}`).join(eol)}${eol}`;
}

function longLines(changes: Record<number, string> = {}, eol = '\n'): string {
  return `${Array.from({ length: 1_500 }, (_, index) => changes[index + 1] ?? `line-${index + 1}`).join(eol)}${eol}`;
}

function write(root: string, repoPath: string, content: string): void {
  const destination = path.join(root, ...repoPath.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function rawCheckpoint(root: string, repoPath: string, content: string, parent?: string): string {
  write(root, repoPath, content);
  const blobOid = git(root, 'hash-object', '-w', '--no-filters', '--', repoPath);
  const treeOid = gitInput(root, ['mktree', '-z'], Buffer.from(`100644 blob ${blobOid}\t${repoPath}\0`));
  return git(root, 'commit-tree', treeOid, ...(parent ? ['-p', parent] : []), '-m', 'raw checkpoint');
}

function pathState(result: Awaited<ReturnType<typeof planUndoMerge>>, repoPath: string): string {
  const found = result.paths.find((entry) => entry.path === repoPath);
  assert.ok(found, `missing preview for ${repoPath}`);
  return found.state;
}

test('autocrlf cleans raw CRLF checkpoint blobs and preserves a distant staged edit', async (t) => {
  const root = createRepo(true); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = rawCheckpoint(root, 'shared.txt', longLines({}, '\r\n'));
  const after = rawCheckpoint(root, 'shared.txt', longLines({ 1_020: 'TURN' }, '\r\n'), before);
  assert.match(git(root, 'cat-file', 'blob', `${after}:shared.txt`), /\r\n/,
    'checkpoint fixture deliberately stores raw CRLF bytes');
  write(root, 'shared.txt', longLines({ 1_020: 'TURN', 1_460: 'LATER' }, '\r\n'));
  git(root, 'add', '--', 'shared.txt');

  const result = await planUndoMerge({ cwd: root, beforeOid: before, afterOid: after,
    requestedPaths: ['shared.txt'], witnessedPaths: ['shared.txt'] }, deps);
  assert.equal(result.kind, 'ready');
  assert.equal(pathState(result, 'shared.txt'), 'merged');
  if (result.kind !== 'ready') return;
  const content = git(root, 'show', `${result.resultTreeOid}:shared.txt`).split(/\r?\n/);
  assert.equal(content[1_019], 'line-1020');
  assert.equal(content[1_459], 'LATER');
  assert.notEqual(result.paths[0].current?.rawWorktreeOid, result.paths[0].current?.blobOid,
    'raw CRLF and clean LF identities stay distinct');
  const cleanAfterOid = gitInput(root, ['hash-object', '-w', '--path=shared.txt', '--stdin'],
    Buffer.from(longLines({ 1_020: 'TURN' }, '\r\n')));
  assert.equal(result.paths[0].after?.blobOid, cleanAfterOid,
    'captured AFTER is represented in the same clean domain as current content');
});

test('autocrlf same-line conflict from raw checkpoints names the true narrow line range', async (t) => {
  const root = createRepo(true); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = rawCheckpoint(root, 'shared.txt', longLines({}, '\r\n'));
  const after = rawCheckpoint(root, 'shared.txt', longLines({ 1_020: 'TURN' }, '\r\n'), before);
  write(root, 'shared.txt', longLines({ 1_020: 'LATER-SAME-LINE' }, '\r\n'));
  git(root, 'add', '--', 'shared.txt');
  const result = await planUndoMerge({ cwd: root, beforeOid: before, afterOid: after,
    requestedPaths: ['shared.txt'], witnessedPaths: ['shared.txt'] }, deps);
  assert.equal(result.kind, 'conflicted');
  assert.equal(pathState(result, 'shared.txt'), 'conflicted');
  if (result.kind === 'conflicted') {
    assert.ok(result.paths[0].conflictStages.length >= 3);
    assert.match(result.paths[0].patch ?? '', /^@@ -1020,1 \+1020,1 @@ current\/base\/inverse conflict/m);
    assert.doesNotMatch(result.paths[0].patch ?? '', /^@@ -1,460 \+1,460 @@/m);
    assert.doesNotMatch(result.paths[0].patch ?? '', /^@@ .*\+1460,/m);
    assert.match(result.paths[0].patch ?? '', /<<<<<<< current:shared\.txt/);
    assert.match(result.paths[0].patch ?? '', /\|\|\|\|\|\|\| base:shared\.txt/);
    assert.match(result.paths[0].patch ?? '', />>>>>>> inverse:shared\.txt/);
    assert.equal('resultTreeOid' in result, false);
  }
});

test('conflict diagnostics enforce per-path and total UTF-8 bounds', async (t) => {
  const root = createRepo(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = Array.from({ length: 5 }, (_, index) => `large-${index}.txt`);
  for (const repoPath of paths) write(root, repoPath, `base-${'x'.repeat(70_000)}\n`);
  const before = commit(root, 'large before', paths);
  for (const repoPath of paths) write(root, repoPath, `turn-${'y'.repeat(70_000)}\n`);
  const after = commit(root, 'large turn', paths);
  for (const repoPath of paths) write(root, repoPath, `later-${'z'.repeat(70_000)}\n`);
  git(root, 'add', '--', ...paths);

  const result = await planUndoMerge({ cwd: root, beforeOid: before, afterOid: after,
    requestedPaths: paths, witnessedPaths: paths }, deps);
  assert.equal(result.kind, 'conflicted');
  if (result.kind !== 'conflicted') return;
  const patchBytes = result.paths.map((entry) => Buffer.byteLength(entry.patch ?? '', 'utf8'));
  assert.ok(patchBytes.every((bytes) => bytes <= 64 * 1024), `per-path bounds: ${patchBytes.join(',')}`);
  assert.ok(patchBytes.reduce((sum, bytes) => sum + bytes, 0) <= 256 * 1024);
  assert.equal(result.patchTruncated, true);
  assert.ok(result.omittedBytes > 0);
  assert.ok(result.omittedPathCount > 0);
  assert.ok(result.paths.some((entry) => entry.patchTruncated && entry.omittedBytes > 0));
});

test('binary conflicts report an honest no-line-range diagnostic', async (t) => {
  const root = createRepo(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  const before = commit(root, 'binary before', ['binary.dat']);
  fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0, 4, 2, 3]));
  const after = commit(root, 'binary turn', ['binary.dat']);
  fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0, 5, 2, 3]));
  git(root, 'add', '--', 'binary.dat');
  const result = await planUndoMerge({ cwd: root, beforeOid: before, afterOid: after,
    requestedPaths: ['binary.dat'], witnessedPaths: ['binary.dat'] }, deps);
  assert.equal(result.kind, 'conflicted');
  if (result.kind !== 'conflicted') return;
  assert.match(result.paths[0].patch ?? '', /^Binary conflict; text line ranges unavailable\./);
  assert.doesNotMatch(result.paths[0].patch ?? '', /^@@/m);
});

test('turn add plans deletion and turn delete plans inverse addition', async (t) => {
  const addRoot = createRepo(); t.after(() => fs.rmSync(addRoot, { recursive: true, force: true }));
  write(addRoot, 'anchor.txt', 'anchor\n');
  const addBefore = commit(addRoot, 'before add', ['anchor.txt']);
  write(addRoot, 'added.txt', 'turn add\n');
  const addAfter = commit(addRoot, 'turn add', ['added.txt']);
  const addPlan = await planUndoMerge({ cwd: addRoot, beforeOid: addBefore, afterOid: addAfter,
    requestedPaths: ['added.txt'], witnessedPaths: ['added.txt'] }, deps);
  assert.equal(addPlan.kind, 'ready');
  if (addPlan.kind === 'ready') assert.equal(addPlan.paths[0].result, null);

  const deleteRoot = createRepo(); t.after(() => fs.rmSync(deleteRoot, { recursive: true, force: true }));
  write(deleteRoot, 'deleted.txt', 'restore me\n');
  const deleteBefore = commit(deleteRoot, 'before delete', ['deleted.txt']);
  fs.unlinkSync(path.join(deleteRoot, 'deleted.txt')); git(deleteRoot, 'add', '--', 'deleted.txt');
  git(deleteRoot, 'commit', '-m', 'turn delete'); const deleteAfter = git(deleteRoot, 'rev-parse', 'HEAD');
  const deletePlan = await planUndoMerge({ cwd: deleteRoot, beforeOid: deleteBefore, afterOid: deleteAfter,
    requestedPaths: ['deleted.txt'], witnessedPaths: ['deleted.txt'] }, deps);
  assert.equal(deletePlan.kind, 'ready');
  if (deletePlan.kind === 'ready') {
    assert.equal(deletePlan.paths[0].result?.blobOid, git(deleteRoot, 'rev-parse', `${deleteBefore}:deleted.txt`));
  }
});

test('complete witnessed rename is atomic and restores both endpoints', async (t) => {
  const root = createRepo(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'old.txt', 'same rename content\n');
  const before = commit(root, 'before rename', ['old.txt']);
  fs.renameSync(path.join(root, 'old.txt'), path.join(root, 'new.txt'));
  git(root, 'add', '--', 'old.txt', 'new.txt'); git(root, 'commit', '-m', 'rename');
  const after = git(root, 'rev-parse', 'HEAD');
  const result = await planUndoMerge({ cwd: root, beforeOid: before, afterOid: after,
    requestedPaths: ['old.txt', 'new.txt'], witnessedPaths: ['old.txt', 'new.txt'] }, deps);
  assert.equal(result.kind, 'ready');
  if (result.kind === 'ready') {
    assert.deepEqual(result.renameGroups, [['old.txt', 'new.txt']]);
    assert.ok(result.paths.find((entry) => entry.path === 'old.txt')?.result);
    assert.equal(result.paths.find((entry) => entry.path === 'new.txt')?.result, null);
  }
});

test('incomplete and unwitnessed rename pairs refuse before merge-tree', async (t) => {
  const root = createRepo(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'old.txt', 'rename content\n');
  const before = commit(root, 'before rename', ['old.txt']);
  fs.renameSync(path.join(root, 'old.txt'), path.join(root, 'new.txt'));
  git(root, 'add', '--', 'old.txt', 'new.txt'); git(root, 'commit', '-m', 'rename');
  const after = git(root, 'rev-parse', 'HEAD');
  let mergeCalls = 0;
  const guardedDeps: UndoMergePlannerDeps = { ...deps, runMergeTreeCore: async () => {
    mergeCalls += 1; throw new Error('merge must not run');
  } };
  const incomplete = await planUndoMerge({ cwd: root, beforeOid: before, afterOid: after,
    requestedPaths: ['new.txt'], witnessedPaths: ['old.txt', 'new.txt'] }, guardedDeps);
  assert.equal(incomplete.kind, 'refused');
  assert.equal(pathState(incomplete, 'new.txt'), 'rename-pair-incomplete');
  const unwitnessed = await planUndoMerge({ cwd: root, beforeOid: before, afterOid: after,
    requestedPaths: ['old.txt', 'new.txt'], witnessedPaths: ['new.txt'] }, guardedDeps);
  assert.equal(unwitnessed.kind, 'refused');
  assert.equal(pathState(unwitnessed, 'old.txt'), 'not-witnessed-for-undo');
  assert.equal(mergeCalls, 0);
});

test('mode-only changes retain explicit modes in synthetic trees', async (t) => {
  const root = createRepo(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'tool.sh', '#!/bin/sh\necho ok\n');
  const before = commit(root, 'before mode', ['tool.sh']);
  git(root, 'update-index', '--chmod=+x', '--', 'tool.sh'); git(root, 'commit', '-m', 'mode change');
  const after = git(root, 'rev-parse', 'HEAD');
  const result = await planUndoMerge({ cwd: root, beforeOid: before, afterOid: after,
    requestedPaths: ['tool.sh'], witnessedPaths: ['tool.sh'] }, deps);
  assert.equal(result.kind, 'ready');
  if (result.kind === 'ready') assert.equal(result.paths[0].result?.mode, '100644');
});

test('symlink entries and custom filters have distinct pre-merge refusal states', async (t) => {
  const linkRoot = createRepo(); t.after(() => fs.rmSync(linkRoot, { recursive: true, force: true }));
  write(linkRoot, 'link', 'plain\n');
  const linkBefore = commit(linkRoot, 'before symlink', ['link']);
  const targetOid = git(linkRoot, 'hash-object', '-w', '--stdin');
  // hash-object --stdin above receives empty stdin; its blob is sufficient for a tree-only symlink entry.
  git(linkRoot, 'update-index', '--cacheinfo', '120000', targetOid, 'link');
  git(linkRoot, 'commit', '-m', 'symlink entry'); const linkAfter = git(linkRoot, 'rev-parse', 'HEAD');
  const linkPlan = await planUndoMerge({ cwd: linkRoot, beforeOid: linkBefore, afterOid: linkAfter,
    requestedPaths: ['link'], witnessedPaths: ['link'] }, deps);
  assert.equal(linkPlan.kind, 'refused');
  assert.equal(pathState(linkPlan, 'link'), 'unsupported-symlink');

  const filterRoot = createRepo(); t.after(() => fs.rmSync(filterRoot, { recursive: true, force: true }));
  write(filterRoot, '.gitattributes', 'filtered.txt filter=example\n'); write(filterRoot, 'filtered.txt', 'before\n');
  const filterBefore = commit(filterRoot, 'before filter', ['.gitattributes', 'filtered.txt']);
  write(filterRoot, 'filtered.txt', 'after\n'); const filterAfter = commit(filterRoot, 'after filter', ['filtered.txt']);
  const filterPlan = await planUndoMerge({ cwd: filterRoot, beforeOid: filterBefore, afterOid: filterAfter,
    requestedPaths: ['filtered.txt'], witnessedPaths: ['filtered.txt'] }, deps);
  assert.equal(filterPlan.kind, 'refused');
  assert.equal(pathState(filterPlan, 'filtered.txt'), 'unsupported-content-conversion');
});

test('ignored and untracked-collision paths receive explicit conservative states', async (t) => {
  const ignoredRoot = createRepo(); t.after(() => fs.rmSync(ignoredRoot, { recursive: true, force: true }));
  write(ignoredRoot, '.gitignore', 'ignored.txt\n'); write(ignoredRoot, 'ignored.txt', 'before\n');
  git(ignoredRoot, 'add', '-f', '--', '.gitignore', 'ignored.txt'); git(ignoredRoot, 'commit', '-m', 'before');
  const ignoredBefore = git(ignoredRoot, 'rev-parse', 'HEAD');
  write(ignoredRoot, 'ignored.txt', 'after\n'); git(ignoredRoot, 'add', '-f', '--', 'ignored.txt'); git(ignoredRoot, 'commit', '-m', 'after');
  const ignoredAfter = git(ignoredRoot, 'rev-parse', 'HEAD');
  const ignored = await planUndoMerge({ cwd: ignoredRoot, beforeOid: ignoredBefore, afterOid: ignoredAfter,
    requestedPaths: ['ignored.txt'], witnessedPaths: ['ignored.txt'] }, deps);
  assert.equal(pathState(ignored, 'ignored.txt'), 'ignored');

  const collisionRoot = createRepo(); t.after(() => fs.rmSync(collisionRoot, { recursive: true, force: true }));
  write(collisionRoot, 'collision.txt', 'turn-owned\n');
  const collisionBefore = commit(collisionRoot, 'before delete', ['collision.txt']);
  fs.unlinkSync(path.join(collisionRoot, 'collision.txt')); git(collisionRoot, 'add', '--', 'collision.txt');
  git(collisionRoot, 'commit', '-m', 'delete'); const collisionAfter = git(collisionRoot, 'rev-parse', 'HEAD');
  write(collisionRoot, 'collision.txt', 'independent untracked file\n');
  const collision = await planUndoMerge({ cwd: collisionRoot, beforeOid: collisionBefore, afterOid: collisionAfter,
    requestedPaths: ['collision.txt'], witnessedPaths: ['collision.txt'] }, deps);
  assert.equal(pathState(collision, 'collision.txt'), 'index-worktree-diverged');
});

test('conflict filtering marks only staged conflict paths and previews other merged paths', async (t) => {
  const root = createRepo(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'conflict.txt', lines()); write(root, 'clean.txt', lines());
  const before = commit(root, 'before', ['conflict.txt', 'clean.txt']);
  write(root, 'conflict.txt', lines({ 1: 'TURN' })); write(root, 'clean.txt', lines({ 1: 'TURN' }));
  const after = commit(root, 'turn', ['conflict.txt', 'clean.txt']);
  write(root, 'conflict.txt', lines({ 1: 'LATER-CONFLICT' }));
  write(root, 'clean.txt', lines({ 1: 'TURN', 40: 'LATER-CLEAN' }));
  git(root, 'add', '--', 'conflict.txt', 'clean.txt');
  const result = await planUndoMerge({ cwd: root, beforeOid: before, afterOid: after,
    requestedPaths: ['conflict.txt', 'clean.txt'], witnessedPaths: ['conflict.txt', 'clean.txt'] }, deps);
  assert.equal(result.kind, 'conflicted');
  assert.equal(pathState(result, 'conflict.txt'), 'conflicted');
  assert.equal(pathState(result, 'clean.txt'), 'merged');
  assert.equal(result.paths.find((entry) => entry.path === 'clean.txt')?.conflictStages.length, 0);
});
