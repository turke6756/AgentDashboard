import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPinnedSnapshot } from './pinned-snapshot-build';
import { PinnedSnapshotStore } from './pinned-snapshot-store';

const assembled = () => ({
  repositoryKey: 'repo', targetWorkspaceId: 'workspace', policyGeneration: 3,
  pinnedHeadOid: 'head', indexFingerprint: 'index', scopePathspecBytes: 'scope',
  boundaryInputs: { completeness: 'partial' as const, stopReasons: ['deadline'] },
  entries: [{ path: 'file' }], grouping: [{ saveUnitId: 'u', saveUnitKind: 'task', memberEntryIds: ['e'] }],
  intentUnits: [{ id: 'intent' }], fallbackUnits: [], componentEntryIds: { c: ['e'] },
  unattributedEntryIds: ['unattributed'], stability: 'stable' as const,
});

test('buildPinnedSnapshot carries HEAD, index fingerprint, scope bytes, and boundary inputs', async () => {
  const store = new PinnedSnapshotStore();
  const result = await buildPinnedSnapshot({ store, assemble: assembled });
  assert.equal(result.pinnedHeadOid, 'head');
  assert.equal(result.indexFingerprint, 'index');
  assert.equal(result.scopePathspecBytes, 'scope');
  assert.deepEqual(result.boundaryInputs, { completeness: 'partial', stopReasons: ['deadline'] });
});

test('buildPinnedSnapshot retains all four legacy boundary identities', async () => {
  const store = new PinnedSnapshotStore();
  const result = await buildPinnedSnapshot({ store, assemble: assembled });
  assert.deepEqual(result.intentUnits, [{ id: 'intent' }]);
  assert.deepEqual(result.fallbackUnits, []);
  assert.deepEqual(result.componentEntryIds, { c: ['e'] });
  assert.deepEqual(result.unattributedEntryIds, ['unattributed']);
});

test('identity bracket mismatch publishes unstable without reinvoking producer', async () => {
  const store = new PinnedSnapshotStore();
  let calls = 0;
  let identity = 'before';
  const result = await buildPinnedSnapshot({
    store,
    identityBefore: () => identity,
    assemble: () => { calls += 1; identity = 'after'; return assembled(); },
    identityAfter: () => identity,
  });
  assert.equal(calls, 1, 'the producer must not be retried after a bracket mismatch');
  assert.equal(result.stability, 'unstable');
  assert.equal(store.resolve(result.snapshotId)?.stability, 'unstable');
});
