import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PackageFinalization, SaveIntent, TurnWitnessRead } from '../database';
import { resolveInternalGit } from '../git/git-runtime';
import { runGit, runGitBytes } from '../git-checkpoints/git-command';
import { SAVECARD_CHANNELS, type SaveCardInventoryResponse } from '../../shared/types';
import { registerSaveCardIpc, type IpcLike } from './save-card-ipc';
import { createSaveCardRoutes } from './save-card-routes';
import { createPreviewRoutes } from './preview-routes';
import { CommitCandidateSnapshotRegistry } from './snapshot-registry';
import type { CandidateInventoryRead } from './candidate-service';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
class FakeIpc implements IpcLike {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, listener: Handler): void { this.handlers.set(channel, listener); }
  async invoke<T>(channel: string, request: unknown): Promise<T> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler ${channel}`);
    return handler({}, request) as Promise<T>;
  }
}

const tests: Array<{ name: string; run(): Promise<void> }> = [];
function test(name: string, run: () => Promise<void>): void { tests.push({ name, run }); }

let gitExe = '';
let repo = '';
const commands: string[][] = [];

function git(args: string[]): void {
  execFileSync(gitExe, args, { cwd: repo, stdio: 'ignore' });
}

const intent: SaveIntent = {
  id: 'intent-task', workspaceId: 'workspace-1', executionRunId: null,
  repositoryKey: null, kind: 'task', planId: 'plan-1', planItemId: 'item-1',
  title: 'Implement intent inventory', briefDigest: 'brief', dispatchAttemptId: 'attempt-1',
  createdBy: 'task-dispatch', createdById: null, state: 'open', revision: 1,
  createdAt: 1, readyAt: null, committedAt: null,
};

function witness(turnId: string, touchedPath: string, intentId: string | null): TurnWitnessRead {
  return {
    turnId, agentId: 'agent-1', ownerAgentId: null, ownerBrickGeneration: null,
    intentId, touched: [{ path: touchedPath, op: 'write' }],
  };
}

function legacyFinalization(repositoryKey: string): PackageFinalization {
  return {
    id: 'legacy-finalization', packageId: 'legacy-package', packageRevision: 1,
    finalizationKind: 'fleet-adhoc', planId: null, planItemId: null,
    repositoryKey, checkpointTurnId: null, checkpointOid: null, boundaryRef: null,
    boundaryStatus: 'unavailable', memberManifestJson: '[]', contractVersion: 1,
    lifecycleStatus: 'active', finalizedBy: 'app-user', finalizedAt: 10,
    supersededByFinalizationId: null, releasedAt: null, failureReason: null,
    createdFromWorkspaceId: 'workspace-1',
  };
}

async function setup(): Promise<void> {
  const resolved = await resolveInternalGit();
  if (!resolved) throw new Error('compatible Git required');
  gitExe = resolved.execPath;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-intent-routes-'));
  git(['init', '-q']);
  git(['config', 'user.name', 'Intent Routes']);
  git(['config', 'user.email', 'intent@example.invalid']);
  fs.writeFileSync(path.join(repo, 'task.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'legacy.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  fs.writeFileSync(path.join(repo, 'task.txt'), 'task\n');
  fs.writeFileSync(path.join(repo, 'legacy.txt'), 'legacy\n');
  fs.writeFileSync(path.join(repo, 'human.txt'), 'human\n');
}

function routes(registry?: CommitCandidateSnapshotRegistry<CandidateInventoryRead>) {
  const witnesses = [
    witness('turn-task', 'task.txt', intent.id),
    witness('turn-legacy', 'legacy.txt', null),
  ];
  let repositoryKey = '';
  return createSaveCardRoutes({
    gitExe,
    ...(registry ? { snapshotRegistry: registry } : {}),
    getWorkspaces: () => [{ id: 'workspace-1', path: repo, title: 'Repository' }],
    readTurnWitnesses: () => witnesses,
    readTurnRecord: (turnId) => ({
      id: turnId, workspaceId: 'workspace-1', planId: 'plan-1', planItemId: 'item-1',
      planStampSource: turnId === 'turn-legacy' ? 'legacy-unstamped' : 'explicit',
    }),
    readCaptureTurns: () => [],
    readCommitPathLinks: () => [],
    readActiveFinalizations: (key) => {
      repositoryKey = key;
      return [legacyFinalization(repositoryKey)];
    },
    getAgentsByWorkspace: () => [],
    getAgent: () => null,
    readBundleTurns: () => [],
    listSaveIntents: () => [intent],
    listNamedSaveSetMembers: () => [],
    getPlan: () => ({ id: 'plan-1', slug: 'Intent plan', path: 'plan.md' } as never),
    getPlanItem: () => ({ id: 'item-1', title: 'Intent item' } as never),
    listPlanningActivities: () => [],
    runGit: async (cwd, args, options) => {
      commands.push([...args]);
      return runGit(cwd, args, { ...options, gitExe });
    },
    runGitBytes: async (cwd, args, options) => {
      commands.push([...args]);
      return runGitBytes(cwd, args, { ...options, gitExe });
    },
  });
}

/** A preview-route set over the SAME real temp repo, with every DB seam faked to
 *  empty so the real `CommitCandidateService.assembleInventory` pipeline runs
 *  without a live SQLite database. Used only by the cross-constructor WP-G tests. */
function preview(registry?: CommitCandidateSnapshotRegistry<CandidateInventoryRead>) {
  return createPreviewRoutes({
    gitExe,
    ...(registry ? { snapshotRegistry: registry } : {}),
    getWorkspaces: () => [{ id: 'workspace-1', path: repo, title: 'Repository' }],
    readTurnWitnesses: () => [],
    readTurnRecord: () => null,
    readCaptureTurns: () => [],
    readWitnessedProvenance: () => null,
    readCommitPathLinks: () => [],
    listRepoCommitPathLinks: () => [],
    readActiveFinalizations: () => [],
    getPackageFinalization: () => null,
    getPlanWorkPackage: () => null,
    listPlanWorkPackagePaths: () => [],
    listSaveIntents: () => [],
    listNamedSaveSetMembers: () => [],
    getPlan: () => null,
    readActivePlanningWorktrees: () => [],
    runGit: async (cwd, args, options) => runGit(cwd, args, { ...options, gitExe }),
    runGitBytes: async (cwd, args, options) => runGitBytes(cwd, args, { ...options, gitExe }),
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Wrap a registry's `acquire` so its FIRST canonical computation is held until
 *  `expected` distinct acquire calls have arrived — making the coalescing race
 *  deterministic. Records each acquire's repositoryKey and counts real compute
 *  executions (a joiner never re-runs the thunk). */
function instrument(
  registry: CommitCandidateSnapshotRegistry<CandidateInventoryRead>,
  gate: { promise: Promise<void>; resolve(): void },
  counters: { acquireCalls: number; computeRuns: number; keys: string[] },
  arrivals: () => number,
  expected: number,
): void {
  const real = registry.acquire.bind(registry);
  registry.acquire = ((key, compute, options) => {
    counters.acquireCalls += 1;
    counters.keys.push(key.repositoryKey);
    if (arrivals() >= expected) gate.resolve();
    return real(key, async (signal) => {
      counters.computeRuns += 1;
      await gate.promise;
      return compute(signal);
    }, options);
  }) as typeof registry.acquire;
}

test('WP-G: both route constructors sharing one registry compute exactly one snapshot', async () => {
  const registry = new CommitCandidateSnapshotRegistry<CandidateInventoryRead>();
  const gate = deferred();
  const counters = { acquireCalls: 0, computeRuns: 0, keys: [] as string[] };
  instrument(registry, gate, counters, () => counters.acquireCalls, 2);

  const saveCard = routes(registry);
  const previewRoutes = preview(registry);
  await Promise.all([
    saveCard.getInventory({ workspaceId: 'workspace-1' }),
    previewRoutes.saveCardPreviewRoutes.resolvePreviewContext({
      workspaceId: 'workspace-1',
      selectedComponentIds: [],
      selectedUnattributedEntryIds: [],
      finalizationIds: [],
    }),
  ]);

  assert.equal(counters.acquireCalls, 2, 'both constructors routed through the one shared registry');
  assert.equal(counters.computeRuns, 1, 'a concurrent save-card + preview computes exactly one snapshot');
  assert.equal(counters.keys[0], counters.keys[1], 'both surfaces resolved the same canonical repositoryKey');
});

test('WP-G: distinct registries do NOT coalesce — the shared instance is what dedupes', async () => {
  const gate = deferred();
  const counters = { acquireCalls: 0, computeRuns: 0, keys: [] as string[] };
  const saveRegistry = new CommitCandidateSnapshotRegistry<CandidateInventoryRead>();
  const previewRegistry = new CommitCandidateSnapshotRegistry<CandidateInventoryRead>();
  instrument(saveRegistry, gate, counters, () => counters.acquireCalls, 2);
  instrument(previewRegistry, gate, counters, () => counters.acquireCalls, 2);

  const saveCard = routes(saveRegistry);
  const previewRoutes = preview(previewRegistry);
  await Promise.all([
    saveCard.getInventory({ workspaceId: 'workspace-1' }),
    previewRoutes.saveCardPreviewRoutes.resolvePreviewContext({
      workspaceId: 'workspace-1',
      selectedComponentIds: [],
      selectedUnattributedEntryIds: [],
      finalizationIds: [],
    }),
  ]);

  assert.equal(counters.computeRuns, 2, 'two separate registries each run their own computation');
});

test('production route projects intent units and keeps unstamped work read-only', async () => {
  const inventory = await routes().getInventory({ workspaceId: 'workspace-1' });
  assert.equal(inventory.intentUnits.length, 1);
  assert.equal(inventory.intentUnits[0].intentId, intent.id);
  assert.equal(inventory.intentUnits[0].title, intent.title);
  assert.deepEqual(inventory.intentUnits[0].members.map((member) => member.entry.path.displayPath), ['task.txt']);
  assert.deepEqual(inventory.legacyTaskIdentityUnavailable.map((member) => member.entry.path.displayPath), ['legacy.txt']);
  assert.deepEqual(inventory.unwitnessed.map((member) => member.entry.path.displayPath), ['human.txt']);
  assert.deepEqual(inventory.legacyFinalizations.map((row) => row.finalizationId), ['legacy-finalization']);
});

test('production IPC registration reaches the intent route', async () => {
  const ipc = new FakeIpc();
  const productionRoutes = routes();
  registerSaveCardIpc(ipc, () => productionRoutes);
  const inventory = await ipc.invoke<SaveCardInventoryResponse>(
    SAVECARD_CHANNELS.getInventory,
    { workspaceId: 'workspace-1' },
  );
  assert.equal(inventory.intentUnits[0].intentId, intent.id);
  assert.equal(inventory.legacyTaskIdentityUnavailable.length, 1);
});

test('inventory projection invokes only read-only Git commands', async () => {
  commands.length = 0;
  await routes().getInventory({ workspaceId: 'workspace-1' });
  const mutating = new Set(['add', 'commit', 'update-ref', 'checkout', 'reset', 'merge', 'write-tree']);
  for (const args of commands) {
    const verb = args.find((arg) => !arg.startsWith('-'));
    assert.equal(verb && mutating.has(verb), false, `unexpected mutating command: ${args.join(' ')}`);
  }
});

async function main(): Promise<void> {
  await setup();
  let failed = 0;
  try {
    for (const current of tests) {
      try { await current.run(); console.log(`ok - ${current.name}`); }
      catch (error) { failed += 1; console.error(`not ok - ${current.name}`); console.error(error); }
    }
  } finally {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  }
  if (failed > 0) process.exitCode = 1;
}

void main();
