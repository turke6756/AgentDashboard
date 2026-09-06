import assert from 'node:assert/strict';
import os from 'node:os';

import {
  createPlanCandidateRoutes,
  type PlanCandidateRoutesDeps,
} from './plan-candidate-routes';
import { CommitCandidateSnapshotRegistry } from '../commit-engine/snapshot-registry';
import type { CandidateInventoryRead } from '../commit-engine/candidate-service';
import type {
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
  EncodedGitPath,
  RepositoryIdentity,
} from '../../shared/commit-candidates';
import type { GitCapability } from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

const REPO_KEY = 'repo-key-1';
const OID = 'b'.repeat(40);
function b64(id: string): string { return Buffer.from(`src/${id}.ts`).toString('base64'); }
function encPath(id: string): EncodedGitPath {
  return { pathBytesBase64: b64(id), displayPath: `src/${id}.ts`, utf8Clean: true };
}
function stageStream(ids: readonly string[]): Buffer {
  return Buffer.concat(ids.flatMap((id) => [
    Buffer.from(`100644 ${OID} 0\t`, 'ascii'),
    Buffer.from(`src/${id}.ts`, 'utf8'),
    Buffer.from([0]),
  ]));
}
function repository(): RepositoryIdentity {
  return {
    repositoryKey: REPO_KEY,
    objectDatabaseKey: 'odb-1',
    gitObjectFormat: 'sha1',
    bareRepo: false,
    workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
  };
}
function entry(id: string, over: Partial<DirtyEntry> = {}): DirtyEntry {
  return {
    entryId: id,
    path: encPath(id),
    originalPath: null,
    entryKind: 'ordinary',
    indexStatus: '.',
    worktreeStatus: 'M',
    headMode: '100644',
    indexMode: '100644',
    worktreeMode: '100644',
    submoduleState: null,
    renameOrCopyScore: null,
    expectedWorktreeState: 'present',
    rawWorktreeBlobOid: `raw-${id}`,
    gitLevelEligibility: 'supported',
    commitPathspecs: [encPath(id)],
    ...over,
  };
}
function component(
  componentId: string,
  entryIds: string[],
  planId: string | null = 'plan-A',
  planItemId: string | null = null,
): ConflictComponent {
  return {
    componentId,
    dirtyEntryIds: entryIds,
    associations: [{ planId, planItemId, contributingTurnIds: ['t1'], memberEntryIds: entryIds }],
    overlap: {
      componentId,
      contributingAgentCount: 1,
      mergedGroupCount: 1,
      perPathContributors: {},
    },
    componentTopologyDigest: `topo-${componentId}`,
  };
}
function inventory(entries: DirtyEntry[], unattributedEntryIds: string[] = []): DirtyInventory {
  return { repository: repository(), entries, unattributedEntryIds, topologyDigest: 'inv-topo' };
}
function read(over: Partial<CandidateInventoryRead> = {}): CandidateInventoryRead {
  return {
    inventory: inventory([entry('e1')]),
    components: [component('c1', ['e1'])],
    captureHealthByComponentId: {},
    unattributedCaptureHealth: {} as never,
    protectionByEntryId: {},
    planAttributionUnavailableTurnIds: new Set<string>(),
    quotaWeakening: null,
    ...over,
  };
}
function capability(): GitCapability {
  return {
    resolution: {} as never,
    repoState: null,
    commonDir: '/repo/.git',
    commonDirQueueKey: 'repo',
    repoRoot: '/repo',
    workspacePrefix: '',
    protectedRoot: false,
    reason: 'ok' as never,
    detail: null,
  };
}
function baseDeps(over: Partial<PlanCandidateRoutesDeps> = {}): PlanCandidateRoutesDeps {
  return {
    gitExe: 'git',
    getWorkspaces: () => [{ id: 'ws-1', path: '/repo' }],
    probeWorkspaceGit: async () => capability(),
    realpath: (p) => p,
    assembleInventory: async () => read(),
    listRepoCommitPathLinks: () => [],
    getPackageFinalization: () => null,
    getSaveIntentFinalization: () => null,
    runGit: (async (_cwd, args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'a'.repeat(40) + '\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }) as PlanCandidateRoutesDeps['runGit'],
    runGitBytes: (async (_cwd, args) => {
      if (args[0] === 'ls-files') return { code: 0, stdout: stageStream(['e1', 'e2']), stderr: '' };
      return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
    }) as PlanCandidateRoutesDeps['runGitBytes'],
    ...over,
  };
}
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

test('plan preview coalesces concurrent assemblies through the injected registry', async () => {
  const registry = new CommitCandidateSnapshotRegistry<CandidateInventoryRead>();
  let assemblies = 0;
  let acquireCalls = 0;
  const gate = deferred();
  const real = registry.acquire.bind(registry);
  registry.acquire = ((key, compute, options) => {
    acquireCalls += 1;
    if (acquireCalls >= 2) gate.resolve();
    return real(key, async (signal) => { await gate.promise; return compute(signal); }, options);
  }) as typeof registry.acquire;
  const routes = createPlanCandidateRoutes(baseDeps({
    snapshotRegistry: registry,
    assembleInventory: async () => { assemblies += 1; return read(); },
  }));
  const req = {
    workspaceId: 'ws-1', planId: 'plan-A', selectedComponentIds: ['c1'],
    selectedUnattributedEntryIds: [], finalizationIds: [],
  };
  await Promise.all([routes.resolvePreviewContext(req), routes.resolvePreviewContext(req)]);
  assert.equal(acquireCalls, 2, 'both plan preview requests routed through the injected registry');
  assert.equal(assemblies, 1, 'the shared registry computed the canonical snapshot exactly once');
});

test('plan lens defaults to the plan-owned components when the request omits them', async () => {
  const routes = createPlanCandidateRoutes(baseDeps({
    assembleInventory: async () => read({
      inventory: inventory([entry('e1'), entry('e2')]),
      components: [component('c1', ['e1'], 'plan-A'), component('c2', ['e2'], 'plan-B')],
    }),
    getPackageFinalization: (id) => id === 'fin-1' ? ({
      id, packageId: 'pkg-1', repositoryKey: REPO_KEY, finalizationKind: 'fleet-adhoc',
      planId: null, planItemId: null, packageRevision: 3, finalizedAt: 1,
      finalizedBy: 'human-ipc', checkpointTurnId: null, checkpointOid: 'boundary-oid',
      boundaryRef: 'refs/lares/fin-1', boundaryStatus: 'ready', lifecycleStatus: 'active',
      supersededByFinalizationId: null, releasedAt: null,
      memberManifestJson: JSON.stringify([{
        pathBytesBase64: b64('e1'), expectedState: 'present', rawBlobOid: 'raw-e1',
        commitBlobOid: 'commit-e1', commitMode: '100644',
      }]),
      contractVersion: 1, failureReason: null, createdFromWorkspaceId: null,
    }) : null,
  }));
  const context = await routes.resolvePreviewContext({
    workspaceId: 'ws-1', planId: 'plan-A', selectedComponentIds: [],
    selectedUnattributedEntryIds: [], finalizationIds: ['fin-1'],
  });
  assert.equal(context.components.length, 2);
  assert.deepEqual([...context.currentCommitReps.keys()], ['e1']);
});

test('an unknown target workspace is rejected honestly', async () => {
  const routes = createPlanCandidateRoutes(baseDeps({
    getWorkspaces: () => [{ id: 'other', path: '/elsewhere' }],
  }));
  await assert.rejects(
    () => routes.resolvePreviewContext({
      workspaceId: 'ws-1', planId: 'plan-A', selectedComponentIds: [],
      selectedUnattributedEntryIds: [], finalizationIds: [],
    }),
    /unknown workspace/i,
  );
});

test('plan done resolver enriches identity from package state and fake checkpoint engine', async () => {
  const captures: Array<{ workspaceId: string; label: string }> = [];
  const boundaryOid = 'd'.repeat(40);
  const routes = createPlanCandidateRoutes(baseDeps({
    getPlanWorkPackage: (id) => id === 'wp-1' ? {
      id, workspaceId: 'ws-1', planId: 'plan-A', title: 'Package',
      acceptanceCondition: null, state: 'executing', assigneeAgentId: null,
      revision: 1, createdAt: 1, updatedAt: 1,
    } : null,
    listPlanWorkPackagePaths: (id) => id === 'wp-1' ? [{
      packageId: id, workspaceId: 'ws-1', path: 'src/e2.ts', intentKind: null, createdAt: 1,
    }] : [],
    assembleInventory: async () => read({
      inventory: inventory([entry('e1'), entry('e2')], ['e2']),
      components: [component('c1', ['e1'], 'plan-A', 'wp-1')],
    }),
    captureFinalizationBoundary: async (workspaceId, label) => {
      captures.push({ workspaceId, label });
      return { oid: boundaryOid, treeOid: 'e'.repeat(40) };
    },
  }));
  assert.ok(routes.resolveFinalizeRequest);
  const result = await routes.resolveFinalizeRequest!('wp-1');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(captures, [{ workspaceId: 'ws-1', label: 'lares:finalization:plan-package:wp-1' }]);
  assert.equal(result.request.repositoryKey, REPO_KEY);
  assert.equal(result.request.boundaryOid, boundaryOid);
  assert.equal(result.request.repoRoot, '/repo');
  assert.equal(result.request.pinnedHeadOid, 'a'.repeat(40));
  assert.deepEqual(
    result.request.members.map((candidate) => candidate.path.pathBytesBase64).sort(),
    [b64('e1'), b64('e2')].sort(),
  );
});

function callableProxy(): any {
  const target = () => undefined;
  return new Proxy(target, {
    get: (_value, key) => key === 'then' ? undefined : callableProxy(),
    apply: () => callableProxy(),
    construct: () => callableProxy(),
  });
}

function loadProductionIndex(): typeof import('../index') {
  const electronPath = require.resolve('electron');
  const indexPath = require.resolve('../index');
  const priorElectron = require.cache[electronPath];
  const inert = callableProxy();
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: new Proxy({}, {
    get: (_target, key) => {
      if (key === 'app') return {
        getPath: () => os.tmpdir(),
        whenReady: () => new Promise<void>(() => undefined),
        requestSingleInstanceLock: () => true,
        setAppUserModelId: () => undefined,
        on: () => undefined,
        commandLine: { appendSwitch: () => undefined },
      };
      if (key === 'crashReporter') return { start: () => undefined };
      if (key === 'ipcMain') return { handle: () => undefined, on: () => undefined };
      return inert;
    },
  }) } as any;
  delete require.cache[indexPath];
  const priorChromeVersion = process.versions.chrome;
  Object.defineProperty(process.versions, 'chrome', { configurable: true, value: '146.0.0.0' });
  try {
    return require('../index') as typeof import('../index');
  } finally {
    if (priorChromeVersion === undefined) delete (process.versions as { chrome?: string }).chrome;
    else Object.defineProperty(process.versions, 'chrome', { configurable: true, value: priorChromeVersion });
    if (priorElectron) require.cache[electronPath] = priorElectron; else delete require.cache[electronPath];
  }
}

test('production index wiring provides and executes the plans-owned route', async () => {
  let provided: ReturnType<typeof createPlanCandidateRoutes> | null = null;
  const production = loadProductionIndex();
  production.wirePlanCandidateRoutes(baseDeps(), (routes) => { provided = routes; });
  const wired = provided as ReturnType<typeof createPlanCandidateRoutes> | null;
  assert.ok(wired, 'REACHABILITY:plan-candidate-routes index must provide the constructed route');
  const context = await wired.resolvePreviewContext({
    workspaceId: 'ws-1', planId: 'plan-A', selectedComponentIds: ['c1'],
    selectedUnattributedEntryIds: [], finalizationIds: [],
  });
  assert.equal(context.repository.repositoryKey, REPO_KEY);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ✓ ${t.name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${t.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} plan-candidate-routes tests passed`);
})();
