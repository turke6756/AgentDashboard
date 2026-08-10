import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { COMMIT_CANDIDATE_CLUTTER_RECOGNITION_PATTERNS } from '../../shared/constants';
import {
  LARES_SCRATCH_SENTINEL,
  SCRATCH_POLICY_SCHEMA_VERSION,
  ScratchPolicyStore,
  type ScratchSentinel,
} from './scratch-policy-store';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, run: () => void): void { tests.push({ name, run }); }

function fixture(): { root: string; storeDir: string; scratch: string; member: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-scratch-policy-'));
  const storeDir = path.join(os.tmpdir(), `lares-policy-${path.basename(root)}`);
  const scratch = path.join(root, '.lares', 'scratch', 'wp-e');
  const member = path.join(scratch, 'artifact.bin');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(member, 'disposable');
  return {
    root,
    storeDir,
    scratch,
    member,
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

const sentinel: ScratchSentinel = {
  schemaVersion: SCRATCH_POLICY_SCHEMA_VERSION,
  creator: 'codex-worker',
  workPackage: 'WP-E',
  disposition: 'disposable',
  creationId: 'creation-123',
};

function writeSentinel(root: string, value: unknown = sentinel): void {
  fs.writeFileSync(path.join(root, LARES_SCRATCH_SENTINEL), `${JSON.stringify(value)}\n`, 'utf8');
}

function register(store: ScratchPolicyStore, root: string, scratch: string): void {
  store.registerMarkedScratch({
    repositoryKey: 'repo-key',
    repositoryRoot: root,
    scratchRoot: scratch,
    creator: sentinel.creator,
    workPackage: sentinel.workPackage,
    disposition: sentinel.disposition,
    creationId: sentinel.creationId,
  });
}

test('marked exclusion requires both a valid sentinel and a matching registry record', () => {
  const f = fixture();
  try {
    const store = new ScratchPolicyStore(f.storeDir);
    writeSentinel(f.scratch);
    assert.deepEqual(
      store.evaluateMarkedMember({ repositoryKey: 'repo-key', repositoryRoot: f.root, memberPath: f.member, tracked: false }),
      { exclude: false, reason: 'unregistered' },
      'a lone sentinel proves no ownership',
    );
    register(store, f.root, f.scratch);
    assert.equal(store.evaluateMarkedMember({
      repositoryKey: 'repo-key', repositoryRoot: f.root, memberPath: f.member, tracked: false,
    }).exclude, true);

    writeSentinel(f.scratch, { ...sentinel, creationId: 'forged' });
    assert.deepEqual(
      store.evaluateMarkedMember({ repositoryKey: 'repo-key', repositoryRoot: f.root, memberPath: f.member, tracked: false }),
      { exclude: false, reason: 'invalid-sentinel' },
    );
  } finally { f.cleanup(); }
});

test('tracked modifications beneath a verified marked root always stay visible', () => {
  const f = fixture();
  try {
    const store = new ScratchPolicyStore(f.storeDir);
    writeSentinel(f.scratch);
    register(store, f.root, f.scratch);
    assert.deepEqual(
      store.evaluateMarkedMember({ repositoryKey: 'repo-key', repositoryRoot: f.root, memberPath: f.member, tracked: true }),
      { exclude: false, reason: 'tracked' },
    );
  } finally { f.cleanup(); }
});

test('symlink/reparse-point replacement of a registered scratch root is rejected', () => {
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-scratch-outside-'));
  try {
    const store = new ScratchPolicyStore(f.storeDir);
    writeSentinel(f.scratch);
    register(store, f.root, f.scratch);
    fs.rmSync(f.scratch, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    writeSentinel(outside);
    fs.writeFileSync(path.join(outside, 'artifact.bin'), 'escaped');
    fs.symlinkSync(outside, f.scratch, process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(
      store.evaluateMarkedMember({ repositoryKey: 'repo-key', repositoryRoot: f.root, memberPath: f.member, tracked: false }),
      { exclude: false, reason: 'unsafe-path' },
    );
  } finally {
    f.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('policy is repository-keyed: two workspace projections read identical policy and generation', () => {
  const f = fixture();
  try {
    const workspaceA = new ScratchPolicyStore(f.storeDir);
    const workspaceB = new ScratchPolicyStore(f.storeDir);
    const rawNonUtf8 = Buffer.from([0x66, 0x6f, 0x80, 0x6f]);
    const updated = workspaceA.setExclusions('shared-repository', [Buffer.from('node_modules'), rawNonUtf8]);
    workspaceA.setOnboardingProjection('shared-repository', 'workspace-a', 'exclude-selected', 'fingerprint-a');
    workspaceB.setOnboardingProjection('shared-repository', 'workspace-b', 'keep-everything');

    const fromA = workspaceA.read('shared-repository');
    const fromB = workspaceB.read('shared-repository');
    assert.deepEqual(fromA, fromB, 'workspace aliases read one repository authority');
    assert.equal(fromA.policyGeneration, updated.policyGeneration);
    assert.deepEqual(fromA.exclusions.map((item) => Buffer.from(item.value, 'base64')),
      [rawNonUtf8, Buffer.from('node_modules')].sort(Buffer.compare));
    assert.deepEqual(fromA.onboardingProjections.map((item) => item.workspaceKey).sort(), ['workspace-a', 'workspace-b']);
  } finally { f.cleanup(); }
});

test('recognition list is the binding 27-pattern heuristic and grants no exclusion API', () => {
  assert.equal(COMMIT_CANDIDATE_CLUTTER_RECOGNITION_PATTERNS.length, 27);
  assert.deepEqual(COMMIT_CANDIDATE_CLUTTER_RECOGNITION_PATTERNS.slice(0, 5),
    ['node_modules/', 'dist/', 'build/', 'out/', '__pycache__/']);
  assert.equal(COMMIT_CANDIDATE_CLUTTER_RECOGNITION_PATTERNS.at(-1), 'docs/_build/');
});

let passed = 0;
let failed = 0;
for (const item of tests) {
  try {
    item.run();
    console.log(`  ok  ${item.name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL ${item.name}`);
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
