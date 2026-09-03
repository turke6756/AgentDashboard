// WP-P5-dispatch — durable package send/confirmation/reconciliation.
//
//   npm run build:main
//   node dist/main/main/plans/package-dispatch.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): {
    bind(params: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  };
};

let sqlJsCtor: new () => SqlJsDatabase;
class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;
  private transactionSerial = 0;
  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) { store = new sqlJsCtor(); FakeBetterSqlite.stores.set(dbPath, store); }
    this.db = store;
  }
  pragma(_sql: string): unknown { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; }
        finally { stmt.free(); }
      },
      all: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally { stmt.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => {
      const savepoint = `fake_transaction_${++this.transactionSerial}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try { const result = fn(...args); this.db.exec(`RELEASE ${savepoint}`); return result; }
      catch (err) {
        this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); throw err;
      }
    };
  }
}

type WorkPackage = {
  id: string; workspaceId: string; planId: string; title: string;
  acceptanceCondition: string | null;
  state: 'ready' | 'executing' | 'blocked' | 'done' | 'archived';
  assigneeAgentId: string | null;
  revision: number; createdAt: number; updatedAt: number;
};
type DbModule = typeof import('../database');
type ServiceModule = typeof import('./plan-lifecycle');
let dbm: DbModule;
let svc: ServiceModule;
let serial = 0;

function seed(activeRun = true): {
  workspaceId: string; planId: string; packageId: string; agentId: string; runId: string; intentId: string;
} {
  serial += 1;
  const ws = dbm.createWorkspace({ title: `W${serial}`, path: `C:/w${serial}`, pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({
    workspaceId: ws.id, path: `p/${serial}`, format: 'structured',
    runState: activeRun ? 'executing' : 'ready',
  });
  const artifactId = `plan_${serial.toString(16).padStart(8, '0')}`;
  const intentId = `int_${serial.toString(16).padStart(8, '0')}`;
  dbm.getDb().prepare('UPDATE plans SET artifact_id = ? WHERE id = ?').run(artifactId, plan.id);
  dbm.getDb().prepare(
    `INSERT INTO plan_intents
       (id, workspace_id, plan_id, plan_artifact_id, intent_id, kind,
        source_doc_rel_path, status, first_seen_at, updated_at, last_scanned_at)
     VALUES (?, ?, ?, ?, ?, 'research', 'plan.md', 'active', 1, 1, 1)`,
  ).run(`intent-row-${serial}`, ws.id, plan.id, artifactId, intentId);
  const agent = dbm.createAgent({
    workspaceId: ws.id, title: `worker-${serial}`, roleDescription: '',
    workingDirectory: `C:/w${serial}`, command: 'x', tmuxSessionName: null,
    autoRestartEnabled: false, logPath: `log-${serial}`, isWorker: true,
  });
  const packageId = `pkg-${serial}`;
  dbm.upsertPlanWorkPackage({
    id: packageId, workspaceId: ws.id, planId: plan.id, title: `Package ${serial}`,
    acceptanceCondition: null, state: 'ready', assigneeAgentId: agent.id,
    revision: 1, createdAt: 1000 + serial, updatedAt: 1000 + serial,
    intentId, schemaVersion: 2, contentHash: `hash-${serial}`, projectionStatus: 'synced',
  } as WorkPackage);
  const runId = `run-${serial}`;
  if (activeRun) {
    dbm.getDb().prepare(
      `INSERT INTO plan_execution_runs
         (id, plan_id, repository_key, baseline_kind, baseline_head_oid, baseline_ref,
          trigger_source, app_user_id, triggered_at, lifecycle_state)
       VALUES (?, ?, ?, 'unborn', NULL, NULL, 'renderer-user-action', NULL, ?, 'active')`,
    ).run(runId, plan.id, `primary-${runId}`, 1000);
  }
  return { workspaceId: ws.id, planId: plan.id, packageId, agentId: agent.id, runId, intentId };
}

function openStampedTurn(
  s: ReturnType<typeof seed>, id: string, startedAt: number,
  intent?: { intentId: string; source: string },
): void {
  dbm.allocateAndInsertTurn(s.workspaceId, {
    id, agentId: s.agentId, planId: s.planId, planItemId: s.packageId,
    planStampSource: 'explicit', startedAt, status: 'open',
    intentId: intent?.intentId ?? s.intentId, intentStampSource: intent?.source ?? 'explicit',
  });
}

function insertStampedTurnWithoutReconcile(
  s: ReturnType<typeof seed>, id: string, startedAt: number, intentId: string,
): void {
  const next = dbm.getDb().prepare(
    'SELECT COALESCE(MAX(turn_seq), 0) + 1 AS next FROM turn_records WHERE workspace_id = ?',
  ).get(s.workspaceId) as { next: number };
  dbm.getDb().prepare(
    `INSERT INTO turn_records
       (id, workspace_id, turn_seq, agent_id, plan_id, plan_item_id,
        plan_stamp_source, intent_id, intent_stamp_source, started_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'explicit', ?, 'task-dispatch', ?, 'open')`,
  ).run(id, s.workspaceId, next.next, s.agentId, s.planId, s.packageId, intentId, startedAt);
}

function activeActivity(s: ReturnType<typeof seed>): import('../database').PlanningActivityWorktree {
  return {
    executionRunId: s.runId, planId: s.planId, logicalWorkspaceId: s.workspaceId,
    objectDatabaseKey: '/r', activityRepositoryKey: `activity-${s.runId}`,
    primaryRepositoryKey: `primary-${s.runId}`, path: `C:/w${serial}`,
    baselineOid: 'b'.repeat(40), activityHeadRef: `refs/lares/activities/${s.runId}/head`,
    promotedHeadOid: null, state: 'active', failureCode: null, createdAt: 1000, updatedAt: 1000,
  };
}

test('schema has the exact dispatch-attempt columns and bounded states', () => {
  const rows = dbm.getDb().prepare('PRAGMA table_info(plan_dispatch_attempts)').all() as Array<{ name: string }>;
  assert.deepEqual(rows.map((r) => r.name), [
    'id', 'package_id', 'plan_id', 'execution_run_id', 'target_agent_id',
    'requested_plan_item_id', 'confirmed_turn_id', 'state', 'created_at',
    'confirmed_at', 'reconciled_at', 'intent_id', 'package_revision',
    'orchestration_id', 'target_session_id', 'repository_key', 'branch_ref',
    'dispatch_tip_oid', 'frozen_paths_json', 'capture_status', 'capture_failure',
  ]);
});

test('planning activity row persists before run activation and flips active atomically', () => {
  const s = seed(false);
  const provisioning = activeActivity(s);
  provisioning.state = 'provisioning';
  dbm.insertPlanningActivityWorktreeProvisioning(provisioning);
  assert.equal(dbm.getPlanExecutionRun(s.runId), null);
  assert.equal(dbm.getPlanningActivityWorktree(s.runId)?.state, 'provisioning');
  dbm.insertPlanExecutionRunActivating({
    id: s.runId, planId: s.planId, repositoryKey: provisioning.primaryRepositoryKey,
    baselineKind: 'head', baselineHeadOid: provisioning.baselineOid,
    baselineRef: provisioning.activityHeadRef, triggerSource: 'renderer-user-action',
    triggeredAt: 1500, planningActivityExecutionRunId: s.runId,
  });
  assert.equal(dbm.getPlanningActivityWorktree(s.runId)?.state, 'active');
  assert.equal(dbm.getPlan(s.planId)?.runState, 'executing');
});

test('dispatch confirmation binds the private intent and tolerates turn-insert reconciliation winning the race', async () => {
  const s = seed();
  let sawPendingBeforeSend = false;
  const result = await svc.dispatchPlanPackage({
    attemptId: `attempt-${serial}`, lifecycleEventId: `event-${serial}`,
    packageId: s.packageId, planId: s.planId, planItemId: s.packageId,
    targetAgentId: s.agentId, ownerAgentId: null, promptText: 'Implement package',
    createdAt: 2000,
  }, {
    getActiveActivity: () => activeActivity(s), readEnv: () => '1',
    deliver: async ({ dispatch }) => {
      const row = dbm.getPlanDispatchAttempt(`attempt-${serial}`);
      sawPendingBeforeSend = row?.state === 'pending'
        && dbm.getPlanWorkPackage(s.packageId)?.state === 'ready';
      const ctx = await import('../git-checkpoints/dispatch-context').then((m) =>
        m.buildDispatchTurnContext({
          getAgent: (id) => id === s.agentId
            ? { workspaceId: s.workspaceId, title: 'worker' } : null,
          resolveCapability: async () => ({
            resolution: { agentShell: { source: null, note: '' }, internal: null },
            repoState: 'repo', commonDir: '/r/.git', commonDirQueueKey: '/r',
            repoRoot: '/r', workspacePrefix: '', protectedRoot: false,
            reason: 'ok', detail: null,
          }),
          planImplementGate: () => ({ isStructured: true, hasActiveExecutionRun: false }),
        }, s.agentId, dispatch));
      assert.deepEqual(ctx?.planStamp, {
        planId: s.planId, planItemId: s.packageId, source: 'explicit',
      }, 'the already-gated internal dispatch retains the explicit item stamp');
      assert.equal(ctx?.intentStamp?.intentId, row?.intentId);
      assert.equal(ctx?.intentStamp?.source, 'task-dispatch');
      openStampedTurn(s, `turn-${serial}`, 2100, ctx?.intentStamp);
      return { disposition: 'confirmed', confirmedTurnId: `turn-${serial}`, confirmedAt: 2100 };
    },
  });
  assert.equal(sawPendingBeforeSend, true);
  assert.equal(result.ok, true);
  assert.equal(result.attempt?.state, 'reconciled');
  assert.equal(result.attempt?.confirmedTurnId, `turn-${serial}`);
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.state, 'executing');
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.intentId, result.attempt?.intentId);
  assert.equal(dbm.listPlanWpLifecycleEvents(s.packageId).length, 1);
  assert.equal(dbm.getTurnRecord(`turn-${serial}`)?.status, 'open',
    'terminal accepted is not required for executing');
});

test('intent get-or-create is keyed by dispatch attempt while separate briefs mint separately', async () => {
  const s = seed();
  const seen: string[] = [];
  const input = {
    attemptId: `attempt-retry-${serial}`, lifecycleEventId: `event-retry-${serial}`,
    packageId: s.packageId, planId: s.planId, planItemId: s.packageId,
    targetAgentId: s.agentId, ownerAgentId: 'supervisor-1',
    promptText: 'Implement\r\nthis package', createdAt: 2150,
  };
  const deliver = async ({ dispatch }: {
    dispatch: import('../git-checkpoints/dispatch-context').DispatchContext;
  }) => {
    const ctx = await import('../git-checkpoints/dispatch-context').then((m) =>
      m.buildDispatchTurnContext({
        getAgent: (id) => id === s.agentId
          ? { workspaceId: s.workspaceId, title: 'worker' } : null,
        resolveCapability: async () => ({
          resolution: { agentShell: { source: null, note: '' }, internal: null },
          repoState: 'repo', commonDir: '/r/.git', commonDirQueueKey: '/r',
          repoRoot: '/r', workspacePrefix: '', protectedRoot: false,
          reason: 'ok', detail: null,
        }),
      }, s.agentId, dispatch));
    assert.ok(ctx?.intentStamp?.intentId);
    seen.push(ctx.intentStamp.intentId);
    return { disposition: 'delivered-unconfirmed' as const };
  };
  await svc.dispatchPlanPackage(input, { getActiveActivity: () => activeActivity(s), readEnv: () => '1', deliver });
  await svc.dispatchPlanPackage(input, { getActiveActivity: () => activeActivity(s), readEnv: () => '1', deliver });
  await svc.dispatchPlanPackage({
    ...input, attemptId: `attempt-second-${serial}`, promptText: 'A second brief',
  }, { getActiveActivity: () => activeActivity(s), readEnv: () => '1', deliver });

  assert.equal(seen[0], seen[1], 'one dispatch retry reuses one intent');
  assert.notEqual(seen[0], seen[2], 'two briefs under one item mint two intents');
  const first = dbm.getSaveIntentByDispatchAttempt(input.attemptId);
  assert.equal(first?.id, seen[0]);
  assert.equal(first?.executionRunId, null, 'WP-1 ships execution_run_id nullable and unused');
  assert.equal(first?.briefDigest?.length, 64);
});

test('production registrar reconciles an accepted private-intent turn at insertion', async () => {
  const s = seed();
  let handler: ((event: unknown, request: unknown) => Promise<import('./plan-lifecycle').PlanPackageDispatchResponse>) | undefined;
  let deliveredIntent: string | null = null;
  svc.registerPlanPackageDispatchIpc({
    handle(channel, listener) {
      assert.equal(channel, 'plan:dispatchPackage');
      handler = listener as typeof handler;
    },
  }, {
    getActiveActivity: () => activeActivity(s), readEnv: () => '1',
    now: () => 3200,
    newId: () => `route-${serial}`,
    deliver: async ({ dispatch }) => {
      const ctx = await import('../git-checkpoints/dispatch-context').then((m) =>
        m.buildDispatchTurnContext({
          getAgent: (id) => id === s.agentId
            ? { workspaceId: s.workspaceId, title: 'worker' } : null,
          resolveCapability: async () => ({
            resolution: { agentShell: { source: null, note: '' }, internal: null },
            repoState: 'repo', commonDir: '/r/.git', commonDirQueueKey: '/r',
            repoRoot: '/r', workspacePrefix: '', protectedRoot: false,
            reason: 'ok', detail: null,
          }),
        }, s.agentId, dispatch));
      deliveredIntent = ctx?.intentStamp?.intentId ?? null;
      assert.ok(deliveredIntent, 'production delivery receives the private intent carrier');
      openStampedTurn(s, `route-turn-${serial}`, 3210, ctx?.intentStamp);
      return { disposition: 'delivered-unconfirmed' };
    },
  });

  assert.ok(handler, 'production registration must mount plan:dispatchPackage');
  const response = await handler({}, {
    attemptId: `route-attempt-${serial}`,
    packageId: s.packageId,
    promptText: 'Implement the registered package brief',
  });
  assert.equal(response.ok, true);
  assert.equal(dbm.getSaveIntentByDispatchAttempt(`route-attempt-${serial}`)?.id, deliveredIntent);
  assert.equal(dbm.getPlanDispatchAttempt(`route-attempt-${serial}`)?.state, 'reconciled');
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.state, 'executing');
});

test('failed send marks the attempt failed and leaves the package ready', async () => {
  const s = seed();
  const result = await svc.dispatchPlanPackage({
    attemptId: `attempt-${serial}`, lifecycleEventId: `event-${serial}`,
    packageId: s.packageId, planId: s.planId, planItemId: s.packageId,
    targetAgentId: s.agentId, ownerAgentId: null, promptText: 'go', createdAt: 2200,
  }, {
    getActiveActivity: () => activeActivity(s), readEnv: () => '1',
    deliver: async () => ({ disposition: 'failed', reason: 'runner gone' }),
  });
  assert.equal(result.failure, 'send-failed');
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-${serial}`)?.state, 'failed');
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.state, 'ready');
  assert.equal(dbm.listPlanWpLifecycleEvents(s.packageId).length, 0);
});

test('pre-Implement package send is refused before attempt insertion or delivery', async () => {
  const s = seed(false);
  let delivered = false;
  const result = await svc.dispatchPlanPackage({
    attemptId: `attempt-${serial}`, lifecycleEventId: `event-${serial}`,
    packageId: s.packageId, planId: s.planId, planItemId: s.packageId,
    targetAgentId: s.agentId, ownerAgentId: null, promptText: 'go', createdAt: 2300,
  }, { deliver: async () => { delivered = true; return { disposition: 'failed' }; } });
  assert.equal(result.failure, 'structured-plan-not-implemented');
  assert.equal(delivered, false);
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-${serial}`), null);
});

test('wrong-cwd planning dispatch is refused before attempt insertion or delivery', async () => {
  const s = seed();
  let delivered = false;
  const activity = { ...activeActivity(s), path: 'C:/app/planning-worktrees/ws/run' };
  const result = await svc.dispatchPlanPackage({
    attemptId: `attempt-${serial}`, lifecycleEventId: `event-${serial}`,
    packageId: s.packageId, planId: s.planId, planItemId: s.packageId,
    targetAgentId: s.agentId, ownerAgentId: null, promptText: 'go', createdAt: 2350,
  }, {
    getActiveActivity: () => activity, readEnv: () => '1',
    deliver: async () => { delivered = true; return { disposition: 'delivered-unconfirmed' }; },
  });
  assert.equal(result.failure, 'target-agent-worktree-mismatch');
  assert.equal(delivered, false);
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-${serial}`), null);
});

test('activity-rooted worker lane is accepted for planning dispatch', async () => {
  const s = seed();
  const activity = activeActivity(s);
  dbm.getDb().prepare('UPDATE agents SET working_directory = ? WHERE id = ?')
    .run(`${activity.path}/.lares/workers/claude`, s.agentId);
  const result = await svc.dispatchPlanPackage({
    attemptId: `attempt-${serial}`, lifecycleEventId: `event-${serial}`,
    packageId: s.packageId, planId: s.planId, planItemId: s.packageId,
    targetAgentId: s.agentId, ownerAgentId: null, promptText: 'go', createdAt: 2360,
  }, {
    getActiveActivity: () => activity, readEnv: () => '1',
    deliver: async () => ({ disposition: 'delivered-unconfirmed' }),
  });
  assert.equal(result.ok, true);
});

test('default dispatch ignores a stale activity and captures the primary branch tip', async () => {
  const s = seed();
  dbm.setPlanWorkPackagePaths(s.packageId, s.workspaceId, [{ path: 'owned.txt' }], 1);
  const tip = 'c'.repeat(40);
  const gitCwds: string[] = [];
  let activityReads = 0;
  const result = await svc.dispatchPlanPackage({
    attemptId: `attempt-primary-${serial}`, lifecycleEventId: `event-primary-${serial}`,
    packageId: s.packageId, planId: s.planId, planItemId: s.packageId,
    targetAgentId: s.agentId, ownerAgentId: null, promptText: 'go', createdAt: 2380,
  }, {
    readEnv: () => undefined,
    getActiveActivity: () => { activityReads += 1; return { ...activeActivity(s), path: 'C:/stale' }; },
    runGit: async (cwd, args) => {
      gitCwds.push(cwd);
      return args[0] === 'symbolic-ref'
        ? { code: 0, stdout: 'refs/heads/master\n', stderr: '' }
        : { code: 0, stdout: `${tip}\n`, stderr: '' };
    },
    deliver: async () => ({ disposition: 'delivered-unconfirmed' }),
  });
  assert.equal(result.ok, true);
  assert.equal(activityReads, 0, 'off mode never consults a stale activity row');
  assert.deepEqual(gitCwds, [`C:/w${serial}`, `C:/w${serial}`]);
  assert.equal(result.attempt?.repositoryKey, `primary-${s.runId}`);
  assert.equal(result.attempt?.branchRef, 'refs/heads/master');
  assert.equal(result.attempt?.dispatchTipOid, tip);
  assert.equal(result.attempt?.captureStatus, 'captured');
});

test('legacy NULL-intent pending attempt reconciles through the real ledger', () => {
  const s = seed();
  const privateIntent = `svi_legacy_${serial}`;
  dbm.insertPlanDispatchAttempt({
    id: `attempt-${serial}`, packageId: s.packageId, planId: s.planId,
    executionRunId: s.runId, targetAgentId: s.agentId,
    requestedPlanItemId: s.packageId, createdAt: 2400,
    intent: { id: privateIntent, workspaceId: s.workspaceId, title: 'fixture',
      briefDigest: 'fixture-digest', createdById: null },
  });
  dbm.getDb().prepare(`UPDATE plan_work_packages SET intent_id = NULL WHERE id = ?`).run(s.packageId);
  insertStampedTurnWithoutReconcile(s, `turn-${serial}`, 2450, privateIntent);
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-${serial}`)?.state, 'pending');
  const result = svc.reconcilePackageDispatches(2500);
  assert.deepEqual(result.reconciledAttemptIds, [`attempt-${serial}`]);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-${serial}`)?.state, 'reconciled');
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.state, 'executing');
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.intentId, privateIntent);
  assert.notEqual(dbm.getPlanWorkPackage(s.packageId)?.state, 'done');
});

test('re-dispatch rotates one package to the second attempt intent', async () => {
  const s = seed();
  const dispatchAndReconcile = async (suffix: string, createdAt: number) => {
    let deliveredIntent: string | null = null;
    const result = await svc.dispatchPlanPackage({
      attemptId: `attempt-${suffix}-${serial}`, lifecycleEventId: `event-${suffix}-${serial}`,
      packageId: s.packageId, planId: s.planId, planItemId: s.packageId,
      targetAgentId: s.agentId, ownerAgentId: null, promptText: `brief ${suffix}`, createdAt,
    }, {
      getActiveActivity: () => activeActivity(s), readEnv: () => '1',
      deliver: async () => {
        deliveredIntent = dbm.getPlanDispatchAttempt(`attempt-${suffix}-${serial}`)?.intentId ?? null;
        assert.ok(deliveredIntent);
        insertStampedTurnWithoutReconcile(
          s, `turn-${suffix}-${serial}`, createdAt + 1, deliveredIntent,
        );
        return { disposition: 'delivered-unconfirmed' };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempt?.state, 'pending');
    const reconciled = dbm.reconcilePlanDispatchAttempts(createdAt + 2);
    assert.deepEqual(reconciled.reconciledAttemptIds, [`attempt-${suffix}-${serial}`]);
    assert.deepEqual(reconciled.diagnostics, []);
    return deliveredIntent as unknown as string;
  };

  const firstIntent = await dispatchAndReconcile('first', 2520);
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.intentId, firstIntent);
  dbm.getDb().prepare(`UPDATE plan_work_packages SET state = 'ready' WHERE id = ?`).run(s.packageId);
  const secondIntent = await dispatchAndReconcile('second', 2540);
  assert.notEqual(secondIntent, firstIntent);
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.intentId, secondIntent);
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.state, 'executing');
});

test('newest witnessed attempt wins when two pending dispatches target one ready package', () => {
  const s = seed();
  const insertAttemptAndTurn = (suffix: string, createdAt: number) => {
    const intentId = `svi_${suffix}_${serial}`;
    dbm.insertPlanDispatchAttempt({
      id: `attempt-${suffix}-${serial}`, packageId: s.packageId, planId: s.planId,
      executionRunId: s.runId, targetAgentId: s.agentId,
      requestedPlanItemId: s.packageId, createdAt,
      intent: { id: intentId, workspaceId: s.workspaceId, title: suffix,
        briefDigest: `${suffix}-digest`, createdById: null },
    });
    insertStampedTurnWithoutReconcile(s, `turn-${suffix}-${serial}`, createdAt + 1, intentId);
    return intentId;
  };
  insertAttemptAndTurn('older', 2560);
  const newerIntent = insertAttemptAndTurn('newer', 2580);
  dbm.getDb().prepare(`UPDATE plan_work_packages SET intent_id = NULL WHERE id = ?`).run(s.packageId);

  const reconciled = dbm.reconcilePlanDispatchAttempts(2600);
  assert.deepEqual(reconciled.reconciledAttemptIds, [`attempt-newer-${serial}`]);
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-newer-${serial}`)?.state, 'reconciled');
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-older-${serial}`)?.state, 'pending');
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.intentId, newerIntent);
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.state, 'executing');
});

test('turn insertion confirms a pending attempt without a boot-time reconcile', () => {
  const s = seed();
  dbm.insertPlanDispatchAttempt({
    id: `attempt-${serial}`, packageId: s.packageId, planId: s.planId,
    executionRunId: s.runId, targetAgentId: s.agentId,
    requestedPlanItemId: s.packageId, createdAt: 2600,
    intent: { id: s.intentId, workspaceId: s.workspaceId, title: 'fixture',
      briefDigest: 'fixture-digest', createdById: null },
  });
  openStampedTurn(s, `turn-${serial}`, 2610);
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-${serial}`)?.state, 'reconciled');
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-${serial}`)?.confirmedTurnId, `turn-${serial}`);
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.state, 'executing');
});

test('periodic safety net probes cheaply and reconciles only while an attempt is open', () => {
  let tick: (() => void) | null = null;
  let interval = 0;
  let open = false;
  let reconcileCalls = 0;
  let cleared = false;
  const timer = { unref() { /* test timer */ } };
  const stop = svc.startPackageDispatchReconcileSafetyNet(undefined, {
    hasOpenAttempts: () => open,
    reconcile: () => { reconcileCalls += 1; return { reconciledAttemptIds: [], diagnostics: [] }; },
    setInterval: ((callback: () => void, ms: number) => {
      tick = callback; interval = ms; return timer;
    }) as unknown as typeof globalThis.setInterval,
    clearInterval: ((value: unknown) => { cleared = value === timer; }) as typeof globalThis.clearInterval,
  });
  assert.equal(interval, 45_000);
  assert.ok(tick);
  (tick as () => void)();
  assert.equal(reconcileCalls, 0);
  open = true;
  (tick as () => void)();
  assert.equal(reconcileCalls, 1);
  stop();
  assert.equal(cleared, true);
});

test('ambiguous fallback stays pending and surfaces a diagnostic', () => {
  const s = seed();
  dbm.insertPlanDispatchAttempt({
    id: `attempt-${serial}`, packageId: s.packageId, planId: s.planId,
    executionRunId: s.runId, targetAgentId: s.agentId,
    requestedPlanItemId: s.packageId, createdAt: 2800,
    intent: { id: s.intentId, workspaceId: s.workspaceId, title: 'fixture',
      briefDigest: 'fixture-digest', createdById: null },
  });
  dbm.getDb().prepare(`UPDATE plan_work_packages SET state = 'blocked' WHERE id = ?`).run(s.packageId);
  openStampedTurn(s, `turn-${serial}-a`, 2810);
  openStampedTurn(s, `turn-${serial}-b`, 2820);
  dbm.getDb().prepare(`UPDATE plan_work_packages SET state = 'ready' WHERE id = ?`).run(s.packageId);
  const result = svc.reconcilePackageDispatches(2900);
  assert.deepEqual(result.reconciledAttemptIds, []);
  assert.match(result.diagnostics.join('\n'), /2 matching stamped turns.*left pending/);
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-${serial}`)?.state, 'pending');
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.state, 'ready');
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'package-dispatch-'));
  process.env.APPDATA = tmpAppData;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as DbModule;
  dbm.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  svc = require('./plan-lifecycle') as ServiceModule;

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed += 1; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
