// While-you-were-away WP-G2: pure after-image gate fixtures for spec C/D/F/P/R.
// Run after `npm run build:main`.

import assert from 'node:assert/strict';

import type { LstatInfo } from './checkpoint-gating';
import type { CheckpointTurnStore } from './checkpoint-service';
import {
  checkAfterSnapshot,
  type AfterSnapshotTurnStore,
  type CheckAfterSnapshotInput,
} from './after-snapshot-gate';
import type { ConcurrencyRunGit } from './concurrency-policy';

interface TestCase { name: string; run(): Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void>): void { tests.push({ name, run }); }

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

function stat(kind: 'regular' | 'symlink' | 'directory'): LstatInfo {
  return {
    isFile: kind === 'regular',
    isSymbolicLink: kind === 'symlink',
    isDirectory: kind === 'directory',
    isFIFO: false,
    isSocket: false,
    isCharacterDevice: false,
    isBlockDevice: false,
    mode: 0,
    size: 1,
  };
}

type Turn = ReturnType<CheckpointTurnStore['listLaterTurnsWitnessingPath']>[number];
function laterTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'later-2', workspaceId: 'ws', turnSeq: 2,
    agentId: 'agent-2', agentTitle: 'Agent Two', ownerAgentId: null,
    ownerBrickGeneration: null, sessionId: null, taskLabel: 'Follow-up',
    startedAt: 20, endedAt: 30, status: 'accepted',
    beforeOid: null, afterOid: null, beforeRef: null, afterRef: null,
    beforeReady: false, afterReady: false, beforeQuality: null, afterQuality: null,
    beforeRawFilterBypassed: false, beforeFilteredPaths: null,
    beforePrunedAt: null, afterPrunedAt: null, touched: null,
    diffStats: null, compactDiff: null, compactDiffProvenance: null,
    failureReason: null,
    ...overrides,
  };
}

function gitResult(stdout: string, code = 0): ConcurrencyRunGit {
  return async () => ({ code, stdout, stderr: code === 0 ? '' : 'missing commit' });
}

function base(overrides: Partial<CheckAfterSnapshotInput> = {}): CheckAfterSnapshotInput {
  return {
    repoRoot: 'C:/repo', gitExe: 'git', workspaceId: 'ws',
    turnId: 'target-1', turnSeq: 1, afterOid: 'c'.repeat(40),
    afterEdgeUsable: true, paths: ['file.txt'],
    store: { listLaterTurnsWitnessingPath: () => [] } satisfies AfterSnapshotTurnStore,
    runGit: gitResult(`100644 blob ${OID_A}\tfile.txt\n`),
    lstatPath: () => stat('regular'),
    hashPaths: async () => new Map([['file.txt', OID_A]]),
    ...overrides,
  };
}

test('C: identical later rewrite and chmod-only mode change still match', async () => {
  const result = await checkAfterSnapshot(base({
    runGit: gitResult(`100755 blob ${OID_A}\tfile.txt\n`),
    store: { listLaterTurnsWitnessingPath: () => [laterTurn()] },
  }));
  assert.deepEqual(result, { ok: true });
});

test('D: changed bytes with no later row produce one external blocker', async () => {
  const result = await checkAfterSnapshot(base({
    hashPaths: async () => new Map([['file.txt', OID_B]]),
  }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureReason, 'after-snapshot-overlap');
  assert.deepEqual('overlap' in result ? result.overlap.files : null, [
    { path: 'file.txt', blockers: [{ kind: 'external' }] },
  ]);
});

test('F: unusable after edge, failed ls-tree, non-blob, and gitlink fail closed', async () => {
  const fixtures: CheckAfterSnapshotInput[] = [
    base({ afterEdgeUsable: false }),
    base({ runGit: gitResult('', 128) }),
    base({ runGit: gitResult(`${'040000'} tree ${OID_A}\tfile.txt\n`) }),
    base({ runGit: gitResult(`160000 commit ${OID_A}\tfile.txt\n`) }),
    base({ runGit: gitResult(`160000 blob ${OID_A}\tfile.txt\n`) }),
  ];
  for (const fixture of fixtures) {
    const result = await checkAfterSnapshot(fixture);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.failureReason, 'after-edge-unusable');
    assert.deepEqual('overlap' in result ? result.overlap : null, {
      reason: 'after-edge-unusable', files: [],
    });
  }
});

test('D1 absence table distinguishes absent matches from present replacements', async () => {
  const absent = base({
    runGit: gitResult(''), lstatPath: () => null,
    hashPaths: async () => new Map(),
  });
  assert.deepEqual(await checkAfterSnapshot(absent), { ok: true });

  const replaced = await checkAfterSnapshot({
    ...absent,
    lstatPath: () => stat('directory'),
  });
  assert.equal(replaced.ok, false);
  if (!replaced.ok) assert.equal(replaced.failureReason, 'after-snapshot-overlap');
});

test('P: same OID regular-to-symlink swap is overlap and names later turns once', async () => {
  const duplicate = laterTurn();
  const result = await checkAfterSnapshot(base({
    lstatPath: () => stat('symlink'),
    store: { listLaterTurnsWitnessingPath: () => [duplicate, duplicate, laterTurn({ id: 'target-1' })] },
  }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureReason, 'after-snapshot-overlap');
  assert.deepEqual('overlap' in result ? result.overlap.files[0].blockers : null, [{
    kind: 'later-turn', turnId: 'later-2', turnSeq: 2,
    agentId: 'agent-2', agentTitle: 'Agent Two', taskLabel: 'Follow-up',
    status: 'accepted', endedAt: 30,
  }]);
});

test('R: thrown or incomplete current hashing is distinct and has no overlap payload', async () => {
  for (const hashPaths of [
    async (): Promise<ReadonlyMap<string, string>> => { throw new Error('oid count mismatch'); },
    async (): Promise<ReadonlyMap<string, string>> => new Map(),
  ]) {
    const result = await checkAfterSnapshot(base({ hashPaths }));
    assert.deepEqual(result, { ok: false, failureReason: 'current-hash-failed' });
    assert.equal('overlap' in result, false);
  }
});

void (async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); }
    catch (error) { failed++; console.error(`  FAIL ${t.name}`); console.error(error); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
