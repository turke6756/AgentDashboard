import assert from 'node:assert/strict';
import test from 'node:test';

import { computeIndexFingerprint } from './index-fingerprint';
import { createPreviewRoutes } from './preview-routes';
import { PinnedSnapshotStore, fingerprintFor } from './pinned-snapshot-store';
import type { DirtyEntry, EncodedGitPath } from '../../shared/commit-candidates';
import type { CandidateInventoryRead } from './candidate-service';

const path: EncodedGitPath = { pathBytesBase64: Buffer.from('a.txt').toString('base64'), displayPath: 'a.txt', utf8Clean: true };
const rawOid = '1'.repeat(40);
const headOid = '2'.repeat(40);
const indexOid = '3'.repeat(40);
const changedOid = '4'.repeat(40);

function entry(rawWorktreeBlobOid = rawOid): DirtyEntry {
  return {
    entryId: 'e1', path, originalPath: null, entryKind: 'ordinary', indexStatus: '.', worktreeStatus: 'M',
    headMode: '100644', indexMode: '100644', worktreeMode: '100644', submoduleState: null,
    renameOrCopyScore: null, expectedWorktreeState: 'present', rawWorktreeBlobOid,
    gitLevelEligibility: 'supported', commitPathspecs: [path],
  };
}

function stage(): Buffer {
  return Buffer.concat([Buffer.from(`100644 ${indexOid} 0\t`, 'ascii'), Buffer.from('a.txt'), Buffer.from([0])]);
}

async function harness(treeOid = rawOid, livePolicy = 0) {
  const index = await computeIndexFingerprint({
    repoRoot: '/repo', runGitBytes: async () => ({ code: 0, stdout: stage(), stderr: '' }), withWriteTree: false,
  });
  const store = new PinnedSnapshotStore();
  const descriptor = {
    repositoryKey: 'repo', targetWorkspaceId: 'ws', policyGeneration: 0, pinnedHeadOid: headOid,
    indexFingerprint: index.fingerprint, scopePathspecBytes: null,
    boundaryInputs: { completeness: 'complete' as const, stopReasons: [] }, entries: [entry()],
    grouping: [{ saveUnitId: 'component:c1', saveUnitKind: 'named-save-set', memberEntryIds: ['e1'] }],
    intentUnits: [], fallbackUnits: [], componentEntryIds: { c1: ['e1'] }, unattributedEntryIds: [], stability: 'stable' as const,
  };
  const pinned = store.publish(descriptor);
  let assembleCalls = 0;
  let captures = 0;
  const routes = createPreviewRoutes({
    gitExe: 'git', pinnedSnapshotStore: store, getWorkspaces: () => [{ id: 'ws', path: '/repo' }],
    probeWorkspaceGit: async () => ({ resolution: 'repository', repoState: 'repository', repoRoot: '/repo', commonDir: '/repo/.git',
      commonDirQueueKey: 'repo', workspacePrefix: '', gitVersion: '2', supportsPathspecFromFile: true } as never),
    resolvePolicyGeneration: () => livePolicy,
    assembleInventory: async () => { assembleCalls++; return {} as CandidateInventoryRead; },
    runGit: async (_cwd, args) => ({ code: 0, stdout: args[0] === 'rev-parse' ? `${headOid}\n` : '', stderr: '' }),
    runGitBytes: async (_cwd, args) => args[0] === 'ls-tree'
      ? { code: 0, stdout: Buffer.from(`100644 blob ${treeOid}\ta.txt\0`), stderr: '' }
      : { code: 0, stdout: stage(), stderr: '' },
    captureFinalizationBoundary: async () => { captures++; return { oid: '5'.repeat(40), treeOid }; },
  });
  return { routes, pinned, assembleCalls: () => assembleCalls, captures: () => captures };
}

test('pinned happy path resolves without assembleScope and verifies the raw boundary', async () => {
  const h = await harness();
  const context = await h.routes.saveCardFinalizeRoutes.resolveBoundary({
    saveUnitId: 'component:c1', saveUnitKind: 'named-save-set', targetWorkspaceId: 'ws',
    repositoryKey: 'repo', pinnedSnapshotId: h.pinned.snapshotId,
    pinnedSnapshotFingerprint: h.pinned.boundaryInputFingerprint,
  });
  assert.equal(context.boundaryOid, '5'.repeat(40));
  assert.equal(h.assembleCalls(), 0);
  assert.equal(h.captures(), 1);
});

test('snapshot-gone refuses before old-ID resolution or capture', async () => {
  const h = await harness();
  await assert.rejects(() => h.routes.saveCardFinalizeRoutes.resolveBoundary({
    saveUnitId: 'component:c1', saveUnitKind: 'named-save-set', targetWorkspaceId: 'ws',
    repositoryKey: 'repo', pinnedSnapshotId: 'gone', pinnedSnapshotFingerprint: fingerprintFor('gone'),
  }), (error: unknown) => (error as { code?: string }).code === 'snapshot-gone');
  assert.equal(h.assembleCalls(), 0);
  assert.equal(h.captures(), 0);
});

test('wrong repository is rejected before capture', async () => {
  const h = await harness();
  await assert.rejects(() => h.routes.saveCardFinalizeRoutes.resolveBoundary({
    saveUnitId: 'component:c1', saveUnitKind: 'named-save-set', targetWorkspaceId: 'ws', repositoryKey: 'other',
    pinnedSnapshotId: h.pinned.snapshotId, pinnedSnapshotFingerprint: h.pinned.boundaryInputFingerprint,
  }), (error: unknown) => (error as { code?: string }).code === 'snapshot-stale');
  assert.equal(h.captures(), 0);
});

test('wrong workspace is rejected before capture', async () => {
  const h = await harness();
  await assert.rejects(() => h.routes.saveCardFinalizeRoutes.resolveBoundary({
    saveUnitId: 'component:c1', saveUnitKind: 'named-save-set', targetWorkspaceId: 'other', repositoryKey: 'repo',
    pinnedSnapshotId: h.pinned.snapshotId, pinnedSnapshotFingerprint: h.pinned.boundaryInputFingerprint,
  }), (error: unknown) => (error as { code?: string }).code === 'snapshot-stale');
  assert.equal(h.captures(), 0);
});

test('fingerprint mismatch is rejected before capture', async () => {
  const h = await harness();
  await assert.rejects(() => h.routes.saveCardFinalizeRoutes.resolveBoundary({
    saveUnitId: 'component:c1', saveUnitKind: 'named-save-set', targetWorkspaceId: 'ws', repositoryKey: 'repo',
    pinnedSnapshotId: h.pinned.snapshotId, pinnedSnapshotFingerprint: 'wrong',
  }), (error: unknown) => (error as { code?: string }).code === 'snapshot-stale');
  assert.equal(h.captures(), 0);
});

test('live policy generation mismatch is rejected before capture', async () => {
  const h = await harness(rawOid, 1);
  await assert.rejects(() => h.routes.saveCardFinalizeRoutes.resolveBoundary({
    saveUnitId: 'component:c1', saveUnitKind: 'named-save-set', targetWorkspaceId: 'ws', repositoryKey: 'repo',
    pinnedSnapshotId: h.pinned.snapshotId, pinnedSnapshotFingerprint: h.pinned.boundaryInputFingerprint,
  }), (error: unknown) => (error as { code?: string }).code === 'snapshot-stale');
  assert.equal(h.captures(), 0);
});

test('member mutation after preflight is captured but refuses before finalization', async () => {
  const h = await harness(changedOid);
  await assert.rejects(() => h.routes.saveCardFinalizeRoutes.resolveBoundary({
    saveUnitId: 'component:c1', saveUnitKind: 'named-save-set', targetWorkspaceId: 'ws',
    repositoryKey: 'repo', pinnedSnapshotId: h.pinned.snapshotId,
    pinnedSnapshotFingerprint: h.pinned.boundaryInputFingerprint,
  }), (error: unknown) => (error as { code?: string }).code === 'snapshot-stale');
  assert.equal(h.captures(), 1);
  assert.equal(h.assembleCalls(), 0);
});
