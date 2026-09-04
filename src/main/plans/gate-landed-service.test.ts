import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSupervisor } from '../supervisor';
import type { GateLandedRefusal } from '../../shared/types';
import type { PlanDispatchAttempt, PlanWorkPackage, TurnRecord } from '../database';

type SqlDb = { exec(sql: string): unknown; run(sql: string, params?: unknown[]): unknown; prepare(sql: string): { bind(p: unknown[]): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): boolean } };
let SqlCtor: new () => SqlDb;
class FakeBetterSqlite {
  private db: SqlDb; private serial = 0;
  constructor() { this.db = new SqlCtor(); }
  pragma(): undefined { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  close(): void {}
  prepare(sql: string) { const inner = this.db; return {
    run: (...p: unknown[]) => { inner.run(sql, p); return { changes: 1 }; },
    get: (...p: unknown[]) => { const s = inner.prepare(sql); try { s.bind(p); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } },
    all: (...p: unknown[]) => { const s = inner.prepare(sql); const rows: Record<string, unknown>[] = []; try { s.bind(p); while (s.step()) rows.push(s.getAsObject()); return rows; } finally { s.free(); } },
  }; }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) { return (...args: A) => { const n = `gate_landed_${++this.serial}`; this.db.exec(`SAVEPOINT ${n}`); try { const value = fn(...args); this.db.exec(`RELEASE ${n}`); return value; } catch (error) { this.db.exec(`ROLLBACK TO ${n}`); this.db.exec(`RELEASE ${n}`); throw error; } }; }
}

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

const OID = 'a'.repeat(40);
const BASE_ATTEMPT: PlanDispatchAttempt = {
  id: 'dispatch-refusal', packageId: 'WP-4', planId: 'plan-row', executionRunId: 'run',
  intentId: 'intent', targetAgentId: 'worker', packageRevision: 1, orchestrationId: null,
  targetSessionId: 'session', repositoryKey: 'repo', branchRef: 'refs/heads/main',
  dispatchTipOid: 'b'.repeat(40), frozenPaths: ['owned.txt'], captureStatus: 'captured',
  captureFailure: null, requestedPlanItemId: 'WP-4', confirmedTurnId: 'prompt-turn',
  state: 'delivered', createdAt: 1, confirmedAt: 2, reconciledAt: null,
};
const BASE_PACKAGE: PlanWorkPackage = {
  id: 'WP-4', workspaceId: 'ws', planId: 'plan-row', intentId: 'intent', schemaVersion: 2,
  contentHash: 'hash', projectionStatus: 'synced', title: 'WP-4', acceptanceCondition: null,
  state: 'executing', assigneeAgentId: 'worker', revision: 1, createdAt: 1, updatedAt: 2,
};
const WITNESS = { id: 'witness', workspaceId: 'ws', turnSeq: 2, agentId: 'worker',
  agentTitle: null, ownerAgentId: null, ownerBrickGeneration: null, planId: 'plan-row',
  planItemId: 'WP-4', planStampSource: 'explicit', intentId: 'intent', intentStampSource: null,
  sessionId: 'session', taskLabel: null, startedAt: 2, endedAt: 3, status: 'accepted',
  beforeOid: null, afterOid: null, beforeRef: null, afterRef: null, beforeReady: false,
  afterReady: false, beforeQuality: null, afterQuality: null, beforeRawFilterBypassed: false,
  beforeFilteredPaths: null, beforePrunedAt: null, afterPrunedAt: null,
  touched: [{ path: 'owned.txt', op: 'write' }], diffStats: null, compactDiff: null,
  compactDiffProvenance: null, failureReason: null } as TurnRecord;

let db: typeof import('../database');
let gate: typeof import('./gate-landed-service');

function ledgerCounts(): number[] {
  return ['commit_records', 'commit_turn_links', 'plan_package_gate_attempts', 'plan_package_gate_commit_links']
    .map((table) => Number((db.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n));
}

function refusalDeps(overrides: Partial<import('./gate-landed-service').GateLandedServiceDeps> = {}) {
  return {
    getAttempt: () => BASE_ATTEMPT,
    getPackage: () => BASE_PACKAGE,
    getPlanAuthority: () => ({ id: 'plan-row', workspaceId: 'ws', artifactId: 'plan_16910c64', responsibleSupervisorId: 'sup' }),
    getRepositoryRoot: () => 'C:/repo',
    gitOracle: () => ({} as never),
    verify: async () => ({ outcome: 'verified' as const, commitOid: OID, subject: 'x',
      verifiedTrailer: 'tests', scopeOmittedTrailer: null, parentOid: 'b'.repeat(40) }),
    findWitness: () => WITNESS,
    reconcile: () => ({ reconciledAttemptIds: [], diagnostics: [] }),
    ...overrides,
  };
}

test('every identity, attempt, git, and witness refusal leaves the public ledger unchanged', async () => {
  const gitReasons: GateLandedRefusal[] = ['branch-unresolvable', 'dispatch-tip-not-ancestor',
    'no-matching-commit', 'multiple-matching-commits', 'commit-oid-not-the-match', 'changed-paths-diverge'];
  const cases: Array<{ reason: GateLandedRefusal; supervisor?: string; deps: ReturnType<typeof refusalDeps> }> = [
    { reason: 'not-responsible-supervisor', supervisor: 'other', deps: refusalDeps() },
    { reason: 'dispatch-attempt-not-found', deps: refusalDeps({ getAttempt: () => null }) },
    { reason: 'attempt-plan-mismatch', deps: refusalDeps({ getAttempt: () => ({ ...BASE_ATTEMPT, planId: 'other' }) }) },
    { reason: 'attempt-unconfirmed', deps: refusalDeps({ getAttempt: () => ({ ...BASE_ATTEMPT, state: 'pending', confirmedTurnId: null }) }) },
    { reason: 'stale-attempt-revision', deps: refusalDeps({ getPackage: () => ({ ...BASE_PACKAGE, revision: 2 }) }) },
    { reason: 'dispatch-evidence-unavailable', deps: refusalDeps({ getAttempt: () => ({ ...BASE_ATTEMPT, captureStatus: 'unavailable', repositoryKey: null }) }) },
    ...gitReasons.map((reason) => ({ reason, deps: refusalDeps({ verify: async () => ({ outcome: 'refused' as const, reason: reason as never }) }) })),
    { reason: 'commit-witness-unavailable', deps: refusalDeps({
      findWitness: () => null,
      transition: () => { throw new Error('REACHABILITY:wp4-gate-landed-witness prompt-only turn reached the ledger'); },
    }) },
  ];
  for (const item of cases) {
    const before = ledgerCounts();
    const result = await gate.gateLandedWorkPackage({ plan_id: 'plan-row', dispatch_attempt_id: 'dispatch-refusal', commit_oid: OID }, item.supervisor ?? 'sup', item.deps);
    assert.deepEqual(result, { outcome: 'refused', reason: item.reason },
      item.reason === 'commit-witness-unavailable' ? 'REACHABILITY:wp4-gate-landed-witness prompt-only turn must not qualify' : item.reason);
    assert.deepEqual(ledgerCounts(), before, `${item.reason} must write no ledger rows`);
  }
});

test('gate retries reconciliation before refusing a stale pending attempt', async () => {
  let attempt: PlanDispatchAttempt = { ...BASE_ATTEMPT, state: 'pending', confirmedTurnId: null };
  let reconcileCalls = 0;
  const result = await gate.gateLandedWorkPackage({
    plan_id: 'plan-row', dispatch_attempt_id: attempt.id, commit_oid: OID,
  }, 'sup', refusalDeps({
    getAttempt: () => attempt,
    reconcile: () => {
      reconcileCalls += 1;
      attempt = { ...BASE_ATTEMPT };
      return { reconciledAttemptIds: [attempt.id], diagnostics: [] };
    },
    verify: async () => ({ outcome: 'refused', reason: 'branch-unresolvable' }),
  }));
  assert.equal(reconcileCalls, 1);
  assert.deepEqual(result, { outcome: 'refused', reason: 'branch-unresolvable' });
});

test('portable plan id resolves to row authority and gates the matching attempt', async () => {
  const ws = db.createWorkspace({ title: 'Portable gate', path: 'C:/portable-gate', pathType: 'windows' });
  const supervisor = db.createAgent({ workspaceId: ws.id, title: 'portable sup', roleDescription: '',
    workingDirectory: ws.path, command: 'x', tmuxSessionName: null, autoRestartEnabled: false,
    logPath: 'portable-sup.log', isSupervisor: true });
  const plan = db.createOrRevivePlan({ workspaceId: ws.id, path: '.lares/plans/portable-gate',
    format: 'structured', runState: 'executing' });
  db.getDb().prepare('UPDATE plans SET artifact_id = ?, responsible_supervisor_id = ? WHERE id = ?')
    .run('plan_6c5351d6', supervisor.id, plan.id);
  const attempt = { ...BASE_ATTEMPT, planId: plan.id };
  const pkg = { ...BASE_PACKAGE, workspaceId: ws.id, planId: plan.id };
  const result = await gate.gateLandedWorkPackage({
    plan_id: 'plan_6c5351d6', dispatch_attempt_id: attempt.id, commit_oid: OID,
  }, supervisor.id, refusalDeps({
    getAttempt: () => attempt,
    getPackage: () => pkg,
    getPlanAuthority: undefined,
    verify: async () => ({ outcome: 'refused', reason: 'branch-unresolvable' }),
  }));
  assert.deepEqual(result, { outcome: 'refused', reason: 'branch-unresolvable' });
});

test('missing target session is backfilled before gate evidence is evaluated', async () => {
  const attempt = { ...BASE_ATTEMPT, targetSessionId: null };
  const persisted: string[] = [];
  let witnessedSessionId: string | null = null;
  const result = await gate.gateLandedWorkPackage({
    plan_id: 'plan-row', dispatch_attempt_id: attempt.id, commit_oid: OID,
  }, 'sup', refusalDeps({
    getAttempt: () => attempt,
    resolveTargetSessionId: (attemptId) => { persisted.push(attemptId); return 'codex-resume-session'; },
    findWitness: (input) => { witnessedSessionId = input.targetSessionId; return null; },
  }));
  assert.deepEqual(persisted, [attempt.id]);
  assert.equal(witnessedSessionId, 'codex-resume-session');
  assert.deepEqual(result, { outcome: 'refused', reason: 'commit-witness-unavailable' });
});

test('missing target session everywhere remains dispatch-evidence-unavailable', async () => {
  let verifyCalls = 0;
  const result = await gate.gateLandedWorkPackage({
    plan_id: 'plan-row', dispatch_attempt_id: BASE_ATTEMPT.id, commit_oid: OID,
  }, 'sup', refusalDeps({
    getAttempt: () => ({ ...BASE_ATTEMPT, targetSessionId: null }),
    resolveTargetSessionId: () => null,
    verify: async () => { verifyCalls += 1; return { outcome: 'refused', reason: 'branch-unresolvable' }; },
  }));
  assert.equal(verifyCalls, 0);
  assert.deepEqual(result, { outcome: 'refused', reason: 'dispatch-evidence-unavailable' });
});

function apiRequest(port: number, workspaceId: string, supervisorId: string) {
  return (method: string, route: string, body?: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, agent: false,
      headers: { Authorization: `Bearer ${require('../security/api-auth').getApiToken()}`,
        'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId, 'X-Supervisor-Id': supervisorId } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => (res.statusCode ?? 500) < 300 ? resolve(JSON.parse(text)) : reject(new Error(`${res.statusCode}: ${text}`)));
    });
    req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
}

test('MCP definition -> sidecar -> authenticated HTTP route -> service -> public ledger', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-landed-entry-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'test@lares.local'], { cwd: root, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Lares Test'], { cwd: root, windowsHide: true });
  fs.writeFileSync(path.join(root, 'owned.txt'), 'base\n');
  execFileSync('git', ['add', 'owned.txt'], { cwd: root, windowsHide: true });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: root, windowsHide: true });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  fs.writeFileSync(path.join(root, 'owned.txt'), 'landed\n');
  execFileSync('git', ['add', 'owned.txt'], { cwd: root, windowsHide: true });
  execFileSync('git', ['commit', '-m', 'land WP-4', '-m', 'Plan: plan_16910c64\nWP: WP-4\nVerified: tests => PASS (entry)'], { cwd: root, windowsHide: true });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();

  const ws = db.createWorkspace({ title: 'Gate', path: root, pathType: 'windows' });
  const supervisor = db.createAgent({ workspaceId: ws.id, title: 'sup', roleDescription: '', workingDirectory: root,
    command: 'x', tmuxSessionName: null, autoRestartEnabled: false, logPath: 'sup.log', isSupervisor: true });
  const worker = db.createAgent({ workspaceId: ws.id, title: 'worker', roleDescription: '', workingDirectory: root,
    command: 'x', tmuxSessionName: null, autoRestartEnabled: false, logPath: 'worker.log', isWorker: true });
  const plan = db.createOrRevivePlan({ workspaceId: ws.id, path: '.lares/plans/gate', format: 'structured', runState: 'executing' });
  db.getDb().prepare('UPDATE plans SET artifact_id = ?, responsible_supervisor_id = ? WHERE id = ?').run('plan_16910c64', supervisor.id, plan.id);
  db.getDb().prepare(`INSERT INTO plan_intents
    (id, workspace_id, plan_id, plan_artifact_id, intent_id, kind, source_doc_rel_path, first_seen_at, updated_at, last_scanned_at)
    VALUES ('intent-row-entry', ?, ?, 'plan_16910c64', 'intent-entry', 'research', 'plan.md', 1, 1, 1)`).run(ws.id, plan.id);
  db.upsertPlanWorkPackage({ id: 'WP-4', workspaceId: ws.id, planId: plan.id, intentId: 'intent-entry',
    schemaVersion: 2, contentHash: 'hash-entry', projectionStatus: 'synced', title: 'WP-4', acceptanceCondition: null,
    state: 'ready', assigneeAgentId: worker.id, revision: 1, createdAt: 1, updatedAt: 1 });
  db.getDb().prepare(`INSERT INTO plan_execution_runs
    (id, plan_id, repository_key, baseline_kind, baseline_head_oid, baseline_ref, trigger_source, triggered_at, lifecycle_state)
    VALUES ('run-entry', ?, ?, 'head', ?, 'refs/heads/main', 'renderer-user-action', 1, 'active')`).run(plan.id, root, base);
  db.insertPlanDispatchAttempt({ id: 'dispatch-entry', packageId: 'WP-4', planId: plan.id,
    executionRunId: 'run-entry', targetAgentId: worker.id, requestedPlanItemId: 'WP-4', createdAt: 2,
    targetSessionId: 'session-entry', repositoryKey: root, branchRef: 'refs/heads/main', dispatchTipOid: base,
    frozenPaths: ['owned.txt'], captureStatus: 'captured', intent: { id: 'intent-entry', workspaceId: ws.id,
      title: 'WP-4 dispatch', briefDigest: 'brief-entry', createdById: supervisor.id } });
  const turn = db.allocateAndInsertTurn(ws.id, { id: 'turn-entry', agentId: worker.id, planId: plan.id,
    planItemId: 'WP-4', intentId: 'intent-entry', sessionId: 'session-entry', startedAt: 3, status: 'open' });
  db.updateTurnRecord(turn.id, { touched: [{ path: 'owned.txt', op: 'write' }] });
  assert.equal(db.getPlanDispatchAttempt('dispatch-entry')?.confirmedTurnId, turn.id,
    'the production turn insert edge must confirm the pending dispatch');
  require('./package-ledger').transitionPlanPackage({ type: 'deployment-observed', idempotencyKey: 'deploy-entry',
    workspaceId: ws.id, planId: plan.id, planArtifactId: 'plan_16910c64', intentId: 'intent-entry',
    packageId: 'WP-4', packageRevision: 1 },
  { kind: 'deployment', actor: supervisor.id, observedAt: 5, environment: 'local', state: 'not_required' });

  const { ApiServer } = require('../api-server') as typeof import('../api-server');
  const tools = require(path.resolve('scripts/mcp-tools-plans.js')) as {
    getPlansToolDefinitions(): Array<{ name: string }>;
    getPlansReadToolDefinitions(): Array<{ name: string }>;
    handlePlansToolCall(name: string, args: Record<string, unknown>, api: (method: string, route: string, body?: unknown) => Promise<unknown>): Promise<{ content: Array<{ text: string }> }>;
  };
  assert.ok(tools.getPlansToolDefinitions().some((def: { name: string }) => def.name === 'gate_landed_work_package'));
  assert.ok(!tools.getPlansReadToolDefinitions().some((def: { name: string }) => def.name === 'gate_landed_work_package'));
  const stub = { getContextStats: () => null, getUsageLimits: () => ({ available: false }),
    isInputInFlight: () => false, emit: () => false } as unknown as AgentSupervisor;
  const server = new ApiServer(stub, 0, undefined, '127.0.0.1'); const port = await server.start();
  try {
    const result = await tools.handlePlansToolCall('gate_landed_work_package', {
      plan_id: 'plan_16910c64', dispatch_attempt_id: 'dispatch-entry', commit_oid: commit,
    }, apiRequest(port, ws.id, supervisor.id));
    assert.match(result.content[0].text, /"outcome": "landed"/);
    const retried = await tools.handlePlansToolCall('gate_landed_work_package', {
      plan_id: 'plan_16910c64', dispatch_attempt_id: 'dispatch-entry', commit_oid: commit,
    }, apiRequest(port, ws.id, supervisor.id));
    assert.match(retried.content[0].text, /"outcome": "landed"/);
  } finally { server.stop(); }
  assert.equal((db.getDb().prepare('SELECT COUNT(*) AS n FROM commit_records WHERE commit_oid = ?').get(commit) as { n: number }).n, 1);
  assert.equal((db.getDb().prepare(`SELECT COUNT(*) AS n FROM plan_package_gate_attempts WHERE gate_key = 'supervisor-acceptance' AND outcome = 'passed'`).get() as { n: number }).n, 1);
  assert.equal((db.getDb().prepare('SELECT COUNT(*) AS n FROM plan_package_gate_commit_links WHERE commit_oid = ?').get(commit) as { n: number }).n, 1);
  assert.equal((db.getDb().prepare(`SELECT COUNT(*) AS n FROM plan_package_gate_attempts WHERE gate_key = 'supervisor-acceptance'`).get() as { n: number }).n, 1,
    'retry after evidence/finalization must reuse the acceptance attempt');
  assert.equal(db.getPlanWorkPackage('WP-4')?.state, 'done');
  fs.rmSync(root, { recursive: true, force: true });
});

(async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-landed-db-'));
  process.env.APPDATA = appData;
  const SQL = await require('sql.js')(); SqlCtor = SQL.Database;
  const sqlite = require.resolve('better-sqlite3');
  require.cache[sqlite] = { id: sqlite, filename: sqlite, loaded: true, exports: FakeBetterSqlite } as unknown as NodeJS.Module;
  db = require('../database') as typeof import('../database'); db.initDatabase();
  gate = require('./gate-landed-service') as typeof import('./gate-landed-service');
  let passed = 0, failed = 0;
  for (const item of tests) {
    try { await item.run(); console.log(`  ok  ${item.name}`); passed += 1; }
    catch (error) { console.error(`  FAIL ${item.name}`); console.error(error); failed += 1; }
  }
  fs.rmSync(appData, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
