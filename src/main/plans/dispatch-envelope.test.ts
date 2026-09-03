import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

type SqlDb = { exec(sql: string): unknown; run(sql: string, params?: unknown[]): unknown; prepare(sql: string): { bind(p: unknown[]): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): boolean } };
let SqlCtor: new () => SqlDb;
class FakeBetterSqlite {
  private db: SqlDb; private serial = 0;
  constructor() { this.db = new SqlCtor(); }
  pragma(): undefined { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) { const inner = this.db; return {
    run: (...p: unknown[]) => { inner.run(sql, p); return {}; },
    get: (...p: unknown[]) => { const s = inner.prepare(sql); try { s.bind(p); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } },
    all: (...p: unknown[]) => { const s = inner.prepare(sql); const rows: Record<string, unknown>[] = []; try { s.bind(p); while (s.step()) rows.push(s.getAsObject()); return rows; } finally { s.free(); } },
  }; }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) { return (...args: A) => { const n = `dispatch_envelope_${++this.serial}`; this.db.exec(`SAVEPOINT ${n}`); try { const value = fn(...args); this.db.exec(`RELEASE ${n}`); return value; } catch (error) { this.db.exec(`ROLLBACK TO ${n}`); this.db.exec(`RELEASE ${n}`); throw error; } }; }
}

function request(port: number, method: string, route: string, token: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, agent: false,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => res.statusCode && res.statusCode < 300 ? resolve(JSON.parse(text)) : reject(new Error(`${res.statusCode}: ${text}`)));
    });
    req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-envelope-'));
  process.env.APPDATA = path.join(root, 'appdata');
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'test@lares.local'], { cwd: root, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Lares Test'], { cwd: root, windowsHide: true });
  fs.writeFileSync(path.join(root, 'owned.txt'), 'base\n');
  execFileSync('git', ['add', 'owned.txt'], { cwd: root, windowsHide: true });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: root, windowsHide: true });
  const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();

  const initSqlJs = require('sql.js'); const SQL = await initSqlJs(); SqlCtor = SQL.Database;
  const sqlite = require.resolve('better-sqlite3');
  require.cache[sqlite] = { id: sqlite, filename: sqlite, loaded: true, exports: FakeBetterSqlite } as unknown as NodeJS.Module;
  const db = require('../database') as typeof import('../database'); db.initDatabase();
  const ws = db.createWorkspace({ title: 'Envelope', path: root, pathType: 'windows' });
  const plan = db.createOrRevivePlan({ workspaceId: ws.id, path: 'plan.md', format: 'structured', runState: 'ready' });
  db.getDb().prepare('UPDATE plans SET artifact_id = ? WHERE id = ?').run('plan_16910c64', plan.id);
  const packageId = 'wp-envelope'; const intentId = 'int_envelope'; const runId = 'run-envelope';
  db.upsertPlanWorkPackage({ id: packageId, workspaceId: ws.id, planId: plan.id, intentId,
    schemaVersion: 2, contentHash: 'hash-envelope', projectionStatus: 'synced', title: 'Envelope',
    acceptanceCondition: null, state: 'ready', assigneeAgentId: null, revision: 1, createdAt: 1, updatedAt: 1 });
  db.setPlanWorkPackagePaths(packageId, ws.id, [{ path: 'owned.txt', intentKind: 'edit' }], 1);
  db.insertPlanningActivityWorktreeProvisioning({ executionRunId: runId, planId: plan.id,
    logicalWorkspaceId: ws.id, objectDatabaseKey: 'odb-envelope', activityRepositoryKey: 'repo-envelope',
    primaryRepositoryKey: 'repo-envelope', path: root, baselineOid: tip, activityHeadRef: 'refs/heads/main',
    promotedHeadOid: null, state: 'provisioning', failureCode: null, createdAt: 1, updatedAt: 1 });
  db.insertPlanExecutionRunActivating({ id: runId, planId: plan.id, repositoryKey: 'repo-envelope',
    baselineKind: 'head', baselineHeadOid: tip, baselineRef: 'refs/heads/main',
    triggerSource: 'renderer-user-action', triggeredAt: 2, planningActivityExecutionRunId: runId });
  db.getDb().prepare('UPDATE planning_activity_worktrees SET path = ? WHERE execution_run_id = ?')
    .run(path.join(root, 'stale-activity'), runId);

  const { AgentSupervisor } = require('../supervisor') as typeof import('../supervisor');
  const { ApiServer } = require('../api-server') as typeof import('../api-server');
  const { getApiToken } = require('../security/api-auth') as typeof import('../security/api-auth');
  const orchestration = require(path.join(process.cwd(), 'scripts', 'mcp-tools-orchestration.js')) as {
    getOrchestrationToolDefinitions(): Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    handleOrchestrationToolCall(name: string, args: Record<string, unknown>, api: (m: string, p: string, b?: unknown) => Promise<unknown>): Promise<unknown>;
  };
  assert.ok(orchestration.getOrchestrationToolDefinitions().find((tool) => tool.name === 'launch_agent')?.inputSchema.properties.plan_item_id,
    'launch_agent must advertise plan_item_id');

  const supervisor = new AgentSupervisor({ readEnv: () => undefined }); const priv = supervisor as unknown as Record<string, unknown>;
  for (const name of ['writeAgentRegistry', 'ensureProviderDirTrust', 'ensureWorkerScaffold', 'ensureWorkspaceScripts',
    'ensureResearchStoreScaffold', 'retireStaleRootMcpConfig', 'ensureCodexHookProfile']) priv[name] = () => {};
  priv.loadAgentMd = () => null; priv.launchWindowsAgent = async () => {};

  const pending = priv.pendingInitialPrompts as Map<string, unknown>;
  const realSet = pending.set.bind(pending);
  let deliveryObservedBeforeAttempt = false;
  pending.set = ((agentId: string, value: unknown) => {
    const rows = db.getDb().prepare('SELECT id FROM plan_dispatch_attempts WHERE package_id = ?').all(packageId);
    if (rows.length !== 1) deliveryObservedBeforeAttempt = true;
    return realSet(agentId, value);
  }) as typeof pending.set;

  const seedLaunchPackage = (id: string, assigneeAgentId: string | null = null) => {
    db.upsertPlanWorkPackage({ ...db.getPlanWorkPackage(packageId)!, id, assigneeAgentId,
      title: id, createdAt: 2, updatedAt: 2 });
    db.setPlanWorkPackagePaths(id, ws.id, [{ path: 'owned.txt', intentKind: 'edit' }], 2);
  };
  const launchInput = (id: string) => ({
    workspaceId: ws.id, planId: plan.id, planItemId: id, title: id,
    provider: 'claude' as const, isWorker: true, initialUserPrompt: `prompt ${id}`,
  });

  const preassignedAgent = db.createAgent({ workspaceId: ws.id, title: 'assigned elsewhere',
    roleDescription: '', workingDirectory: root, command: 'x', tmuxSessionName: null,
    autoRestartEnabled: false, logPath: 'assigned.log', isWorker: true });
  seedLaunchPackage('wp-preassigned', preassignedAgent.id);
  const agentsBeforeRefusal = Number((db.getDb().prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n);
  const promptsBeforeRefusal = pending.size;
  assert.deepEqual(await supervisor.launchAgent(launchInput('wp-preassigned')),
    { ok: false, failure: 'package-already-assigned' },
    'REACHABILITY:wpf1-package-steal assigned package must refuse');
  assert.equal(Number((db.getDb().prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n), agentsBeforeRefusal,
    'assigned package refuses before agent creation');
  assert.equal(db.getDb().prepare('SELECT id FROM plan_dispatch_attempts WHERE package_id = ?').all('wp-preassigned').length, 0);
  assert.equal(pending.size, promptsBeforeRefusal, 'assigned package delivers no prompt');
  assert.equal(db.getPlanWorkPackage('wp-preassigned')?.assigneeAgentId, preassignedAgent.id,
    'assigned package keeps its original assignee');

  const realAssignment = priv.launchPackageAssignment;
  seedLaunchPackage('wp-assignment-failure');
  priv.launchPackageAssignment = () => { throw new Error('injected assignment failure'); };
  const assignmentFailure = await supervisor.launchAgent(launchInput('wp-assignment-failure'));
  assert.equal('ok' in assignmentFailure && assignmentFailure.ok === false
    ? assignmentFailure.failure : null, 'assignment-failed');
  assert.equal('ok' in assignmentFailure && assignmentFailure.ok === false
    && 'delivered' in assignmentFailure ? assignmentFailure.delivered : null, false);
  assert.equal(pending.size, promptsBeforeRefusal, 'assignment failure delivers no prompt');
  assert.equal(db.getDb().prepare('SELECT id FROM plan_dispatch_attempts WHERE package_id = ?').all('wp-assignment-failure').length, 0);
  priv.launchPackageAssignment = realAssignment;

  const realDispatch = priv.launchPackageDispatch;
  seedLaunchPackage('wp-insert-failure');
  priv.launchPackageDispatch = async () => { throw new Error('injected insert failure'); };
  const insertFailure = await supervisor.launchAgent(launchInput('wp-insert-failure'));
  assert.equal('ok' in insertFailure && insertFailure.ok === false ? insertFailure.failure : null,
    'dispatch-attempt-insert-failed');
  assert.equal('ok' in insertFailure && insertFailure.ok === false
    && 'delivered' in insertFailure ? insertFailure.delivered : null, false);
  assert.equal(pending.size, promptsBeforeRefusal, 'attempt insertion failure delivers no prompt');
  assert.equal(db.getDb().prepare('SELECT id FROM plan_dispatch_attempts WHERE package_id = ?').all('wp-insert-failure').length, 0);
  assert.equal(db.getPlanWorkPackage('wp-insert-failure')?.assigneeAgentId,
    'ok' in insertFailure && insertFailure.ok === false && 'createdAgentId' in insertFailure
      ? insertFailure.createdAgentId : null);
  priv.launchPackageDispatch = realDispatch;

  const server = new ApiServer(supervisor, 0, undefined, '127.0.0.1'); const port = await server.start();
  try {
    await orchestration.handleOrchestrationToolCall('launch_agent', {
      workspace_id: ws.id, title: 'WP-1 worker', provider: 'claude', plan_id: 'plan_16910c64',
      plan_item_id: packageId, prompt: 'Implement WP-1', supervised: true,
    }, (method, route, body) => request(port, method, route, getApiToken(), body));
  } finally { server.stop(); }

  const attempt = db.getDb().prepare('SELECT * FROM plan_dispatch_attempts WHERE package_id = ?').get(packageId) as Record<string, unknown>;
  if (attempt.capture_status !== 'captured') console.error('capture diagnostic', attempt.capture_failure);
  assert.equal(attempt.capture_status, 'captured', JSON.stringify(attempt)); assert.equal(attempt.repository_key, 'repo-envelope');
  assert.equal(attempt.branch_ref, 'refs/heads/main'); assert.equal(attempt.dispatch_tip_oid, tip);
  assert.deepEqual(JSON.parse(String(attempt.frozen_paths_json)), ['owned.txt']);
  assert.equal(db.getPlanWorkPackage(packageId)?.assigneeAgentId, attempt.target_agent_id);
  assert.equal(db.getAgent(String(attempt.target_agent_id))?.workingDirectory, root,
    'default launch stays in the primary workspace even when a stale activity row exists');
  assert.equal(deliveryObservedBeforeAttempt, false,
    'REACHABILITY:wp1-dispatch-envelope attempt must exist before prompt delivery');

  db.getDb().prepare('UPDATE planning_activity_worktrees SET path = ? WHERE execution_run_id = ?')
    .run(root, runId);
  seedLaunchPackage('wp-opt-in');
  const optInSupervisor = new AgentSupervisor({ readEnv: () => '1' });
  const optInPriv = optInSupervisor as unknown as Record<string, unknown>;
  for (const name of ['writeAgentRegistry', 'ensureProviderDirTrust', 'ensureWorkerScaffold', 'ensureWorkspaceScripts',
    'ensureResearchStoreScaffold', 'retireStaleRootMcpConfig', 'ensureCodexHookProfile']) optInPriv[name] = () => {};
  optInPriv.loadAgentMd = () => null; optInPriv.launchWindowsAgent = async () => {};
  const optInLaunch = await optInSupervisor.launchAgent(launchInput('wp-opt-in'));
  assert.ok(!('ok' in optInLaunch) || optInLaunch.ok !== false, 'opt-in activity launch succeeds');
  const optInAttempt = db.getDb().prepare(
    'SELECT * FROM plan_dispatch_attempts WHERE package_id = ?',
  ).get('wp-opt-in') as Record<string, unknown>;
  assert.equal(optInAttempt.capture_status, 'captured');
  assert.equal(db.getAgent(String(optInAttempt.target_agent_id))?.workingDirectory, root,
    'opt-in launch uses the activity path');

  const legacyPackage = 'wp-unavailable';
  db.upsertPlanWorkPackage({ ...db.getPlanWorkPackage(packageId)!, id: legacyPackage, assigneeAgentId: null,
    title: 'Unavailable', createdAt: 3, updatedAt: 3 });
  db.setPlanWorkPackagePaths(legacyPackage, ws.id, [{ path: 'owned.txt' }], 3);
  const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-nongit-'));
  const legacyAgent = db.createAgent({ workspaceId: ws.id, title: 'legacy', roleDescription: '', workingDirectory: nonRepo,
    command: 'x', tmuxSessionName: null, autoRestartEnabled: false, logPath: 'legacy.log', isWorker: true });
  const lifecycle = require('./plan-lifecycle') as typeof import('./plan-lifecycle'); let delivered = false;
  const unavailable = await lifecycle.dispatchPlanPackage({ attemptId: 'attempt-unavailable', lifecycleEventId: 'event-unavailable',
    packageId: legacyPackage, planId: plan.id, planItemId: legacyPackage, targetAgentId: legacyAgent.id,
    ownerAgentId: null, promptText: 'deliver anyway', createdAt: 4 }, {
    getActiveActivity: () => ({ ...db.getActivePlanningActivityWorktree(plan.id)!, path: nonRepo }),
    deliver: async () => { delivered = true; return { disposition: 'delivered-unconfirmed' }; },
  });
  assert.equal(unavailable.ok, true); assert.equal(delivered, true, 'non-git dispatch still delivers');
  assert.equal(unavailable.attempt?.captureStatus, 'unavailable');

  const preMigration = db.insertPlanDispatchAttempt({ id: 'attempt-premigration', packageId: legacyPackage,
    planId: plan.id, executionRunId: runId, targetAgentId: legacyAgent.id,
    requestedPlanItemId: legacyPackage, createdAt: 5 });
  assert.equal(preMigration.captureStatus, 'unavailable', 'null envelope reads unavailable');

  const schema = String((db.getDb().prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='plan_dispatch_attempts'",
  ).get() as { sql: string }).sql);
  assert.match(schema, /CHECK\s*\([^)]*capture_status/is,
    'fresh schema carries the captured-authority invariant');
  assert.throws(() => db.getDb().prepare(
    'UPDATE plan_dispatch_attempts SET frozen_paths_json = ? WHERE id = ?',
  ).run(JSON.stringify(['bad\npath']), String(attempt.id)), /captured dispatch authority|CHECK constraint/i,
  'raw writes cannot store invalid captured authority');

  // Simulate a malformed pre-trigger historical row to prove every reader uses
  // the same authority decoder and quarantines it as unavailable.
  db.getDb().exec(`
    DROP TRIGGER plan_dispatch_attempts_captured_update_guard;
    PRAGMA ignore_check_constraints = ON;
  `);
  db.getDb().prepare('UPDATE plan_dispatch_attempts SET frozen_paths_json = ? WHERE id = ?')
    .run(JSON.stringify(['bad\npath']), String(attempt.id));
  const malformedHistorical = db.getPlanDispatchAttempt(String(attempt.id));
  assert.equal(malformedHistorical?.captureStatus, 'unavailable');
  assert.equal(malformedHistorical?.frozenPaths, null);

  console.log('1 passed, 0 failed');
  fs.rmSync(nonRepo, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
})().catch((error) => { console.error(error?.stack || error); process.exit(1); });
