import assert from 'node:assert/strict';

import type { DirtyEntry, DirtyInventory, ConflictComponent } from '../../shared/commit-candidates';
import type { SaveIntent } from '../database';
import { projectIntentUnits } from './intent-assembler';
import type { ComponentAssembly } from './component-assembler';
import type { ProjectedWitness } from './witness-projection';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, run: () => void): void { tests.push({ name, run }); }

function entry(id: string): DirtyEntry {
  const path = { pathBytesBase64: Buffer.from(`${id}.ts`).toString('base64'), displayPath: `${id}.ts`, utf8Clean: true };
  return {
    entryId: id, path, originalPath: null, entryKind: 'ordinary', indexStatus: '.', worktreeStatus: 'M',
    headMode: '100644', indexMode: '100644', worktreeMode: '100644', submoduleState: null,
    renameOrCopyScore: null, expectedWorktreeState: 'present', rawWorktreeBlobOid: 'a'.repeat(40),
    gitLevelEligibility: 'supported', commitPathspecs: [path],
  };
}

const entries = ['a', 'b', 'shared', 'legacy', 'loose'].map(entry);
const inventory: DirtyInventory = {
  repository: {
    repositoryKey: 'repo', objectDatabaseKey: 'private', gitObjectFormat: 'sha1', bareRepo: false,
    workspaces: [{ workspaceId: 'ws', workspacePrefix: '' }],
  },
  entries, unattributedEntryIds: ['loose'], topologyDigest: 'digest-1',
};

function component(id: string, entryIds: string[]): ConflictComponent {
  return {
    componentId: id, dirtyEntryIds: entryIds, associations: [], componentTopologyDigest: `${id}-digest`,
    overlap: { componentId: id, contributingAgentCount: 1, mergedGroupCount: 1, perPathContributors: {} },
  };
}
const components = [component('ca', ['a']), component('cb', ['b']), component('cs', ['shared', 'legacy'])];
const topology = { components } as ComponentAssembly;

function intent(id: string, kind: SaveIntent['kind'] = 'task'): SaveIntent {
  return {
    id, workspaceId: 'ws', executionRunId: null, repositoryKey: 'repo', kind,
    planId: 'plan', planItemId: 'item', title: id, briefDigest: null,
    dispatchAttemptId: kind === 'task' ? `dispatch-${id}` : null,
    createdBy: kind === 'task' ? 'task-dispatch' : 'human-save-card', createdById: null,
    state: 'open', revision: 1, createdAt: 1, readyAt: null, committedAt: null,
  };
}

function witness(
  entryId: string,
  intentId: string | null,
  turnId = `${entryId}-${intentId}`,
  overrides: Partial<ProjectedWitness> = {},
): ProjectedWitness {
  return {
    entryId, workspaceId: 'ws', turnId, agentId: 'agent', ownerAgentId: null,
    ownerBrickGeneration: null, planId: intentId ? 'plan' : null,
    planItemId: intentId ? 'item' : null, intentId, planAttributionAvailable: intentId !== null,
    sessionId: 'session-a', agentTitle: 'Build worker', agentIdentityResolved: true,
    ...overrides,
  };
}

const witnesses = [
  witness('a', 'intent-one', 'turn-a'), witness('b', 'intent-one', 'turn-b'),
  witness('shared', 'intent-two', 'turn-two'), witness('shared', 'intent-three', 'turn-three'),
  witness('legacy', null, 'turn-legacy'),
];

function project() {
  return projectIntentUnits({
    inventory, topology, witnesses,
    intents: [intent('intent-one'), intent('intent-two'), intent('intent-three'), intent('manual', 'named-save-set')],
    namedMembers: [{
      intentId: 'manual', entryId: 'loose',
      pathBytesBase64: entries.find((item) => item.entryId === 'loose')!.path.pathBytesBase64,
      inventoryDigest: 'digest-1',
    }],
  });
}

test('one intent spanning disconnected topology components remains one task unit', () => {
  const unit = project().intentUnits.find((candidate) => candidate.intent.id === 'intent-one')!;
  assert.deepEqual(unit.memberEntryIds, ['a', 'b']);
  assert.deepEqual(unit.topologyComponentIds, ['ca', 'cb']);
});

test('one topology component carrying two intents projects two task cards', () => {
  const projected = project().intentUnits.filter((unit) => unit.memberEntryIds.includes('shared'));
  assert.deepEqual(projected.map((unit) => unit.intent.id), ['intent-three', 'intent-two']);
  assert.ok(projected.every((unit) => unit.topologyComponentIds[0] === 'cs'));
});

test('separates truly unwitnessed work from honest legacy identity-unavailable work', () => {
  const result = projectIntentUnits({
    inventory, topology, witnesses,
    intents: [intent('intent-one'), intent('intent-two'), intent('intent-three')],
    namedMembers: [],
  });
  assert.deepEqual(result.unwitnessedEntryIds, ['loose']);
  assert.deepEqual(result.legacyTaskIdentityUnavailableEntryIds, ['legacy']);
});

test('fallback units group only witnessed legacy identity by agent session and keep ids membership-independent', () => {
  const first = projectIntentUnits({
    inventory, topology,
    witnesses: [witness('a', null, 'turn-a'), witness('b', null, 'turn-b')],
    intents: [], namedMembers: [],
  });
  const unit = first.fallbackUnits.find((candidate) => candidate.memberEntryIds.includes('a'))!;
  assert.deepEqual(unit.memberEntryIds, ['a', 'b']);
  assert.equal(unit.saveUnitKind, 'agent-session-fallback');
  assert.match(unit.title, /Build worker.*mixed session work/);
  const drifted = projectIntentUnits({
    inventory, topology, witnesses: [witness('a', null, 'turn-a')], intents: [], namedMembers: [],
  });
  assert.equal(drifted.fallbackUnits[0].saveUnitId, unit.saveUnitId,
    'membership drift must not rename the group-derived unit');
  assert.ok(first.unwitnessedEntryIds.includes('loose'), 'the disjoint no-witness pool is not grouped');
});

test('session identity controls grouping while null session stays coarse and visibly warned', () => {
  const result = projectIntentUnits({
    inventory, topology,
    witnesses: [
      witness('a', null, 'turn-a', { sessionId: 'session-a' }),
      witness('b', null, 'turn-b', { sessionId: 'session-b' }),
      witness('legacy', null, 'turn-legacy', { sessionId: null }),
    ],
    intents: [], namedMembers: [],
  });
  const idsByMember = new Map(result.fallbackUnits.flatMap((unit) =>
    unit.memberEntryIds.map((entryId) => [entryId, unit.saveUnitId] as const)));
  assert.notEqual(idsByMember.get('a'), idsByMember.get('b'));
  const coarse = result.fallbackUnits.find((unit) => unit.memberEntryIds.includes('legacy'))!;
  assert.equal(coarse.coarseIdentityWarning, true);
  assert.match(coarse.title, /agent-lifetime/);
});

test('real intent precedence excludes the whole entry while multiple null-intent sessions may share it', () => {
  const withIntent = projectIntentUnits({
    inventory, topology,
    witnesses: [
      witness('shared', null, 'turn-null'),
      witness('shared', 'intent-two', 'turn-intent'),
    ],
    intents: [intent('intent-two')], namedMembers: [],
  });
  assert.ok(withIntent.fallbackUnits.every((unit) => !unit.memberEntryIds.includes('shared')));

  const sharedFallback = projectIntentUnits({
    inventory, topology,
    witnesses: [
      witness('shared', null, 'turn-a', { sessionId: 'session-a' }),
      witness('shared', null, 'turn-b', { sessionId: 'session-b' }),
    ],
    intents: [], namedMembers: [],
  });
  const containingIds = sharedFallback.fallbackUnits
    .filter((unit) => unit.memberEntryIds.includes('shared'))
    .map((unit) => unit.saveUnitId);
  assert.ok(new Set(containingIds).size > 1, 'concurrent session evidence is disclosed in each unit');
});

test('unresolved agent identity remains witnessed and explicitly ungroupable', () => {
  const result = projectIntentUnits({
    inventory, topology,
    witnesses: [witness('legacy', null, 'turn-legacy', {
      agentIdentityResolved: false, agentTitle: null,
    })],
    intents: [], namedMembers: [],
  });
  assert.deepEqual(result.fallbackUnits, []);
  assert.ok(result.witnessedUngroupableEntryIds.includes('legacy'));
  assert.ok(result.legacyTaskIdentityUnavailableEntryIds.includes('legacy'));
});

test('honest inventory partitions excluded witnessed work without hiding it', () => {
  const intended = entry('intended');
  const fallback = entry('fallback');
  const excluded = entry('excluded');
  excluded.path = {
    pathBytesBase64: Buffer.from('.lares/plans/active/plan.md').toString('base64'),
    displayPath: '.lares/plans/active/plan.md',
    utf8Clean: true,
  };
  excluded.commitPathspecs = [excluded.path];
  const noWitness = entry('no-witness');
  const partitionInventory: DirtyInventory = {
    ...inventory,
    entries: [intended, fallback, excluded, noWitness],
    unattributedEntryIds: [noWitness.entryId],
  };
  const result = projectIntentUnits({
    inventory: partitionInventory,
    topology,
    witnesses: [
      witness(intended.entryId, 'intent-one', 'turn-intended'),
      witness(fallback.entryId, null, 'turn-fallback'),
      witness(excluded.entryId, null, 'turn-excluded'),
    ],
    intents: [intent('intent-one')],
    namedMembers: [],
  });

  assert.ok(result.witnessedUngroupableEntryIds.includes(excluded.entryId));
  assert.ok(result.fallbackUnits.every((unit) => !unit.memberEntryIds.includes(excluded.entryId)));

  const categories = [
    new Set([
      ...result.intentUnits.flatMap((unit) => unit.memberEntryIds),
      ...result.fallbackUnits.flatMap((unit) => unit.memberEntryIds),
    ]),
    new Set(result.unwitnessedEntryIds),
    new Set(result.witnessedUngroupableEntryIds),
  ];
  for (const dirtyEntry of partitionInventory.entries) {
    assert.equal(categories.filter((category) => category.has(dirtyEntry.entryId)).length, 1,
      `${dirtyEntry.entryId} must remain reachable in exactly one visible category`);
  }
});

test('named membership is byte addressed and becomes stale on inventory digest change', () => {
  const valid = project();
  assert.deepEqual(valid.intentUnits.find((unit) => unit.intent.id === 'manual')!.memberEntryIds, ['loose']);
  assert.deepEqual(valid.unwitnessedEntryIds, [], 'valid named membership removes the entry from Unwitnessed');
  const stale = projectIntentUnits({
    inventory: { ...inventory, topologyDigest: 'digest-2' }, topology, witnesses, intents: [intent('manual', 'named-save-set')],
    namedMembers: [{ intentId: 'manual', entryId: 'loose', pathBytesBase64: entries[4].path.pathBytesBase64, inventoryDigest: 'digest-1' }],
  });
  assert.equal(stale.intentUnits[0].intent.id, 'manual');
  assert.deepEqual(stale.intentUnits[0].memberEntryIds, []);
  assert.deepEqual(stale.staleNamedSaveSetIds, ['manual']);
});

let passed = 0;
let failed = 0;
for (const current of tests) {
  try { current.run(); console.log(`  ok  ${current.name}`); passed += 1; }
  catch (error) { console.error(`  FAIL ${current.name}`, error); failed += 1; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
