import assert from 'node:assert/strict';
import type { SaveIntent } from '../database';
import type { DirtyEntry, EncodedGitPath } from '../../shared/commit-candidates';
import { assembleConflictComponents } from './component-assembler';
import { projectIntentUnits, type NamedSaveSetMember } from './intent-assembler';
import type { ProjectedWitness } from './witness-projection';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const repository = {
  repositoryKey: 'repo-1', objectDatabaseKey: 'odb-1', gitObjectFormat: 'sha1' as const,
  bareRepo: false as const, workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
};

function encoded(displayPath: string): EncodedGitPath {
  return { displayPath, pathBytesBase64: Buffer.from(displayPath).toString('base64'), utf8Clean: true };
}

function entry(entryId: string, displayPath: string): DirtyEntry {
  return {
    entryId, path: encoded(displayPath), originalPath: null, entryKind: 'ordinary',
    indexStatus: '.', worktreeStatus: 'M', headMode: '100644', indexMode: '100644',
    worktreeMode: '100644', submoduleState: null, renameOrCopyScore: null,
    expectedWorktreeState: 'present', rawWorktreeBlobOid: `blob-${entryId}`,
    gitLevelEligibility: 'supported', commitPathspecs: [encoded(displayPath)],
  };
}

function intent(id: string, title = id, planId = 'plan-1', planItemId = 'item-1'): SaveIntent {
  return {
    id, workspaceId: 'ws-1', executionRunId: 'run-1', repositoryKey: 'repo-1',
    kind: 'task', planId, planItemId, title, briefDigest: `digest-${id}`,
    dispatchAttemptId: `attempt-${id}`, createdBy: 'task-dispatch', createdById: null,
    state: 'open', revision: 1, createdAt: 1, readyAt: null, committedAt: null,
  };
}

function witness(entryId: string, turnId: string, agentId: string, intentId: string | null): ProjectedWitness {
  return {
    entryId, workspaceId: 'ws-1', turnId, agentId, ownerAgentId: null,
    ownerBrickGeneration: null, planId: 'plan-1', planItemId: 'item-1', intentId,
    planAttributionAvailable: true,
  };
}

function assembly(entries: DirtyEntry[], witnesses: ProjectedWitness[], intents: SaveIntent[], namedMembers: NamedSaveSetMember[] = []) {
  const topology = assembleConflictComponents({ repository, entries }, witnesses);
  return projectIntentUnits({ inventory: topology.inventory, witnesses, intents, namedMembers, topology });
}

test('scenario 1: two agents, one file, same task => one silent intent and one commit unit', () => {
  const entries = [entry('shared', 'shared.ts')];
  const result = assembly(entries, [
    witness('shared', 'turn-a', 'agent-a', 'intent-a'),
    witness('shared', 'turn-b', 'agent-b', 'intent-a'),
  ], [intent('intent-a')]);
  assert.equal(result.intentUnits.length, 1);
  assert.deepEqual(result.intentUnits[0].contributingAgentIds, ['agent-a', 'agent-b']);
  assert.deepEqual(result.intentUnits[0].memberEntryIds, ['shared']);
});

test('scenario 2: one task across disconnected directories => one intent and one commit unit', () => {
  const entries = [entry('a', 'src/a.ts'), entry('b', 'docs/b.md')];
  const witnesses = [
    witness('a', 'turn-a', 'agent-a', 'intent-a'),
    witness('b', 'turn-b', 'agent-a', 'intent-a'),
  ];
  const topology = assembleConflictComponents({ repository, entries }, witnesses);
  const template = topology.components[0];
  topology.components = entries.map((value, index) => ({
    ...template, componentId: `disconnected-${index + 1}`, dirtyEntryIds: [value.entryId],
    componentTopologyDigest: `topology-${index + 1}`,
  }));
  const result = projectIntentUnits({
    inventory: topology.inventory, witnesses, intents: [intent('intent-a')], namedMembers: [], topology,
  });
  assert.equal(result.intentUnits.length, 1);
  assert.deepEqual(result.intentUnits[0].memberEntryIds, ['a', 'b']);
  assert.equal(result.intentUnits[0].topologyComponentIds.length, 2);
});

test('scenario 9: human edits remain unwitnessed until an authoritative named set adopts them', () => {
  const entries = [entry('human', 'human.txt')];
  const before = assembly(entries, [], []);
  assert.deepEqual(before.unwitnessedEntryIds, ['human']);
  const named = { ...intent('named', 'Baseline'), kind: 'named-save-set' as const,
    planId: null, planItemId: null, dispatchAttemptId: null, createdBy: 'human-save-card' as const };
  const topology = assembleConflictComponents({ repository, entries }, []);
  const after = projectIntentUnits({
    inventory: topology.inventory, witnesses: [], intents: [named], topology,
    namedMembers: [{ intentId: 'named', entryId: 'human',
      pathBytesBase64: entries[0].path.pathBytesBase64, inventoryDigest: topology.inventory.topologyDigest }],
  });
  assert.deepEqual(after.unwitnessedEntryIds, []);
  assert.deepEqual(after.intentUnits[0].memberEntryIds, ['human']);
});

(async () => {
  let failures = 0;
  for (const current of tests) {
    try { await current.run(); console.log(`ok - ${current.name}`); }
    catch (error) { failures += 1; console.error(`not ok - ${current.name}`); console.error(error); }
  }
  if (failures > 0) process.exitCode = 1;
})();
