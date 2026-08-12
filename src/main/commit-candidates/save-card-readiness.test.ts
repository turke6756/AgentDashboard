import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SaveIntent, TurnWitnessRead } from '../database';
import { resolveInternalGit } from '../git/git-runtime';
import { runGit, runGitBytes } from '../git-checkpoints/git-command';
import { createSaveCardRoutes } from './save-card-routes';
import { assessSaveUnitReadiness } from './save-card-readiness';

const tests: Array<{ name: string; run(): Promise<void> }> = [];
function test(name: string, run: () => Promise<void>): void { tests.push({ name, run }); }

const intent: SaveIntent = {
  id: 'intent-ready', workspaceId: 'workspace-1', executionRunId: null,
  repositoryKey: null, kind: 'task', planId: null, planItemId: null,
  title: 'Readiness fixture intent', briefDigest: 'brief', dispatchAttemptId: 'attempt-1',
  createdBy: 'task-dispatch', createdById: null, state: 'open', revision: 1,
  createdAt: 1, readyAt: null, committedAt: null,
};

function witness(turnId: string, touchedPath: string, intentId: string | null): TurnWitnessRead {
  return {
    turnId, agentId: 'agent-1', ownerAgentId: null, ownerBrickGeneration: null,
    intentId, touched: [{ path: touchedPath, op: 'write' }],
  };
}

async function projectRealFixture(state: 'absent' | 'present-unhashed') {
  const resolved = await resolveInternalGit();
  if (!resolved) throw new Error('compatible Git required');
  const gitExe = resolved.execPath;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-save-readiness-'));
  const git = (args: string[]) => execFileSync(gitExe, args, { cwd: repo, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.name', 'Readiness Fixture']);
  git(['config', 'user.email', 'readiness@example.invalid']);
  fs.writeFileSync(path.join(repo, 'intent.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'fallback.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  if (state === 'absent') {
    fs.rmSync(path.join(repo, 'intent.txt'));
    fs.rmSync(path.join(repo, 'fallback.txt'));
  } else {
    fs.writeFileSync(path.join(repo, 'intent.txt'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'fallback.txt'), 'changed\n');
  }

  const witnesses = [
    witness('turn-intent', 'intent.txt', intent.id),
    witness('turn-fallback', 'fallback.txt', null),
  ];
  const agent = {
    id: 'agent-1', workspaceId: 'workspace-1', title: 'Fixture worker',
    roleDescription: 'Exercises the production projection', isSupervisor: false,
    isWorker: true, isSupervised: true,
  } as never;
  const turnIdentity = (turnId: string) => ({
    id: turnId, agentId: 'agent-1',
    sessionId: turnId === 'turn-fallback' ? 'session-fallback' : 'session-intent',
  });
  const failHashes = state === 'present-unhashed';
  try {
    return await createSaveCardRoutes({
      gitExe,
      getWorkspaces: () => [{ id: 'workspace-1', path: repo, title: 'Fixture' }],
      readTurnWitnesses: () => witnesses,
      readTurnRecord: (turnId) => ({
        id: turnId, workspaceId: 'workspace-1', planId: null, planItemId: null,
        planStampSource: turnId === 'turn-intent' ? 'explicit' : 'legacy-unstamped',
      }),
      readCaptureTurns: () => [],
      readCommitPathLinks: () => [],
      readActiveFinalizations: () => [],
      getAgentsByWorkspace: () => [agent],
      getAgent: () => agent,
      readBundleTurns: () => witnesses.map((item) => ({
        id: item.turnId, agentId: item.agentId, agentTitle: 'Fixture worker',
        sessionId: turnIdentity(item.turnId).sessionId, startedAt: 1, endedAt: 2,
      })),
      readFallbackTurnIdentity: turnIdentity,
      listSaveIntents: () => [intent],
      listNamedSaveSetMembers: () => [],
      listPlanningActivities: () => [],
      runGit: async (cwd, args, options) => failHashes && args[0] === 'hash-object'
        ? { code: 1, stdout: '', stderr: 'fixture refuses hash' }
        : runGit(cwd, args, { ...options, gitExe }),
      runGitBytes: async (cwd, args, options) => failHashes && args[0] === 'hash-object'
        ? { code: 1, stdout: Buffer.alloc(0), stderr: 'fixture refuses hash' }
        : runGitBytes(cwd, args, { ...options, gitExe }),
    }).getInventory({ workspaceId: 'workspace-1' });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test('absent members with null OIDs are ready through the real projection', async () => {
  const inventory = await projectRealFixture('absent');
  assert.equal(inventory.intentUnits.length, 1);
  assert.equal(inventory.fallbackUnits?.length, 1);
  const intentEntries = inventory.intentUnits[0].members.map((member) => member.entry);
  const fallbackEntries = inventory.fallbackUnits![0].members.map((member) => member.entry);
  assert.deepEqual(intentEntries.map((entry) => entry.path.displayPath), ['intent.txt']);
  assert.deepEqual(fallbackEntries.map((entry) => entry.path.displayPath), ['fallback.txt']);
  assert.ok([...intentEntries, ...fallbackEntries].every((entry) =>
    entry.expectedWorktreeState === 'absent' && entry.rawWorktreeBlobOid === null));
  assert.deepEqual(assessSaveUnitReadiness(intentEntries), { ready: true },
    'REACHABILITY:save-unit-readiness absent null-OID members must remain ready');
  assert.deepEqual(inventory.intentUnits[0].saveGate, { ready: true });
  assert.deepEqual(inventory.fallbackUnits![0].saveGate, { ready: true });
});

test('intent and fallback DTOs gate present members whose hashes are unavailable', async () => {
  const inventory = await projectRealFixture('present-unhashed');
  assert.deepEqual(inventory.intentUnits.map((unit) => ({
    id: unit.intentId,
    paths: unit.members.map((member) => member.entry.path.displayPath),
  })), [{ id: intent.id, paths: ['intent.txt'] }]);
  assert.deepEqual(inventory.fallbackUnits?.map((unit) => ({
    kind: unit.kind,
    paths: unit.members.map((member) => member.entry.path.displayPath),
  })), [{ kind: 'agent-session-fallback', paths: ['fallback.txt'] }]);
  assert.deepEqual(inventory.intentUnits[0].saveGate, {
    ready: false,
    reason: 'members-unhashed',
    unhashedMemberCount: 1,
    sampleDisplayPaths: ['intent.txt'],
  });
  assert.deepEqual(inventory.fallbackUnits![0].saveGate, {
    ready: false,
    reason: 'members-unhashed',
    unhashedMemberCount: 1,
    sampleDisplayPaths: ['fallback.txt'],
  });
  assert.deepEqual(inventory.unwitnessed, [], 'the disjoint unattributed bucket forms no unit');
});

async function main(): Promise<void> {
  let failures = 0;
  for (const current of tests) {
    try { await current.run(); console.log(`ok - ${current.name}`); }
    catch (error) { failures += 1; console.error(`not ok - ${current.name}`); console.error(error); }
  }
  if (failures > 0) process.exitCode = 1;
}

void main();
