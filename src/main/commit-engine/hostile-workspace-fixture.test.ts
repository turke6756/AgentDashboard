// WP-H — small, programmatically-built hostile real-Git fixture.
//
// Nothing here is checked into the repository. The fixture combines a long path,
// a raw non-UTF-8 index path, a recognized-but-not-excluded directory, and a
// logically oversized sparse file without creating thousands of files or reading
// the sparse payload into JavaScript.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MAX_CHECKPOINT_BYTES } from '../../shared/constants';
import { enumerateScope } from '../git-checkpoints/checkpoint-gating';
import { runGit, runGitBytes } from '../git-checkpoints/git-command';
import { resolveInternalGit } from '../git/git-runtime';
import { produceDirtyInventory } from './dirty-inventory';

interface Fixture {
  gitExe: string;
  root: string;
  longRelative: string;
  nonUtf8Path: Buffer;
  sparseRelative: string;
}

function git(fixture: Pick<Fixture, 'gitExe' | 'root'>, args: string[], input?: Buffer): Buffer {
  return execFileSync(fixture.gitExe, args, {
    cwd: fixture.root,
    input,
    encoding: 'buffer',
    maxBuffer: 16 << 20,
  });
}

async function createFixture(): Promise<Fixture> {
  const resolved = await resolveInternalGit();
  if (!resolved) throw new Error('WP-H hostile fixture requires compatible Git');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp-h-hostile-'));
  const fixture: Fixture = {
    gitExe: resolved.execPath,
    root,
    longRelative: [...Array.from({ length: 7 }, (_, index) => `segment-${index}-${'x'.repeat(14)}`), 'tracked.txt'].join('/'),
    nonUtf8Path: Buffer.from([0x72, 0x61, 0x77, 0x2d, 0x80, 0x2d, 0x70, 0x61, 0x74, 0x68, 0x2e, 0x62, 0x69, 0x6e]),
    sparseRelative: 'oversized-sparse.bin',
  };

  git(fixture, ['init', '-q']);
  git(fixture, ['config', 'user.name', 'WP-H Hostile Fixture']);
  git(fixture, ['config', 'user.email', 'wp-h@example.invalid']);
  git(fixture, ['config', 'commit.gpgsign', 'false']);
  if (process.platform === 'win32') git(fixture, ['config', 'core.longpaths', 'true']);

  const longAbsolute = path.join(root, ...fixture.longRelative.split('/'));
  fs.mkdirSync(path.dirname(longAbsolute), { recursive: true });
  fs.writeFileSync(longAbsolute, 'base\n');
  git(fixture, ['add', '--', fixture.longRelative]);

  // Add the raw path and sparse placeholder through the NUL-framed index plumbing
  // seam: JavaScript strings cannot faithfully carry the non-UTF-8 path.
  const emptyOid = git(fixture, ['hash-object', '-w', '--stdin'], Buffer.alloc(0)).toString('ascii').trim();
  const indexInfo = Buffer.concat([
    Buffer.from(`100644 ${emptyOid}\t`, 'ascii'), fixture.nonUtf8Path, Buffer.from([0]),
    Buffer.from(`100644 ${emptyOid}\t${fixture.sparseRelative}`, 'ascii'), Buffer.from([0]),
  ]);
  git(fixture, ['update-index', '-z', '--index-info'], indexInfo);
  git(fixture, ['commit', '-q', '-m', 'hostile base']);

  // Keep the logically huge sparse file out of dirty hashing while retaining it
  // in the tracked scope enumerator. The index contains the empty blob; skip-
  // worktree makes status ignore the intentionally different sparse worktree file.
  git(fixture, ['update-index', '--skip-worktree', '--', fixture.sparseRelative]);
  const sparsePath = path.join(root, fixture.sparseRelative);
  const fd = fs.openSync(sparsePath, 'w');
  try {
    fs.writeSync(fd, Buffer.from([0x01]), 0, 1, MAX_CHECKPOINT_BYTES);
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(fs.statSync(sparsePath).size, MAX_CHECKPOINT_BYTES + 1);

  fs.appendFileSync(longAbsolute, 'modified\n');
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'generated.js'), 'generated\n');
  return fixture;
}

function cleanup(fixture: Fixture): void {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test('real Git preserves hostile path bytes and inventory completeness', async () => {
  const fixture = await createFixture();
  try {
    const inventory = await produceDirtyInventory({
      repoRoot: fixture.root,
      workspacePrefix: '',
      repository: {
        repositoryKey: 'hostile-repository', objectDatabaseKey: 'hostile-objects',
        gitObjectFormat: 'sha1', bareRepo: false,
        workspaces: [{ workspaceId: 'workspace', workspacePrefix: '' }],
      },
      runGit: (cwd, args, options) => runGit(cwd, args, { ...options, gitExe: fixture.gitExe }),
      runGitBytes: (cwd, args, options) => runGitBytes(cwd, args, { ...options, gitExe: fixture.gitExe }),
      gitExe: fixture.gitExe,
      deadlineAt: Date.now() + 30_000,
    });
    assert.equal(inventory.completeness, 'complete');
    assert.equal(inventory.totalsExact, true);

    const raw = inventory.entries.find((entry) =>
      Buffer.from(entry.path.pathBytesBase64, 'base64').equals(fixture.nonUtf8Path));
    assert.ok(raw, 'the real porcelain stream preserves the non-UTF-8 index path byte-for-byte');
    assert.equal(raw.path.utf8Clean, false);
    assert.equal(raw.expectedWorktreeState, 'absent');

    assert.ok(inventory.entries.some((entry) => entry.path.displayPath === fixture.longRelative));
    assert.ok(inventory.entries.some((entry) => entry.path.displayPath === 'node_modules/generated.js'),
      'a recognized path remains visible in the dirty inventory');

    const oversized = await enumerateScope({
      repoRoot: fixture.root,
      workspacePrefix: '',
      runGit: (cwd, args, options) => runGit(cwd, args, { ...options, gitExe: fixture.gitExe }),
      gitExe: fixture.gitExe,
    });
    assert.deepEqual(oversized.kind, 'skipped');
    if (oversized.kind === 'skipped') {
      assert.equal(oversized.reason, 'oversized');
      assert.ok(oversized.observed.bytes > MAX_CHECKPOINT_BYTES);
    }
  } finally {
    cleanup(fixture);
  }
});
