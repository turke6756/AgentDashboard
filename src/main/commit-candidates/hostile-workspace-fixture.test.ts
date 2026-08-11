// WP-H — small, programmatically-built hostile real-Git fixture.
//
// Nothing here is checked into the repository. The fixture combines a long path,
// a raw non-UTF-8 index path, a recognized-but-not-excluded directory, a marked
// scratch tree, and a logically oversized sparse file without creating thousands
// of files or reading the sparse payload into JavaScript.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { COMMIT_CANDIDATE_CLUTTER_RECOGNITION_PATTERNS, MAX_CHECKPOINT_BYTES } from '../../shared/constants';
import { enumerateScope } from '../git-checkpoints/checkpoint-gating';
import { runGit, runGitBytes } from '../git-checkpoints/git-command';
import { resolveInternalGit } from '../git/git-runtime';
import { produceDirtyInventory } from './dirty-inventory';
import { discoverFirstContactRoots } from './onboarding-discovery';
import {
  LARES_SCRATCH_SENTINEL,
  SCRATCH_POLICY_SCHEMA_VERSION,
  ScratchPolicyStore,
  type ScratchSentinel,
} from './scratch-policy-store';

interface Fixture {
  gitExe: string;
  root: string;
  outside: string;
  store: ScratchPolicyStore;
  longRelative: string;
  scratchRoot: string;
  scratchMember: string;
  nonUtf8Path: Buffer;
  sparseRelative: string;
}

const sentinel: ScratchSentinel = {
  schemaVersion: SCRATCH_POLICY_SCHEMA_VERSION,
  creator: 'wp-h-worker',
  workPackage: 'WP-H',
  disposition: 'disposable',
  creationId: 'wp-h-hostile-fixture',
};

function git(fixture: Pick<Fixture, 'gitExe' | 'root'>, args: string[], input?: Buffer): Buffer {
  return execFileSync(fixture.gitExe, args, {
    cwd: fixture.root,
    input,
    encoding: 'buffer',
    maxBuffer: 16 << 20,
  });
}

function writeSentinel(root: string): void {
  fs.writeFileSync(path.join(root, LARES_SCRATCH_SENTINEL), `${JSON.stringify(sentinel)}\n`, 'utf8');
}

function registerMarked(fixture: Fixture, scratchRoot = fixture.scratchRoot): void {
  fixture.store.registerMarkedScratch({
    repositoryKey: 'hostile-repository',
    repositoryRoot: fixture.root,
    scratchRoot,
    creator: sentinel.creator,
    workPackage: sentinel.workPackage,
    disposition: sentinel.disposition,
    creationId: sentinel.creationId,
  });
}

async function createFixture(): Promise<Fixture> {
  const resolved = await resolveInternalGit();
  if (!resolved) throw new Error('WP-H hostile fixture requires compatible Git');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp-h-hostile-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp-h-outside-'));
  const fixture: Fixture = {
    gitExe: resolved.execPath,
    root,
    outside,
    store: new ScratchPolicyStore(path.join(os.tmpdir(), `lares-wp-h-policy-${path.basename(root)}`)),
    longRelative: [...Array.from({ length: 7 }, (_, index) => `segment-${index}-${'x'.repeat(14)}`), 'tracked.txt'].join('/'),
    scratchRoot: path.join(root, '.lares', 'scratch', 'wp-h'),
    scratchMember: path.join(root, '.lares', 'scratch', 'wp-h', 'tracked-artifact.bin'),
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
  fs.mkdirSync(fixture.scratchRoot, { recursive: true });
  fs.writeFileSync(fixture.scratchMember, 'base\n');
  writeSentinel(fixture.scratchRoot);
  git(fixture, ['add', '--', fixture.longRelative, '.lares/scratch/wp-h']);

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
  fs.appendFileSync(fixture.scratchMember, 'modified\n');
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'generated.js'), 'generated\n');
  return fixture;
}

function cleanup(fixture: Fixture): void {
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.rmSync(fixture.outside, { recursive: true, force: true });
  const storeDirectory = path.join(os.tmpdir(), `lares-wp-h-policy-${path.basename(fixture.root)}`);
  fs.rmSync(storeDirectory, { recursive: true, force: true });
}

test('real Git preserves hostile path bytes and recognition never silently excludes', async () => {
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

    const discovery = await discoverFirstContactRoots({
      repoRoot: fixture.root,
      repositoryKey: 'hostile-repository',
      workspaceKey: 'workspace',
      policyStore: fixture.store,
      runGitBytes: (cwd, args, options) => runGitBytes(cwd, args, { ...options, gitExe: fixture.gitExe }),
      gitExe: fixture.gitExe,
      budgets: { deadlineAt: Date.now() + 30_000 },
    });
    assert.ok(discovery.recommendations.some((item) => item.displayPath === 'node_modules/'));
    assert.equal(COMMIT_CANDIDATE_CLUTTER_RECOGNITION_PATTERNS.includes('node_modules/'), true);
    assert.deepEqual(fixture.store.read('hostile-repository').exclusions, [],
      'recognition labels/suggests only and never writes an exclusion');

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

test('marked exclusion needs registry plus sentinel, keeps tracked changes, and rejects reparse escape', async () => {
  const fixture = await createFixture();
  try {
    const loneRoot = path.join(fixture.root, '.lares', 'scratch', 'lone-sentinel');
    const loneMember = path.join(loneRoot, 'untracked.bin');
    fs.mkdirSync(loneRoot, { recursive: true });
    writeSentinel(loneRoot);
    fs.writeFileSync(loneMember, 'untracked');
    assert.deepEqual(fixture.store.evaluateMarkedMember({
      repositoryKey: 'hostile-repository', repositoryRoot: fixture.root,
      memberPath: loneMember, tracked: false,
    }), { exclude: false, reason: 'unregistered' });

    registerMarked(fixture);
    assert.deepEqual(fixture.store.evaluateMarkedMember({
      repositoryKey: 'hostile-repository', repositoryRoot: fixture.root,
      memberPath: fixture.scratchMember, tracked: true,
    }), { exclude: false, reason: 'tracked' });

    const escapedRoot = path.join(fixture.root, '.lares', 'scratch', 'escaped');
    fs.mkdirSync(escapedRoot, { recursive: true });
    writeSentinel(escapedRoot);
    fs.writeFileSync(path.join(escapedRoot, 'artifact.bin'), 'before');
    registerMarked(fixture, escapedRoot);
    fs.rmSync(escapedRoot, { recursive: true, force: true });
    writeSentinel(fixture.outside);
    fs.writeFileSync(path.join(fixture.outside, 'artifact.bin'), 'outside');
    fs.symlinkSync(fixture.outside, escapedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(fixture.store.evaluateMarkedMember({
      repositoryKey: 'hostile-repository', repositoryRoot: fixture.root,
      memberPath: path.join(escapedRoot, 'artifact.bin'), tracked: false,
    }), { exclude: false, reason: 'unsafe-path' });

    const alias = new ScratchPolicyStore(path.join(os.tmpdir(), `lares-wp-h-policy-${path.basename(fixture.root)}`));
    const rawExclusion = Buffer.from([0x72, 0x61, 0x77, 0x80]);
    fixture.store.setExclusions('hostile-repository', [rawExclusion]);
    assert.deepEqual(alias.read('hostile-repository'), fixture.store.read('hostile-repository'),
      'workspace aliases share one repository-keyed policy record and generation');
  } finally {
    cleanup(fixture);
  }
});
