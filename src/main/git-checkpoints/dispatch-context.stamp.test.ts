// Save-card SC-WP-2B — trusted plan-stamp resolution and wire-forgery guards.

import assert from 'node:assert/strict';
import http from 'node:http';

import type { GitCapability } from '../../shared/types';
import {
  buildDispatchTurnContext,
  resolveRequestedPlanBinding,
  withResolvedIntentStamp,
  withPlanningActivityBinding,
  withResolvedPlanStamp,
  type DispatchContext,
  type DispatchAgentInfo,
  type DispatchDeps,
} from './dispatch-context';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const agent: DispatchAgentInfo = { workspaceId: 'ws-1', planId: 'plan-default' };

function capability(): GitCapability {
  return {
    resolution: { agentShell: { source: null, note: '' }, internal: null },
    repoState: 'repo', commonDir: '/repo/.git', commonDirQueueKey: '/repo',
    repoRoot: '/repo', workspacePrefix: '', protectedRoot: false, reason: 'ok', detail: null,
  };
}

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    getAgent: (id) => id === 'worker' ? agent : null,
    resolveCapability: async () => capability(),
    planInWorkspace: (workspaceId, planId) => workspaceId === 'ws-1' && planId === 'plan-explicit',
    planItemInPlan: () => false,
    ...over,
  };
}

test('omitted binding resolves the frozen agent default; explicit none stays distinguishable', () => {
  assert.deepEqual(resolveRequestedPlanBinding(deps(), agent, undefined), {
    ok: true,
    stamp: { planId: 'plan-default', planItemId: null, source: 'agent-default' },
  });
  assert.deepEqual(resolveRequestedPlanBinding(deps(), agent, { mode: 'none' }), {
    ok: true,
    stamp: { planId: null, planItemId: null, source: 'explicit-none' },
  });
});

test('agent-default null resolves the direct owner executing plan as owner-focus', () => {
  const ownerIds: string[] = [];
  const ownerAgent: DispatchAgentInfo = {
    workspaceId: 'ws-1', planId: null, ownerAgentId: 'owner-1',
  };
  assert.deepEqual(resolveRequestedPlanBinding(deps({
    resolveOwnerFocusPlan: (ownerAgentId) => {
      ownerIds.push(ownerAgentId);
      return 'plan-owner';
    },
  }), ownerAgent, undefined), {
    ok: true,
    stamp: { planId: 'plan-owner', planItemId: null, source: 'owner-focus' },
  });
  assert.deepEqual(ownerIds, ['owner-1'], 'only the direct durable owner is consulted');
});

test('explicit none never consults owner-focus', () => {
  let ownerCalls = 0;
  const ownerAgent: DispatchAgentInfo = {
    workspaceId: 'ws-1', planId: null, ownerAgentId: 'owner-1',
  };
  assert.deepEqual(resolveRequestedPlanBinding(deps({
    resolveOwnerFocusPlan: () => { ownerCalls += 1; return 'plan-owner'; },
  }), ownerAgent, { mode: 'none' }), {
    ok: true,
    stamp: { planId: null, planItemId: null, source: 'explicit-none' },
  });
  assert.equal(ownerCalls, 0);
});

test('a non-null agent default wins without consulting owner-focus', () => {
  let ownerCalls = 0;
  const ownerAgent: DispatchAgentInfo = {
    workspaceId: 'ws-1', planId: 'plan-agent', ownerAgentId: 'owner-1',
  };
  const d = deps({
    resolveOwnerFocusPlan: () => { ownerCalls += 1; return 'plan-owner'; },
  });
  assert.deepEqual(resolveRequestedPlanBinding(d, ownerAgent, undefined), {
    ok: true,
    stamp: { planId: 'plan-agent', planItemId: null, source: 'agent-default' },
  });
  assert.equal(ownerCalls, 0);

  assert.deepEqual(resolveRequestedPlanBinding(deps({
    resolveActivePlanDefault: () => 'plan-active',
    resolveOwnerFocusPlan: () => { ownerCalls += 1; return 'plan-owner'; },
  }), { ...ownerAgent, planId: null }, undefined), {
    ok: true,
    stamp: { planId: 'plan-active', planItemId: null, source: 'agent-default' },
  });
  assert.equal(ownerCalls, 0);
});

test('owner-focus lookup failures degrade to agent-default unknown without dropping the turn', () => {
  const unknown = {
    ok: true,
    stamp: { planId: null, planItemId: null, source: 'agent-default' },
  } as const;
  let ownerCalls = 0;
  assert.deepEqual(resolveRequestedPlanBinding(deps({
    resolveOwnerFocusPlan: () => { ownerCalls += 1; return 'plan-owner'; },
  }), { workspaceId: 'ws-1', planId: null }, undefined), unknown);
  assert.equal(ownerCalls, 0, 'no durable owner means no lookup');

  const ownerAgent: DispatchAgentInfo = {
    workspaceId: 'ws-1', planId: null, ownerAgentId: 'missing-owner',
  };
  assert.deepEqual(resolveRequestedPlanBinding(deps({
    resolveOwnerFocusPlan: () => { ownerCalls += 1; return null; },
  }), ownerAgent, undefined), unknown, 'missing/non-executing owner returns null');
  assert.equal(ownerCalls, 1);

  assert.deepEqual(resolveRequestedPlanBinding(deps({
    resolveOwnerFocusPlan: () => { ownerCalls += 1; throw new Error('lookup failed'); },
  }), ownerAgent, undefined), unknown, 'resolver throws fail closed');
  assert.equal(ownerCalls, 2);

  assert.deepEqual(resolveRequestedPlanBinding(deps(), ownerAgent, undefined), unknown,
    'an unwired resolver preserves the unknown turn');
});

test('owner-focus gate rejection or throw degrades to agent-default unknown', () => {
  const ownerAgent: DispatchAgentInfo = {
    workspaceId: 'ws-1', planId: null, ownerAgentId: 'owner-1',
  };
  const unknown = {
    ok: true,
    stamp: { planId: null, planItemId: null, source: 'agent-default' },
  } as const;
  let gateCalls = 0;
  assert.deepEqual(resolveRequestedPlanBinding(deps({
    resolveOwnerFocusPlan: () => 'plan-owner',
    planImplementGate: () => {
      gateCalls += 1;
      return { isStructured: true, hasActiveExecutionRun: false };
    },
  }), ownerAgent, undefined), unknown);
  assert.equal(gateCalls, 1);

  assert.deepEqual(resolveRequestedPlanBinding(deps({
    resolveOwnerFocusPlan: () => 'plan-owner',
    planImplementGate: () => { gateCalls += 1; throw new Error('gate failed'); },
  }), ownerAgent, undefined), unknown);
  assert.equal(gateCalls, 2);
});

test('explicit plan is workspace-validated and never falls back to the agent default', () => {
  assert.deepEqual(resolveRequestedPlanBinding(deps(), agent, {
    mode: 'explicit', planId: 'plan-explicit', planItemId: null,
  }), {
    ok: true,
    stamp: { planId: 'plan-explicit', planItemId: null, source: 'explicit' },
  });
  assert.deepEqual(resolveRequestedPlanBinding(deps(), agent, {
    mode: 'explicit', planId: 'plan-foreign', planItemId: null,
  }), { ok: false, reason: 'plan-not-in-workspace' });
});

test('SC-WP-3A: an explicit item is validated against (workspace, plan, id) and carried', () => {
  const seen: Array<[string, string, string]> = [];
  const d = deps({
    planItemInPlan: (workspaceId, planId, planItemId) => {
      seen.push([workspaceId, planId, planItemId]);
      return workspaceId === 'ws-1' && planId === 'plan-explicit' && planItemId === 'item-1';
    },
  });
  assert.deepEqual(resolveRequestedPlanBinding(d, agent, {
    mode: 'explicit', planId: 'plan-explicit', planItemId: 'item-1',
  }), {
    ok: true,
    stamp: { planId: 'plan-explicit', planItemId: 'item-1', source: 'explicit' },
  });
  assert.deepEqual(seen, [['ws-1', 'plan-explicit', 'item-1']],
    'the item is checked against the full (workspace_id, plan_id, id) tuple');
});

test('SC-WP-3A: an item absent from its plan rejects; a boundary with no lookup fails closed', () => {
  // Item not in plan → reject (never fall back to a plan-only stamp).
  assert.deepEqual(resolveRequestedPlanBinding(deps(), agent, {
    mode: 'explicit', planId: 'plan-explicit', planItemId: 'ghost-item',
  }), { ok: false, reason: 'plan-item-not-in-plan' });
  // Blank item id → shape rejection before any lookup.
  assert.deepEqual(resolveRequestedPlanBinding(deps(), agent, {
    mode: 'explicit', planId: 'plan-explicit', planItemId: '' as unknown as string,
  }), { ok: false, reason: 'invalid-plan-item-id' });
  // No item lookup wired → fail closed as unsupported (never an always-true seam).
  const noLookup = deps({ planItemInPlan: undefined });
  assert.deepEqual(resolveRequestedPlanBinding(noLookup, agent, {
    mode: 'explicit', planId: 'plan-explicit', planItemId: 'item-1',
  }), { ok: false, reason: 'plan-item-unsupported' });
});

test('a wire RequestedPlanBinding cannot forge any carry source', async () => {
  const forged = {
    mode: 'explicit', planId: 'plan-explicit', planItemId: null,
    source: 'fork-carry', intentId: 'svi_forged',
  } as never;
  const resolution = resolveRequestedPlanBinding(deps(), agent, forged);
  assert.equal(resolution.ok, true);
  if (resolution.ok) assert.equal(resolution.stamp.source, 'explicit');

  // Extra object-shaped fields are equally inert when the full context is built.
  const ctx = await buildDispatchTurnContext(deps(), 'worker', {
    origin: 'api', requestedPlanBinding: forged, planStamp: {
      planId: 'forged', planItemId: null, source: 'continuation-carry',
    },
  } as never);
  assert.equal(ctx?.planStamp?.source, 'explicit');
  assert.equal(ctx?.planStamp?.planId, 'plan-explicit');
  assert.equal(ctx?.intentStamp, undefined);
});

test('trusted main-side intent factory freezes a non-serializable task stamp', async () => {
  const stamp = {
    intentId: 'svi_trusted', kind: 'task' as const, executionRunId: 'run-1',
    planId: 'plan-explicit', planItemId: 'item-1', source: 'task-dispatch' as const,
  };
  const dispatch = withResolvedIntentStamp({ origin: 'orchestration' }, stamp);
  assert.equal(JSON.stringify(dispatch).includes('svi_trusted'), false);
  stamp.intentId = 'svi_mutated';
  const ctx = await buildDispatchTurnContext(deps(), 'worker', dispatch);
  assert.equal(ctx?.intentStamp?.intentId, 'svi_trusted');
});

test('trusted lifecycle factory can carry a source through the non-wire symbol path', async () => {
  const dispatch = withResolvedPlanStamp(
    { origin: 'orchestration', requestedPlanBinding: { mode: 'none' } },
    { planId: 'plan-carried', planItemId: null, source: 'fork-carry' },
  );
  assert.equal(JSON.stringify(dispatch).includes('fork-carry'), false, 'trusted stamp is not wire-serializable');
  const ctx = await buildDispatchTurnContext(deps(), 'worker', dispatch);
  assert.deepEqual(ctx?.planStamp, {
    planId: 'plan-carried', planItemId: null, source: 'fork-carry',
  });
});

test('trusted planning activity binding resolves capability from the physical worktree', async () => {
  let primaryCalls = 0;
  let activityCalls = 0;
  const dispatch = withPlanningActivityBinding({ origin: 'orchestration' }, {
    executionRunId: 'run-1', path: '/app/planning-worktrees/run-1',
    repositoryKey: 'activity-key', objectDatabaseKey: '/repo/.git',
  });
  assert.equal(JSON.stringify(dispatch).includes('planning-worktrees'), false);
  const ctx = await buildDispatchTurnContext(deps({
    resolveCapability: async () => { primaryCalls += 1; return capability(); },
    resolveActivityCapability: async (binding) => {
      activityCalls += 1;
      return { ...capability(), repoRoot: binding.path };
    },
  }), 'worker', dispatch);
  assert.equal(primaryCalls, 0);
  assert.equal(activityCalls, 1);
  assert.equal(ctx?.capability.repoRoot, '/app/planning-worktrees/run-1');
});

interface ProductionHarness {
  api: {
    route(method: string, url: URL, req: http.IncomingMessage, identity: unknown): Promise<unknown>;
  };
  handlers: Map<string, (...args: any[]) => any>;
  httpDispatches: DispatchContext[];
  ipcDispatches: DispatchContext[];
  engine: {
    buildTurnContext(agentId: string, dispatch: DispatchContext): Promise<{ planStamp?: unknown } | null>;
  };
  ownerQueryIds: string[];
}

let productionHarnessPromise: Promise<ProductionHarness> | undefined;

function makeSqlFixture(SQL: any, ownerQueryIds: string[]): any {
  const sqlDb = new SQL.Database();
  sqlDb.exec(`
    CREATE TABLE plans (
      id TEXT PRIMARY KEY, workspace_id TEXT, slug TEXT, path TEXT,
      responsible_supervisor_id TEXT, deleted_at INTEGER, run_state TEXT
    );
    CREATE TABLE supervisor_active_plan (supervisor_id TEXT PRIMARY KEY, plan_id TEXT);
    CREATE TABLE plan_execution_runs (plan_id TEXT, lifecycle_state TEXT);
    INSERT INTO plans VALUES (
      'plan-owner', 'ws-1', 'owner-plan', '/plans/owner-plan.md',
      'owner-supervisor', NULL, 'executing'
    );
    INSERT INTO supervisor_active_plan VALUES ('owner-supervisor', 'plan-owner');
    INSERT INTO plan_execution_runs VALUES ('plan-owner', 'active');
  `);
  return {
    prepare(sql: string) {
      return {
        get(...params: unknown[]) {
          if (sql.includes('FROM supervisor_active_plan')) ownerQueryIds.push(String(params[0]));
          const statement = sqlDb.prepare(sql);
          try {
            statement.bind(params);
            return statement.step() ? statement.getAsObject() : undefined;
          } finally {
            statement.free();
          }
        },
      };
    },
  };
}

async function productionHarness(): Promise<ProductionHarness> {
  if (productionHarnessPromise) return productionHarnessPromise;
  productionHarnessPromise = (async () => {
    const initSqlJs = require('sql.js') as () => Promise<any>;
    const SQL = await initSqlJs();
    const ownerQueryIds: string[] = [];
    const sqlFixture = makeSqlFixture(SQL, ownerQueryIds);
    const agents = new Map<string, any>([
      ['worker', {
        id: 'worker', workspaceId: 'ws-1', planId: null, ownerAgentId: 'owner-supervisor',
        status: 'idle', title: 'Worker', resumeSessionId: null, continuationGeneration: 0,
      }],
      ['nested-worker', {
        id: 'nested-worker', workspaceId: 'ws-1', planId: null, ownerAgentId: 'worker-owner',
        status: 'idle', title: 'Nested worker', resumeSessionId: null, continuationGeneration: 0,
      }],
      ['worker-owner', {
        id: 'worker-owner', workspaceId: 'ws-1', planId: null, ownerAgentId: 'owner-supervisor',
        status: 'idle', title: 'Direct worker owner', resumeSessionId: null, continuationGeneration: 0,
      }],
      ['owner-supervisor', {
        id: 'owner-supervisor', workspaceId: 'ws-1', planId: null, ownerAgentId: null,
        status: 'idle', title: 'Executing supervisor', resumeSessionId: null, continuationGeneration: 0,
      }],
    ]);

    const database = require('../database') as Record<string, any>;
    database.getDb = () => sqlFixture;
    database.getAgent = (id: string) => agents.get(id) ?? null;
    database.getPlan = (id: string) => id === 'plan-owner'
      ? { id, workspaceId: 'ws-1', deletedAt: null }
      : null;
    database.planItemInPlan = () => false;
    database.getWorkspace = (id: string) => id === 'ws-1'
      ? { id, path: 'C:/repo', pathType: 'local', title: 'Workspace' }
      : null;
    database.getWorkspaces = () => [];

    const handlers = new Map<string, (...args: any[]) => any>();
    const noop = () => undefined;
    const electronPath = require.resolve('electron');
    require.cache[electronPath] = {
      id: electronPath,
      filename: electronPath,
      loaded: true,
      exports: {
        ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
        app: { getPath: () => 'C:/temp', isPackaged: false, on: noop },
        dialog: { showOpenDialog: noop, showMessageBox: noop },
        shell: { openExternal: noop, trashItem: noop },
        BrowserWindow: class {},
        nativeTheme: { on: noop, themeSource: 'system', shouldUseDarkColors: false },
      },
      children: [],
      paths: [],
    } as any;

    const httpDispatches: DispatchContext[] = [];
    const ipcDispatches: DispatchContext[] = [];
    const confirmedOutcome = (agentId: string) => ({
      disposition: 'confirmed', agentId, delivered: true,
      confirmationSource: 'hook', completedAt: Date.now(),
    });
    const supervisor = new Proxy({
      isInputInFlight: () => false,
      registerTransientTurnSubscription: () => ({ registered: true }),
      cancelTransientTurnSubscriptionsForPair: noop,
      sendInput: async (_agentId: string, _text: string, _opts: unknown, dispatch: DispatchContext) => {
        httpDispatches.push(dispatch);
        return true;
      },
      sendInputWithOutcome: async (agentId: string, _text: string, _opts: unknown, dispatch: DispatchContext) => {
        ipcDispatches.push(dispatch);
        return confirmedOutcome(agentId);
      },
      on: noop,
    }, { get: (target, key) => key in target ? (target as any)[key] : noop });
    const mainWindow = new Proxy({
      isDestroyed: () => false,
      webContents: { send: noop },
    }, { get: (target, key) => key in target ? (target as any)[key] : noop });

    const { ApiServer } = require('../api-server') as typeof import('../api-server');
    const api = new ApiServer(supervisor as any, 0, undefined, '127.0.0.1') as any;
    const ipcModule = require('../ipc-handlers') as typeof import('../ipc-handlers');
    ipcModule.registerIpcHandlers(supervisor as any, mainWindow as any, {} as any);

    const gitRuntime = require('../git/git-runtime') as Record<string, any>;
    gitRuntime.resolveInternalGit = async () => ({ execPath: 'git' });
    gitRuntime.probeWorkspaceGit = async () => capability();
    const engineModule = require('./engine-bootstrap') as typeof import('./engine-bootstrap');
    const engine = await engineModule.createCheckpointEngine();
    assert.ok(engine, 'the production checkpoint-engine factory must return its buildTurnContext seam');

    return { api, handlers, httpDispatches, ipcDispatches, engine, ownerQueryIds };
  })();
  return productionHarnessPromise;
}

async function stampFromFrozenDispatch(dispatch: DispatchContext): Promise<unknown> {
  return (await buildDispatchTurnContext(deps({
    getAgent: () => ({ workspaceId: 'ws-1', planId: null, ownerAgentId: 'owner-supervisor' }),
  }), 'worker', dispatch))?.planStamp;
}

async function callProductionHttpSend(harness: ProductionHarness): Promise<void> {
  const pathname = '/api/agents/worker/input';
  const req = new http.IncomingMessage(null as any);
  req.method = 'POST';
  req.url = pathname;
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify({ text: 'production HTTP owner-focus' })));
    req.emit('end');
  });
  await harness.api.route('POST', new URL(pathname, 'http://localhost'), req, {
    workspaceId: null, supervisor: null, asserted: false, projectId: null, supervisorId: null,
  });
}

test('[http] real ApiServer send route freezes the direct owner executing plan', async () => {
  const harness = await productionHarness();
  harness.httpDispatches.length = 0;
  await callProductionHttpSend(harness);
  assert.equal(harness.httpDispatches.length, 1);
  assert.deepEqual(await stampFromFrozenDispatch(harness.httpDispatches[0]), {
    planId: 'plan-owner', planItemId: null, source: 'owner-focus',
  });
});

test('[ipc] real registerIpcHandlers send handler freezes the direct owner executing plan', async () => {
  const harness = await productionHarness();
  harness.ipcDispatches.length = 0;
  const handler = harness.handlers.get('agent:send-input');
  assert.ok(handler, 'the production registerIpcHandlers path must register agent:send-input');
  await handler({}, 'worker', 'production IPC owner-focus');
  assert.equal(harness.ipcDispatches.length, 1);
  assert.deepEqual(await stampFromFrozenDispatch(harness.ipcDispatches[0]), {
    planId: 'plan-owner', planItemId: null, source: 'owner-focus',
  });
});

test('[engine] real checkpoint-engine factory builds owner-focus and stops at one owner hop', async () => {
  const harness = await productionHarness();
  harness.ownerQueryIds.length = 0;
  const ownerContext = await harness.engine.buildTurnContext('worker', { origin: 'orchestration' });
  assert.deepEqual(ownerContext?.planStamp, {
    planId: 'plan-owner', planItemId: null, source: 'owner-focus',
  });

  harness.ownerQueryIds.length = 0;
  const nestedContext = await harness.engine.buildTurnContext('nested-worker', { origin: 'orchestration' });
  assert.deepEqual(nestedContext?.planStamp, {
    planId: null, planItemId: null, source: 'agent-default',
  });
  assert.deepEqual(harness.ownerQueryIds, ['worker-owner'],
    'the production SQL resolver must query only the direct worker owner, never its executing grand-owner');
});

(async () => {
  let passed = 0, failed = 0;
  const seamFilter = process.env.WP5_SEAM;
  const selectedTests = seamFilter ? tests.filter((entry) => entry.name.startsWith(`[${seamFilter}]`)) : tests;
  for (const t of selectedTests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
