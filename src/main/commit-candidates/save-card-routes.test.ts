import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PackageFinalization, SaveIntent, TurnWitnessRead } from '../database';
import { resolveInternalGit } from '../git/git-runtime';
import { runGit, runGitBytes } from '../git-checkpoints/git-command';
import { SAVECARD_CHANNELS, SAVECARD_ONBOARDING_DECISION_CHANNEL, SAVECARD_SCOPED_RESCAN_CHANNEL, type SaveCardInventoryResponse } from '../../shared/types';
import { registerSaveCardIpc, registerSaveCardIntentIpc, type IpcLike } from './save-card-ipc';
import { createSaveCardRoutes, type SaveCardRoutesDeps } from './save-card-routes';
import { createPreviewRoutes } from './preview-routes';
import { CommitCandidateSnapshotRegistry } from './snapshot-registry';
import { computeIndexFingerprint } from './index-fingerprint';
import { PinnedSnapshotStore } from './pinned-snapshot-store';
import { unattributedChallengeEntryIds, type CandidateInventoryRead } from './candidate-service';
import { ScratchPolicyStore } from './scratch-policy-store';

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

class InventoryPinnedSnapshotStore extends PinnedSnapshotStore {
  correctedIndexFingerprint = '';
  override resolve(snapshotId: string) {
    const descriptor = super.resolve(snapshotId);
    return descriptor && this.correctedIndexFingerprint
      ? { ...descriptor, indexFingerprint: this.correctedIndexFingerprint }
      : descriptor;
  }
}

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
  fs.mkdirSync(path.join(repo, '.lares', 'supervisor'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.lares', 'supervisor', 'memory.md'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  fs.writeFileSync(path.join(repo, 'task.txt'), 'task\n');
  fs.writeFileSync(path.join(repo, 'legacy.txt'), 'legacy\n');
  fs.writeFileSync(path.join(repo, '.lares', 'supervisor', 'memory.md'), 'churn\n');
  fs.writeFileSync(path.join(repo, 'human.txt'), 'human\n');
}

function routes(
  registry?: CommitCandidateSnapshotRegistry<CandidateInventoryRead>,
  overrides: Partial<SaveCardRoutesDeps> = {},
) {
  const witnesses = [
    witness('turn-task', 'task.txt', intent.id),
    witness('turn-legacy', 'legacy.txt', null),
    witness('turn-internal', '.lares/supervisor/memory.md', null),
  ];
  const agent = {
    id: 'agent-1', workspaceId: 'workspace-1', title: 'Supervisor builder',
    roleDescription: 'Coordinates and edits production code', isSupervisor: true,
    isWorker: false, isSupervised: false,
  } as never;
  const turnIdentity = (turnId: string) => ({
    id: turnId, agentId: 'agent-1', sessionId: turnId === 'turn-legacy' ? 'session-legacy' : 'session-task',
  });
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
    getAgentsByWorkspace: () => [agent],
    getAgent: () => agent,
    readBundleTurns: () => witnesses.map((item) => ({
      id: item.turnId, agentId: item.agentId, agentTitle: 'Supervisor builder',
      sessionId: turnIdentity(item.turnId).sessionId, startedAt: 1, endedAt: 2,
    })),
    readFallbackTurnIdentity: turnIdentity,
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
    ...overrides,
  });
}

/** A preview-route set over the SAME real temp repo, with every DB seam faked to
 *  empty so the real `CommitCandidateService.assembleInventory` pipeline runs
 *  without a live SQLite database. Used only by the cross-constructor WP-G tests. */
function preview(
  registry?: CommitCandidateSnapshotRegistry<CandidateInventoryRead>,
  pinnedSnapshotStore?: import('./pinned-snapshot-store').PinnedSnapshotStore,
  capturedEntries: readonly import('../../shared/commit-candidates').DirtyEntry[] = [],
) {
  return createPreviewRoutes({
    gitExe,
    ...(registry ? { snapshotRegistry: registry } : {}),
    ...(pinnedSnapshotStore ? { pinnedSnapshotStore } : {}),
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
    runGitBytes: async (cwd, args, options) => args[0] === 'ls-tree' && capturedEntries.length > 0
      ? { code: 0, stdout: Buffer.concat(capturedEntries.map((entry) => Buffer.concat([
          Buffer.from(`${entry.worktreeMode ?? '100644'} blob ${entry.rawWorktreeBlobOid}\t`, 'ascii'),
          Buffer.from(entry.path.displayPath), Buffer.from([0]),
        ]))), stderr: '' }
      : runGitBytes(cwd, args, { ...options, gitExe }),
    captureFinalizationBoundary: async () => {
      const tree = execFileSync(gitExe, ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim();
      return { oid: '5'.repeat(40), treeOid: capturedEntries.length > 0 ? 'captured-tree' : tree };
    },
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

test('production route threads policy generation into the registry flight key', async () => {
  const registry = new CommitCandidateSnapshotRegistry<CandidateInventoryRead>();
  let generation: number | null = null;
  let resolved: [string, string] | null = null;
  const acquire = registry.acquire.bind(registry);
  registry.acquire = ((key, compute, options) => {
    generation = key.policyGeneration;
    return acquire(key, compute, options);
  }) as typeof registry.acquire;
  await routes(registry, {
    resolvePolicyGeneration: () => 7,
    onRepositoryResolved: (workspaceId, repositoryKey) => { resolved = [workspaceId, repositoryKey]; },
  }).getInventory({ workspaceId: 'workspace-1' });
  assert.equal(generation, 7);
  assert.equal(resolved?.[0], 'workspace-1');
  assert.ok(resolved?.[1]);
});

test('display and candidate assembly independently re-project the same main-owned fallback identity', async () => {
  const registry = new CommitCandidateSnapshotRegistry<CandidateInventoryRead>();
  let projectedFallback: CandidateInventoryRead['fallbackUnits'] = [];
  const acquire = registry.acquire.bind(registry);
  registry.acquire = (async (key, compute, options) => {
    const result = await acquire(key, compute, options);
    projectedFallback = result.fallbackUnits;
    return result;
  }) as typeof registry.acquire;
  const display = await routes(registry).getInventory({ workspaceId: 'workspace-1' });
  const displayFallback = display.fallbackUnits?.map((unit) => ({
    saveUnitId: unit.saveUnitId,
    saveUnitKind: unit.saveUnitKind,
    memberEntryIds: unit.members.map((member) => member.entry.entryId).sort(),
  }));
  assert.deepEqual(displayFallback, projectedFallback?.map((unit) => ({
    saveUnitId: unit.saveUnitId,
    saveUnitKind: unit.saveUnitKind,
    memberEntryIds: [...unit.memberEntryIds].sort(),
  })));
});

test('candidate acknowledgement classification reads fallback attribution from the main projection', async () => {
  const registry = new CommitCandidateSnapshotRegistry<CandidateInventoryRead>();
  let projectedFallback: CandidateInventoryRead['fallbackUnits'] = [];
  let genuineNoWitnessIds: string[] = [];
  const acquire = registry.acquire.bind(registry);
  registry.acquire = (async (key, compute, options) => {
    const result = await acquire(key, compute, options);
    projectedFallback = result.fallbackUnits;
    genuineNoWitnessIds = [...result.inventory.unattributedEntryIds];
    return result;
  }) as typeof registry.acquire;
  await routes(registry).getInventory({ workspaceId: 'workspace-1' });
  const fallbackEntryIds = projectedFallback?.flatMap((unit) => unit.memberEntryIds) ?? [];
  assert.deepEqual(
    unattributedChallengeEntryIds([...fallbackEntryIds, ...genuineNoWitnessIds], projectedFallback),
    [...genuineNoWitnessIds].sort(),
    'fallback attribution is main-owned; genuine no-witness atoms keep the aggregate challenge',
  );
});

test('production route projects intent units and keeps unstamped work read-only', async () => {
  const inventory = await routes().getInventory({ workspaceId: 'workspace-1' });
  assert.equal(inventory.intentUnits.length, 1);
  assert.match(inventory.intentUnits[0].intentId, /^dirty-tree:/);
  assert.equal(inventory.intentUnits[0].title, intent.title);
  assert.deepEqual(inventory.intentUnits[0].members.map((member) => member.entry.path.displayPath), ['task.txt']);
  assert.deepEqual(inventory.intentUnits[0].contributors.map((contributor) => ({
    name: contributor.name,
    fileCount: contributor.fileCount,
    fileSharePercent: contributor.fileSharePercent,
  })), [{ name: 'Supervisor builder', fileCount: 1, fileSharePercent: 100 }],
  'REACHABILITY:route projection preserves contributor attribution on the returned DTO');
  const legacyPaths = inventory.legacyTaskIdentityUnavailable
    .map((member) => member.entry.path.displayPath);
  assert.ok(legacyPaths.includes('legacy.txt'));
  assert.ok(legacyPaths.includes('.lares/supervisor/memory.md'),
    'scope exclusion must not suppress visible legacy classification');
  const fallback = inventory.fallbackUnits?.find((unit) =>
    unit.members.some((member) => member.entry.path.displayPath === 'legacy.txt'));
  assert.ok(fallback);
  assert.equal(fallback.kind, 'agent-session-fallback');
  assert.equal(fallback.saveUnitId, fallback.intentId);
  assert.match(fallback.title, /Supervisor builder/);
  assert.doesNotMatch(fallback.title, /agent-1|session-legacy/);
  assert.ok(inventory.witnessedUngroupable?.some((member) =>
    member.entry.path.displayPath === '.lares/supervisor/memory.md'));
  assert.ok(!inventory.witnessedUngroupable?.some((member) =>
    member.entry.path.displayPath === 'legacy.txt'));
  assert.deepEqual(inventory.unwitnessed.map((member) => member.entry.path.displayPath), ['human.txt']);
  assert.deepEqual(inventory.legacyFinalizations.map((row) => row.finalizationId), ['legacy-finalization']);
  assert.equal(inventory.computeState?.scope, 'global');
  assert.equal(inventory.computeState?.inventory.completeness, 'complete');
  assert.equal(inventory.computeState?.inventory.totalsExact, true);
  assert.ok((inventory.computeState?.inventory.observedEntries ?? 0) >= inventory.intentUnits.length,
    'observed inventory structurally covers every projected intent unit');
  assert.deepEqual(inventory.computeState?.inventory.dirtyCorpusStopReasons, []);
  assert.equal(inventory.computeState?.protection.assessment.evaluation, 'complete');
});

test('REACHABILITY:pinned-repository-key inventory projection reaches the pinned boundary', async () => {
  const pinnedSnapshotStore = new InventoryPinnedSnapshotStore();
  const inventory = await routes(undefined, { pinnedSnapshotStore }).getInventory({ workspaceId: 'workspace-1' });
  pinnedSnapshotStore.correctedIndexFingerprint = (await computeIndexFingerprint({
    repoRoot: repo, runGitBytes: async (cwd, args, options) => runGitBytes(cwd, args, { ...options, gitExe }),
    withWriteTree: false,
  })).fingerprint;
  const snapshot = inventory.computeState?.snapshot;
  assert.ok(snapshot?.repositoryKey, 'real buildInventory must project repository identity');
  const unit = inventory.intentUnits[0];
  assert.ok(unit);
  const previewRoutes = preview(undefined, pinnedSnapshotStore,
    inventory.intentUnits.flatMap((item) => item.members.map((member) => member.entry)));
  const context = await previewRoutes.saveCardFinalizeRoutes.resolveBoundary({
    saveUnitId: unit.intentId,
    saveUnitKind: unit.kind,
    targetWorkspaceId: 'workspace-1',
    pinnedSnapshotId: snapshot.snapshotId,
    pinnedSnapshotFingerprint: snapshot.boundaryInputFingerprint,
    repositoryKey: snapshot.repositoryKey,
  });
  assert.equal(context.repositoryKey, snapshot.repositoryKey);
});

test('REACHABILITY: adopt-all refuses partial inventory before createNamedSaveSet', async () => {
  let createCalls = 0;
  const productionRoutes = routes(undefined, {
    createNamedSaveSet: (() => {
      createCalls += 1;
      throw new Error('createNamedSaveSet must not be reached');
    }) as never,
  });
  const inventory = await productionRoutes.getInventory({ workspaceId: 'workspace-1', inventoryTimeBudgetMs: 1 });
  assert.equal(inventory.computeState?.inventory.completeness, 'partial',
    'fixture must enter through a genuinely partial inventory');
  const result = await productionRoutes.adoptAllAsBaseline!({ workspaceId: 'workspace-1', inventoryTimeBudgetMs: 1 });
  assert.deepEqual(result, {
    ok: false,
    code: 'adopt-all-inventory-partial',
    message: 'Adopt all is unavailable because the workspace inventory is incomplete. Run a complete scan first.',
  });
  assert.equal(createCalls, 0, 'REACHABILITY: adopt-all guard must precede createNamedSaveSet');
});

test('production IPC registration reaches the intent route', async () => {
  const ipc = new FakeIpc();
  const productionRoutes = routes();
  registerSaveCardIpc(ipc, () => productionRoutes);
  const inventory = await ipc.invoke<SaveCardInventoryResponse>(
    SAVECARD_CHANNELS.getInventory,
    { workspaceId: 'workspace-1' },
  );
  assert.match(inventory.intentUnits[0].intentId, /^dirty-tree:/);
  assert.ok(inventory.fallbackUnits?.some((unit) => unit.kind === 'agent-session-fallback'),
    'REACHABILITY:fallback-projection getInventory registration must enter the canonical projector');
});

test('unresolved agent records remain witnessed but form no fallback unit', async () => {
  const inventory = await routes(undefined, {
    getAgentsByWorkspace: () => [],
    getAgent: () => null,
  }).getInventory({ workspaceId: 'workspace-1' });
  assert.deepEqual(inventory.fallbackUnits, []);
  assert.ok(inventory.witnessedUngroupable?.some((member) =>
    member.entry.path.displayPath === 'legacy.txt'));
  assert.ok(inventory.legacyTaskIdentityUnavailable.some((member) =>
    member.entry.path.displayPath === 'legacy.txt'));
});

test('scope exclusion precedes role-agnostic fallback grouping and a known supervisor still forms a unit', async () => {
  const inventory = await routes().getInventory({ workspaceId: 'workspace-1' });
  const paths = [
    ...inventory.intentUnits.flatMap((unit) => unit.members),
    ...(inventory.fallbackUnits ?? []).flatMap((unit) => unit.members),
    ...inventory.unwitnessed,
    ...(inventory.witnessedUngroupable ?? []),
  ].map((item) => item.entry.path.displayPath);
  assert.ok(paths.includes('.lares/supervisor/memory.md'), 'scope-excluded work stays visible');
  assert.ok(inventory.witnessedUngroupable?.some((item) =>
    item.entry.path.displayPath === '.lares/supervisor/memory.md'));
  assert.ok(!inventory.fallbackUnits?.some((unit) => unit.members.some((item) =>
    item.entry.path.displayPath === '.lares/supervisor/memory.md')),
  'scope-excluded work forms no fallback unit');
  const supervisorFallback = inventory.fallbackUnits?.find((unit) =>
    unit.title.includes('Supervisor builder'));
  assert.ok(supervisorFallback, 'role is not a save-worthiness filter after scoping');
});

test('production route surfaces a failed protection probe as unknown, never unprotected', async () => {
  const headOid = execFileSync(gitExe, ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const checkpointRef = 'refs/lares/checkpoints/wp-c/after';
  execFileSync(gitExe, ['update-ref', checkpointRef, headOid], { cwd: repo, stdio: 'ignore' });
  const productionRoutes = routes(undefined, {
    readCaptureTurns: () => [{
      id: 'turn-probe-failure', status: 'accepted',
      beforeOid: null, beforeRef: null, beforeReady: false, beforeQuality: null,
      afterOid: headOid, afterRef: checkpointRef, afterReady: true, afterQuality: 'hook',
      beforePrunedAt: null, afterPrunedAt: null, failureReason: null,
    }],
    runGitBytes: async (cwd, args, options) => {
      if (args[0] === 'cat-file' && args.includes('--batch-check') && args.includes('-z')) {
        throw new Error('simulated membership probe failure');
      }
      return runGitBytes(cwd, args, { ...options, gitExe });
    },
  });
  const inventory = await productionRoutes.getInventory({ workspaceId: 'workspace-1' });
  const members = [
    ...inventory.intentUnits.flatMap((unit) => unit.members),
    ...inventory.unwitnessed,
    ...inventory.legacyTaskIdentityUnavailable,
  ];
  assert.ok(members.length > 0);
  assert.ok(members.every((member) => member.protectionAssessment?.evaluation === 'incomplete'));
  assert.ok(members.every((member) => member.protection === 'unknown'),
    'REACHABILITY:save-card-protection-assessment failed probes must never default to unprotected');
});

test('production route surfaces a failed protection evidence read as unknown', async () => {
  let reads = 0;
  const inventory = await routes(undefined, {
    readActiveFinalizations: () => {
      if (reads++ === 0) throw new Error('simulated protection database failure');
      return [];
    },
  }).getInventory({ workspaceId: 'workspace-1' });
  const members = [
    ...inventory.intentUnits.flatMap((unit) => unit.members),
    ...inventory.unwitnessed,
    ...inventory.legacyTaskIdentityUnavailable,
  ];
  assert.ok(members.every((member) => member.protectionAssessment?.evaluation === 'incomplete'));
  assert.ok(members.every((member) => member.protection === 'unknown'));
});

test('production inventory supplies first-contact discovery and policy completion persists through the repository store', async () => {
  const clutter = path.join(repo, 'node_modules');
  fs.mkdirSync(clutter, { recursive: true });
  fs.writeFileSync(path.join(clutter, 'dependency.js'), 'generated\n');
  const store = new ScratchPolicyStore(path.join(repo, '.app-policy'));
  const invalidated: string[] = [];
  const productionRoutes = routes(undefined, {
    scratchPolicyStore: store,
    onPolicyWrite: (repositoryKey) => invalidated.push(repositoryKey),
  });
  const ipc = new FakeIpc();
  registerSaveCardIpc(ipc, () => productionRoutes);
  registerSaveCardIntentIpc(ipc, () => productionRoutes);
  const first = await ipc.invoke<SaveCardInventoryResponse>(
    SAVECARD_CHANNELS.getInventory,
    { workspaceId: 'workspace-1' },
  );
  assert.equal(first.onboarding?.presentation, 'first-contact', 'REACHABILITY:onboarding-production-supplier');
  assert.deepEqual(first.onboarding?.recommendations.map((item) => item.displayPath), ['node_modules/']);
  const selected = first.onboarding!.recommendations[0].pathBytesBase64;
  const completed = await ipc.invoke<{ policyGeneration: number }>(SAVECARD_ONBOARDING_DECISION_CHANNEL, {
    workspaceId: 'workspace-1', decision: 'exclude-selected', selectedPathBytesBase64: [selected],
  });
  assert.equal(completed.policyGeneration, 1);
  assert.equal(invalidated.length, 1);
  assert.deepEqual(
    store.read(invalidated[0]).exclusions.map((item) => Buffer.from(item.value, 'base64').toString()),
    ['node_modules/'],
  );
  const repeated = await productionRoutes.getInventory({ workspaceId: 'workspace-1' });
  assert.equal(repeated.onboarding?.presentation, 'established');
});

test('production scoped-rescan channel enters the real route and independently completes an allowed path', async () => {
  const ipc = new FakeIpc();
  const productionRoutes = routes();
  registerSaveCardIpc(ipc, () => productionRoutes);
  registerSaveCardIntentIpc(ipc, () => productionRoutes);
  const global = await ipc.invoke<SaveCardInventoryResponse>(SAVECARD_CHANNELS.getInventory, {
    workspaceId: 'workspace-1',
  });
  const pathBytesBase64 = global.intentUnits[0].members[0].entry.path.pathBytesBase64;
  const scoped = await ipc.invoke<SaveCardInventoryResponse>(SAVECARD_SCOPED_RESCAN_CHANNEL, {
    workspaceId: 'workspace-1', pathBytesBase64,
  });
  assert.equal(scoped.computeState?.scope, 'scoped',
    'REACHABILITY:save-card-degraded-states scoped IPC must return independently tagged evidence');
  assert.equal(scoped.computeState?.inventory.completeness, 'complete');
  assert.equal(scoped.computeState?.inventory.totalsExact, true);
  assert.deepEqual(scoped.intentUnits.flatMap((unit) => unit.members)
    .map((member) => member.entry.path.displayPath), ['task.txt']);
  await assert.rejects(() => ipc.invoke(SAVECARD_SCOPED_RESCAN_CHANNEL, {
    workspaceId: 'workspace-1', pathBytesBase64: Buffer.from('../outside').toString('base64'),
  }), /inside the repository|stale/);
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
