import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type { GitRunBytesResult, GitRunResult, RunGitOptions } from './git-command';
import { runMergeTreeCore } from './merge-tree-core';

function exec(cwd: string, args: string[], opts: RunGitOptions, bytes: true): Promise<GitRunBytesResult>;
function exec(cwd: string, args: string[], opts: RunGitOptions, bytes?: false): Promise<GitRunResult>;
function exec(cwd: string, args: string[], opts: RunGitOptions, bytes = false): Promise<GitRunResult | GitRunBytesResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...opts.env, ...(opts.indexFile ? { GIT_INDEX_FILE: opts.indexFile } : {}) };
    const child = execFile('git', args, { cwd, env, windowsHide: true, encoding: bytes ? 'buffer' : 'utf8',
      timeout: opts.timeoutMs, maxBuffer: opts.maxBytes }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
        ? (error as NodeJS.ErrnoException & { code: number }).code : error ? 1 : 0;
      if (error && !opts.allowNonzero) reject(error);
      else resolve({ code, stdout: bytes ? Buffer.from(stdout as Buffer) : String(stdout), stderr: String(stderr) } as GitRunResult & GitRunBytesResult);
    });
    child.stdin?.end(opts.stdin);
  });
}
const runGit = (cwd: string, args: string[], opts: RunGitOptions) => exec(cwd, args, opts);
const runGitBytes = (cwd: string, args: string[], opts: RunGitOptions) => exec(cwd, args, opts, true);
const git = (cwd: string, ...args: string[]) => String(execFileSync('git', args, { cwd, windowsHide: true })).trim();

function repository(): { root: string; base: string; current: string; incoming: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-merge-core-test-'));
  git(root, 'init'); git(root, 'config', 'user.email', 'test@lares.local'); git(root, 'config', 'user.name', 'Lares Test');
  git(root, 'config', 'core.autocrlf', 'false');
  const lines = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`);
  fs.writeFileSync(path.join(root, 'shared.txt'), `${lines.join('\n')}\n`);
  git(root, 'add', '.'); git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'shared.txt'), `${lines.map((line, index) => index === 0 ? 'CURRENT' : line).join('\n')}\n`);
  git(root, 'commit', '-am', 'current'); const current = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '--detach', base);
  fs.writeFileSync(path.join(root, 'shared.txt'), `${lines.map((line, index) => index === 39 ? 'INCOMING' : line).join('\n')}\n`);
  git(root, 'commit', '-am', 'incoming'); const incoming = git(root, 'rev-parse', 'HEAD');
  return { root, base, current, incoming };
}

test('real repository clean merge has exit 0 and an apply-safe result tree', async (t) => {
  const repo = repository(); t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }));
  const result = await runMergeTreeCore({ cwd: repo.root, baseOid: repo.base,
    currentOid: repo.current, incomingOid: repo.incoming }, { runGit, runGitBytes });
  assert.equal(result.kind, 'clean');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.stages, []);
  assert.match(git(repo.root, 'show', `${result.applyTreeOid}:shared.txt`), /^CURRENT[\s\S]*INCOMING$/);
});

test('real repository conflict preserves stages 1/2/3 and never offers the exit-1 tree for apply', async (t) => {
  const repo = repository(); t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }));
  git(repo.root, 'checkout', '--detach', repo.base);
  const baseText = fs.readFileSync(path.join(repo.root, 'shared.txt'), 'utf8');
  fs.writeFileSync(path.join(repo.root, 'shared.txt'), baseText.replace('line-1', 'INCOMING-CONFLICT'));
  git(repo.root, 'commit', '-am', 'incoming conflict'); const incoming = git(repo.root, 'rev-parse', 'HEAD');
  const result = await runMergeTreeCore({ cwd: repo.root, baseOid: repo.base,
    currentOid: repo.current, incomingOid: incoming }, { runGit, runGitBytes });
  assert.equal(result.kind, 'conflicted');
  if (result.kind !== 'conflicted') return;
  assert.equal(result.exitCode, 1);
  assert.equal(result.applyTreeOid, null);
  assert.deepEqual(result.stages.map((stage) => stage.stage), [1, 2, 3]);
  assert.deepEqual(result.stages.map((stage) => stage.blobOid), [
    git(repo.root, 'rev-parse', `${repo.base}:shared.txt`),
    git(repo.root, 'rev-parse', `${repo.current}:shared.txt`),
    git(repo.root, 'rev-parse', `${incoming}:shared.txt`),
  ]);
  assert.match(git(repo.root, 'show', `${result.diagnosticTreeOid}:shared.txt`), /<<<<<<<|>>>>>>>/);

  const resolved = await runMergeTreeCore({ cwd: repo.root, baseOid: repo.base,
    currentOid: repo.current, incomingOid: incoming, resolutions: [{
      pathBytesBase64: Buffer.from('shared.txt').toString('base64'),
      blobOid: git(repo.root, 'rev-parse', `${incoming}:shared.txt`),
    }] }, { runGit, runGitBytes });
  assert.equal(resolved.kind, 'resolved');
  if (resolved.kind === 'resolved') {
    assert.notEqual(resolved.applyTreeOid, resolved.diagnosticTreeOid);
    assert.equal(git(repo.root, 'rev-parse', `${resolved.applyTreeOid}:shared.txt`),
      git(repo.root, 'rev-parse', `${incoming}:shared.txt`));
  }
});

test('exit codes above 1 are exposed as failed and cannot be apply-safe', async () => {
  const oid = '1'.repeat(40);
  const result = await runMergeTreeCore({ cwd: '.', baseOid: oid, currentOid: oid, incomingOid: oid }, {
    runGitBytes: async () => ({ code: 128, stdout: Buffer.alloc(0), stderr: 'fatal test failure' }),
  });
  assert.deepEqual(result, { kind: 'failed', exitCode: 128, reason: 'fatal test failure', applyTreeOid: null });
});

test('exit 1 without neutral stage records is rejected instead of becoming applicable', async () => {
  const oid = '1'.repeat(40);
  await assert.rejects(runMergeTreeCore({ cwd: '.', baseOid: oid, currentOid: oid, incomingOid: oid }, {
    runGitBytes: async () => ({ code: 1, stdout: Buffer.from(`${oid}\0`), stderr: '' }),
  }), /merge-tree-conflict-result-missing-stages/);
});

test('malformed stage-looking records fail strict result validation', async () => {
  const oid = '1'.repeat(40);
  await assert.rejects(runMergeTreeCore({ cwd: '.', baseOid: oid, currentOid: oid, incomingOid: oid }, {
    runGitBytes: async () => ({ code: 0,
      stdout: Buffer.from(`${oid}\x00999999 ${oid} 2\tbroken.txt\x00`), stderr: '' }),
  }), /merge-tree-stage-record-invalid/);
});
