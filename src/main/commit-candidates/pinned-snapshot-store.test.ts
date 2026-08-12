import assert from 'node:assert/strict';
import test from 'node:test';

import { PinnedSnapshotStore, type PinnedSnapshotDescriptor } from './pinned-snapshot-store';

function descriptor(id: string, bytes = id): Omit<PinnedSnapshotDescriptor, 'snapshotId' | 'boundaryInputFingerprint'> {
  return {
    repositoryKey: 'repo', targetWorkspaceId: 'workspace', policyGeneration: 1,
    pinnedHeadOid: 'head', indexFingerprint: 'index', scopePathspecBytes: null,
    boundaryInputs: { completeness: 'complete', stopReasons: [] }, entries: [bytes],
    grouping: [{ saveUnitId: 'unit', saveUnitKind: 'task', memberEntryIds: ['entry'] }],
    intentUnits: [{ id: 'intent' }], fallbackUnits: [], componentEntryIds: { component: ['entry'] },
    unattributedEntryIds: [], stability: 'stable',
  };
}

test('PinnedSnapshotStore publishes and resolves an immutable descriptor', () => {
  const store = new PinnedSnapshotStore({ maxCount: 10 });
  const handle = store.publish(descriptor('one'));
  const resolved = store.resolve(handle.snapshotId)!;
  assert.equal(resolved.boundaryInputFingerprint, handle.boundaryInputFingerprint);
  assert.equal(resolved.stability, 'stable');
  assert.equal(store.resolve('missing'), null);
  assert.throws(() => (resolved.entries as unknown[]).push('nope'), TypeError);
});

test('retention evicts previous before current', () => {
  const store = new PinnedSnapshotStore({ maxCount: 2, estimateBytes: () => 1 });
  const previous = store.publish(descriptor('previous'), { retentionClass: 'previous' });
  const current = store.publish(descriptor('current'), { retentionClass: 'current' });
  const newest = store.publish(descriptor('newest'), { retentionClass: 'current' });
  assert.equal(store.resolve(previous.snapshotId), null);
  assert.ok(store.resolve(current.snapshotId));
  assert.ok(store.resolve(newest.snapshotId));
});

test('retention uses LRU ordering among current snapshots', () => {
  const store = new PinnedSnapshotStore({ maxCount: 2, estimateBytes: () => 1 });
  const current = store.publish(descriptor('current'), { retentionClass: 'current' });
  const newest = store.publish(descriptor('newest'), { retentionClass: 'current' });
  assert.ok(store.resolve(newest.snapshotId));
  const lru = store.publish(descriptor('lru'), { retentionClass: 'current' });
  assert.equal(store.resolve(current.snapshotId), null);
  assert.ok(store.resolve(newest.snapshotId));
  assert.ok(store.resolve(lru.snapshotId));
});

test('hard byte ceiling is enforced independently of count', () => {
  const store = new PinnedSnapshotStore({ maxCount: 10, maxBytes: 2, estimateBytes: (item) =>
    String(item.entries[0]).length });
  const first = store.publish(descriptor('first', '12'));
  const second = store.publish(descriptor('second', '345'));
  assert.equal(store.resolve(first.snapshotId), null);
  assert.equal(store.resolve(second.snapshotId), null);
  assert.ok(store.byteSize <= 2);
});

test('evicted handles resolve as snapshot-gone', () => {
  const store = new PinnedSnapshotStore({ maxCount: 1, estimateBytes: () => 1 });
  const evicted = store.publish(descriptor('evicted'));
  store.publish(descriptor('survivor'));
  assert.equal(store.resolve(evicted.snapshotId), null);
});

test('finalization write never evicts the shared card snapshot', () => {
  const store = new PinnedSnapshotStore({ maxCount: 1, estimateBytes: () => 1 });
  const card = store.publish(descriptor('card'));
  store.writeFinalization(descriptor('finalization'), card.snapshotId);
  assert.ok(store.resolve(card.snapshotId));
  assert.equal(store.size, 1);
});

test('two sequential finalization writes retain the shared card snapshot', () => {
  const store = new PinnedSnapshotStore({ maxCount: 1, estimateBytes: () => 1 });
  const card = store.publish(descriptor('card'));
  store.writeFinalization(descriptor('finalization-one'), card.snapshotId);
  store.writeFinalization(descriptor('finalization-two'), card.snapshotId);
  assert.ok(store.resolve(card.snapshotId));
});
