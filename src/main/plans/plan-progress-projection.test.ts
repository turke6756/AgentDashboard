import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AgentSupervisor } from '../supervisor';
import type { PlanWorkPackage } from '../database';
import type { PromotedPlanFolder } from '../../shared/types';
import { getApiToken } from '../security/api-auth';
import { ApiServer, planStateRow } from '../api-server';
import { summarizePlanGateProgressRows } from '../database';
import {
  buildPlanProgressProjection,
  PLAN_PROGRESS_LIMITS,
} from './plan-progress-projection';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

function pkg(id: string, state: PlanWorkPackage['state'], order: number, title = `Package ${id}`): PlanWorkPackage {
  return {
    id,
    workspaceId: 'ws-a',
    planId: '00000000-0000-4000-8000-000000000001',
    intentId: null,
    schemaVersion: 2,
    contentHash: null,
    projectionStatus: 'synced',
    title,
    acceptanceCondition: null,
    state,
    assigneeAgentId: null,
    revision: 1,
    createdAt: order,
    updatedAt: 1_786_000_000_000 + order,
  };
}

const plan = { id: '00000000-0000-4000-8000-000000000001', slug: 'local-plan', runState: 'executing', updatedAt: '2026-08-09 20:00:00' };

const emptyGateEvidence = {
  highWater: { rowCount: 0, maxRowId: 0, maxDecidedAt: 0 },
  overrideCount: 0,
  byPackage: {},
};

function card(overrides: Partial<PromotedPlanFolder> = {}): PromotedPlanFolder {
  return {
    planArtifactId: 'plan_artifact_local',
    planId: '00000000-0000-4000-8000-000000000001',
    folderName: 'local-plan',
    title: 'Local plan',
    status: 'executing',
    archived: false,
    updatedAt: 1,
    responsibleSupervisor: { display: 'Owner', agentId: 'agent-owner', source: 'manifest' },
    latestLifecycleKind: 'implementation_started',
    lifecycle: 'executing',
    rollup: { total: 1, landed: 0, remaining: 1, archived: 0, completed: false },
    activeVerifiedTurnCount: 1,
    activityTier: 'active',
    ...overrides,
  };
}

test('card consumes the WP-3 lifecycle/activity DTO and stays within 2 KiB', () => {
  const projection = buildPlanProgressProjection({
    detail: 'card',
    plan,
    card: card({ title: '🚀'.repeat(2_000), responsibleSupervisor: { display: 'x'.repeat(4_000), agentId: 'agent-owner', source: null } }),
    packages: [pkg('WP-1', 'executing', 1)],
    gateEvidence: emptyGateEvidence,
  }) as any;
  assert.equal(projection.latestLifecycleKind, 'implementation_started');
  assert.equal(
    projection.activityTier,
    'active',
    'REACHABILITY:wp13-plan-progress-construct production construct must carry the WP-3 activity tier',
  );
  assert.equal(projection.badge, 'executing');
  assert.equal(projection.complete, false);
  assert.match(projection.db_snapshot_version, /^sha256:[a-f0-9]{64}$/);
  assert.equal(typeof projection.snapshot_age_s, 'number');
  assert.equal(projection.fresh, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(projection), 'utf8') <= PLAN_PROGRESS_LIMITS.cardBytes,
    'REACHABILITY:wp13-plan-progress-construct card projection must enforce its byte ceiling',
  );
});

test('packages prioritizes blocked then executing before the 40-row cap and reports every omission', () => {
  const stable: PlanWorkPackage[] = [];
  for (let i = 0; i < 12; i++) stable.push(pkg(`ready-${i}`, 'ready', stable.length));
  for (let i = 0; i < 45; i++) stable.push(pkg(`blocked-${i}`, 'blocked', stable.length));
  for (let i = 0; i < 7; i++) stable.push(pkg(`done-${i}`, 'done', stable.length));
  for (let i = 0; i < 5; i++) stable.push(pkg(`executing-${i}`, 'executing', stable.length));
  const projection = buildPlanProgressProjection({ detail: 'packages', plan, card: card(), packages: stable, gateEvidence: emptyGateEvidence }) as any;
  assert.ok(projection.packages.length <= 40);
  assert.ok(projection.packages.every((row: any) => row.state === 'blocked'));
  assert.deepEqual(projection.packages.map((row: any) => row.id), stable.filter((row) => row.state === 'blocked').slice(0, projection.packages.length).map((row) => row.id));
  assert.equal(projection.packages_omitted, stable.length - projection.packages.length);
  assert.deepEqual(projection.packages_omitted_by_state, {
    blocked: 45 - projection.packages.length, executing: 5, ready: 12, done: 7, archived: 0,
  });
  assert.equal(projection.rollup.completed, false);
});

test('packages dynamically truncates under 4 KiB with UTF-8 title and accurate state omissions', () => {
  const packages = Array.from({ length: 70 }, (_, i) =>
    pkg(`WP-${String(i).padStart(3, '0')}-${'id'.repeat(12)}`, i % 3 === 0 ? 'blocked' : i % 3 === 1 ? 'executing' : 'ready', i, '🌍'.repeat(500)));
  const projection = buildPlanProgressProjection({ detail: 'packages', plan, card: card(), packages, gateEvidence: emptyGateEvidence }) as any;
  assert.ok(Buffer.byteLength(JSON.stringify(projection), 'utf8') <= PLAN_PROGRESS_LIMITS.packagesBytes);
  assert.ok(projection.packages.length < PLAN_PROGRESS_LIMITS.packageRows, 'byte ceiling wins over row cap');
  assert.ok(projection.packages.every((row: any) => Buffer.byteLength(row.title, 'utf8') <= PLAN_PROGRESS_LIMITS.titleBytes));
  const omittedTotal = Object.values(projection.packages_omitted_by_state).reduce((sum: number, value) => sum + Number(value), 0);
  assert.equal(omittedTotal, projection.packages_omitted);
  assert.equal(projection.packages.length + projection.packages_omitted, packages.length);
});

test('plan_6e3298be stale 0/8 snapshot fails closed to an unknown rollup', () => {
  const stalePlan = {
    ...plan,
    slug: 'researchers-are-workers-delete-the-home-redirect-6e3298be',
    updatedAt: '2026-08-15 18:00:00',
  };
  const stalePackages = Array.from({ length: 8 }, (_, index) => ({
    ...pkg(`WP-${index + 1}`, 'ready', index),
    updatedAt: Date.parse('2026-08-15T18:00:00Z'),
  }));
  const diskCard = card({
    planArtifactId: 'plan_6e3298be',
    updatedAt: '2026-08-17T12:00:00Z',
    rollup: { total: 8, landed: 0, remaining: 8, archived: 0, completed: false },
  });

  const projection = buildPlanProgressProjection({
    detail: 'packages',
    plan: stalePlan,
    card: diskCard,
    packages: stalePackages,
    gateEvidence: emptyGateEvidence,
    nowMs: Date.parse('2026-08-20T18:00:00Z'),
  }) as any;

  assert.equal(projection.fresh, false, 'disk state newer than the DB snapshot cannot prove currency');
  assert.equal(projection.snapshot_age_s, 5 * 24 * 60 * 60);
  assert.match(projection.db_snapshot_version, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    projection.rollup,
    'unknown',
    'REACHABILITY:plan-43d6b04d-wp3-freshness stale 0/8 must never escape as a confident count',
  );
});

test('missing currency evidence adds freshness fields and fails closed on both detail responses', () => {
  for (const detail of ['card', 'packages'] as const) {
    const projection = buildPlanProgressProjection({ detail, plan, card: null, packages: [pkg('WP-1', 'ready', 1)], gateEvidence: emptyGateEvidence }) as any;
    assert.deepEqual(
      Object.keys(projection).filter((key) => ['db_snapshot_version', 'snapshot_age_s', 'fresh'].includes(key)).sort(),
      ['db_snapshot_version', 'fresh', 'snapshot_age_s'],
    );
    assert.equal(projection.fresh, false);
    assert.equal(projection.rollup, 'unknown');
  }
});

test('gate high-water refreshes an otherwise unchanged snapshot and override fields survive byte caps', () => {
  const packages = Array.from({ length: 70 }, (_, index) =>
    pkg(`WP-${index}`, index % 2 === 0 ? 'blocked' : 'executing', index, '🌍'.repeat(500)));
  const gateEvidence = {
    highWater: { rowCount: 3, maxRowId: 41, maxDecidedAt: 1_786_000_000_100 },
    overrideCount: 2,
    byPackage: {
      'WP-0': { latestDecision: 'passed-by-override' as const, overrideCount: 2 },
      'WP-1': { latestDecision: 'passed' as const, overrideCount: 0 },
    },
  };
  const before = buildPlanProgressProjection({
    detail: 'card', plan: { ...plan, landedGateMode: 'strict' }, card: card(), packages,
    gateEvidence: { ...emptyGateEvidence, highWater: { rowCount: 2, maxRowId: 40, maxDecidedAt: 1_786_000_000_000 } },
  }) as any;
  const cardProjection = buildPlanProgressProjection({
    detail: 'card', plan: { ...plan, landedGateMode: 'strict' }, card: card(), packages, gateEvidence,
  }) as any;
  const packageProjection = buildPlanProgressProjection({
    detail: 'packages', plan: { ...plan, landedGateMode: 'strict' }, card: card(), packages, gateEvidence,
  }) as any;
  assert.notEqual(
    before.db_snapshot_version,
    cardProjection.db_snapshot_version,
    'REACHABILITY:plan-progress-projection gate high-water must participate in snapshotVersion',
  );
  assert.equal(cardProjection.landed_gate_mode, 'strict');
  assert.equal(cardProjection.override_count, 2);
  assert.equal(packageProjection.override_count, 2);
  const overridden = packageProjection.packages.find((row: any) => row.id === 'WP-0');
  assert.equal(overridden.gate_decision, 'passed-by-override');
  assert.equal(overridden.override_count, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(cardProjection), 'utf8') <= PLAN_PROGRESS_LIMITS.cardBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(packageProjection), 'utf8') <= PLAN_PROGRESS_LIMITS.packagesBytes);

  const fleetRow = planStateRow({
    plan_artifact_id: 'plan_11111111', title: 'Fleet row', status: 'in_progress',
  }, null, cardProjection);
  assert.equal(fleetRow.override_count, 2);
  assert.equal(fleetRow.landed_gate_mode, 'strict');
  assert.ok(Buffer.byteLength(JSON.stringify(fleetRow), 'utf8') <= 512);
});

test('gate evidence orders passed decisions by attempt then rowid and keeps revision 1 ordinary', () => {
  const marker = (evidence: unknown) => `package-ledger:v1:${JSON.stringify({
    version: 1, digest: 'd', result: { idempotencyKey: 'k' }, evidence,
  })}`;
  const summary = summarizePlanGateProgressRows([
    { row_id: 10, package_id: 'WP-1', gate_revision: 2, attempt_no: 4, outcome: 'passed', decided_at: 100, evidence_json: marker({ schemaVersion: 2, decision: 'passed-by-override' }) },
    { row_id: 11, package_id: 'WP-1', gate_revision: 2, attempt_no: 3, outcome: 'passed', decided_at: 101, evidence_json: marker({ schemaVersion: 2, decision: 'passed' }) },
    { row_id: 12, package_id: 'WP-1', gate_revision: 2, attempt_no: 4, outcome: 'passed', decided_at: 102, evidence_json: marker({ schemaVersion: 2, decision: 'passed' }) },
    { row_id: 13, package_id: 'WP-2', gate_revision: 1, attempt_no: 1, outcome: 'passed', decided_at: null, evidence_json: marker({ schemaVersion: 2, decision: 'passed-by-override' }) },
    { row_id: 14, package_id: 'WP-3', gate_revision: 2, attempt_no: 9, outcome: 'failed', decided_at: 104, evidence_json: marker({ schemaVersion: 2, decision: 'passed-by-override' }) },
  ]);
  assert.deepEqual(summary.highWater, { rowCount: 5, maxRowId: 14, maxDecidedAt: 104 });
  assert.equal(summary.overrideCount, 1);
  assert.deepEqual(summary.byPackage['WP-1'], { latestDecision: 'passed', overrideCount: 1 });
  assert.deepEqual(summary.byPackage['WP-2'], { latestDecision: 'passed', overrideCount: 0 });
  assert.deepEqual(summary.byPackage['WP-3'], { latestDecision: null, overrideCount: 0 });
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plansScript = require(path.join(process.cwd(), 'scripts', 'mcp-tools-plans.js')) as {
  getPlansReadToolDefinitions(): Array<{ name: string }>;
  handlePlansReadToolCall(name: string, args: Record<string, unknown>, apiRequest: (...args: any[]) => Promise<unknown>): Promise<any>;
};

test('plans-read advertises and dispatches read_plan_progress to the API endpoint', async () => {
  assert.ok(plansScript.getPlansReadToolDefinitions().some((def) => def.name === 'read_plan_progress'));
  const calls: any[][] = [];
  const result = await plansScript.handlePlansReadToolCall(
    'read_plan_progress',
    { plan_id: 'plan / local', detail: 'packages' },
    async (...args: any[]) => { calls.push(args); return { ok: true }; },
  );
  assert.deepEqual(calls, [['GET', '/api/plans/plan%20%2F%20local/progress?detail=packages']]);
  assert.match(result.content[0].text, /"ok": true/);
});

interface Response { status: number; body: string }
function request(port: number, path: string, workspaceId?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${getApiToken()}` };
    if (workspaceId) headers['X-Workspace-Id'] = workspaceId;
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('real API registration derives workspace from caller and rejects a cross-workspace plan', async () => {
  // Patch the CommonJS exports read by ApiServer's production imports. This test
  // enters through start() and the real HTTP listener; it does not call route().
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, any>;
  const workspaceDescriptor = Object.getOwnPropertyDescriptor(db, 'getWorkspace');
  if (workspaceDescriptor?.get && !workspaceDescriptor.set && workspaceDescriptor.configurable === false) {
    // A bundled esbuild scratch test freezes live exports as getters. The
    // projection + fleet-row tests above still exercise WP-6 there; the normal
    // registered TypeScript output enters this listener test.
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const planIpc = require('./plan-ipc') as Record<string, any>;
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp6-plan-progress-'));
  const planFolder = path.join(workspaceRoot, '.lares', 'plans', 'local-plan');
  fs.mkdirSync(planFolder, { recursive: true });
  fs.writeFileSync(path.join(planFolder, 'plan.json'), JSON.stringify({
    schema_version: 2,
    plan_artifact_id: 'plan_11111111',
    title: 'Local plan',
    status: 'in_progress',
    state_updated_at: 1,
  }));
  const workspace = { id: 'ws-a', title: 'A', path: workspaceRoot, pathType: 'windows' };
  db.getWorkspace = (id: string) => id === 'ws-a' ? workspace : null;
  db.getSupervisorAgent = () => null;
  db.getPlan = (id: string) => id === '00000000-0000-4000-8000-000000000001'
    ? { ...plan, artifactId: 'plan_11111111', landedGateMode: 'strict', workspaceId: 'ws-a', path: 'plans/local.md', format: 'structured', mtimeMs: 1, sizeBytes: 1, createdAt: 't', deletedAt: null }
    : id === '00000000-0000-4000-8000-000000000002'
      ? { ...plan, id, workspaceId: 'ws-b', path: 'plans/foreign.md', format: 'structured', mtimeMs: 1, sizeBytes: 1, createdAt: 't', deletedAt: null }
      : null;
  db.getPlanByWorkspaceArtifactId = (workspaceId: string, artifactId: string) =>
    workspaceId === 'ws-a' && artifactId === 'plan_11111111'
      ? db.getPlan('00000000-0000-4000-8000-000000000001')
      : null;
  db.listPlanWorkPackagesOrdered = (id: string) => id === '00000000-0000-4000-8000-000000000001' ? [pkg('WP-1', 'executing', 1)] : [];
  db.readPlanGateProgressEvidence = () => ({
    highWater: { rowCount: 1, maxRowId: 20, maxDecidedAt: 30 },
    overrideCount: 1,
    byPackage: { 'WP-1': { latestDecision: 'passed-by-override', overrideCount: 1 } },
  });
  let cardReads = 0;
  planIpc.listPromotedPlanFolders = () => { cardReads++; return { plans: [card({ planArtifactId: 'plan_11111111' })], warnings: [] }; };

  const supervisor = { getContextStats: () => null, isInputInFlight: () => false, emit: () => false } as unknown as AgentSupervisor;
  const server = new ApiServer(supervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  try {
    assert.equal(
      (await request(port, '/api/plans/00000000-0000-4000-8000-000000000001/progress?detail=card')).status,
      400,
      'REACHABILITY:wp13-plan-progress real listener must register the authenticated plan-progress route',
    );
    const local = await request(port, '/api/plans/00000000-0000-4000-8000-000000000001/progress?detail=card', 'ws-a');
    assert.equal(local.status, 200, 'REACHABILITY:wp13-plan-progress real listener must register the plan-progress route');
    assert.equal(JSON.parse(local.body).activityTier, 'active');
    assert.equal(JSON.parse(local.body).override_count, 1);
    const packageDetail = JSON.parse((await request(
      port,
      '/api/plans/00000000-0000-4000-8000-000000000001/progress?detail=packages',
      'ws-a',
    )).body);
    assert.equal(packageDetail.packages[0].gate_decision, 'passed-by-override');
    const fleet = JSON.parse((await request(port, '/api/plans/state', 'ws-a')).body);
    assert.equal(fleet.plans[0].override_count, 1);
    assert.equal(fleet.plans[0].landed_gate_mode, 'strict');
    assert.ok(Buffer.byteLength(JSON.stringify(fleet.plans[0]), 'utf8') <= 512);
    const foreign = await request(port, '/api/plans/00000000-0000-4000-8000-000000000002/progress?detail=card', 'ws-a');
    assert.equal(foreign.status, 403);
    assert.equal(cardReads, 3, 'foreign plan must be rejected before another card projection read');
  } finally {
    server.stop();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

(async () => {
  let failed = 0;
  for (const current of tests) {
    try { await current.run(); console.log(`  ok  ${current.name}`); }
    catch (error) { failed++; console.error(`FAIL  ${current.name}`); console.error(error); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
