import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AgentSupervisor } from '../supervisor';
import type { PlanWorkPackage } from '../database';
import type { PromotedPlanFolder } from '../../shared/types';
import { getApiToken } from '../security/api-auth';
import { ApiServer } from '../api-server';
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
  }) as any;
  assert.equal(projection.latestLifecycleKind, 'implementation_started');
  assert.equal(
    projection.activityTier,
    'active',
    'REACHABILITY:wp13-plan-progress-construct production construct must carry the WP-3 activity tier',
  );
  assert.equal(projection.badge, 'executing');
  assert.equal(projection.complete, false);
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
  const projection = buildPlanProgressProjection({ detail: 'packages', plan, card: null, packages: stable }) as any;
  assert.equal(projection.packages.length, 40);
  assert.ok(projection.packages.every((row: any) => row.state === 'blocked'));
  assert.deepEqual(projection.packages.map((row: any) => row.id), stable.filter((row) => row.state === 'blocked').slice(0, 40).map((row) => row.id));
  assert.equal(projection.packages_omitted, 29);
  assert.deepEqual(projection.packages_omitted_by_state, {
    blocked: 5, executing: 5, ready: 12, done: 7, archived: 0,
  });
  assert.equal(projection.rollup.completed, false);
});

test('packages dynamically truncates under 4 KiB with UTF-8 title and accurate state omissions', () => {
  const packages = Array.from({ length: 70 }, (_, i) =>
    pkg(`WP-${String(i).padStart(3, '0')}-${'id'.repeat(12)}`, i % 3 === 0 ? 'blocked' : i % 3 === 1 ? 'executing' : 'ready', i, '🌍'.repeat(500)));
  const projection = buildPlanProgressProjection({ detail: 'packages', plan, card: null, packages }) as any;
  assert.ok(Buffer.byteLength(JSON.stringify(projection), 'utf8') <= PLAN_PROGRESS_LIMITS.packagesBytes);
  assert.ok(projection.packages.length < PLAN_PROGRESS_LIMITS.packageRows, 'byte ceiling wins over row cap');
  assert.ok(projection.packages.every((row: any) => Buffer.byteLength(row.title, 'utf8') <= PLAN_PROGRESS_LIMITS.titleBytes));
  const omittedTotal = Object.values(projection.packages_omitted_by_state).reduce((sum: number, value) => sum + Number(value), 0);
  assert.equal(omittedTotal, projection.packages_omitted);
  assert.equal(projection.packages.length + projection.packages_omitted, packages.length);
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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const planIpc = require('./plan-ipc') as Record<string, any>;
  const workspace = { id: 'ws-a', title: 'A', path: 'C:/fixture/a', pathType: 'windows' };
  db.getWorkspace = (id: string) => id === 'ws-a' ? workspace : null;
  db.getSupervisorAgent = () => null;
  db.getPlan = (id: string) => id === '00000000-0000-4000-8000-000000000001'
    ? { ...plan, workspaceId: 'ws-a', path: 'plans/local.md', format: 'structured', mtimeMs: 1, sizeBytes: 1, createdAt: 't', deletedAt: null }
    : id === '00000000-0000-4000-8000-000000000002'
      ? { ...plan, id, workspaceId: 'ws-b', path: 'plans/foreign.md', format: 'structured', mtimeMs: 1, sizeBytes: 1, createdAt: 't', deletedAt: null }
      : null;
  db.listPlanWorkPackagesOrdered = (id: string) => id === '00000000-0000-4000-8000-000000000001' ? [pkg('WP-1', 'executing', 1)] : [];
  let cardReads = 0;
  planIpc.listPromotedPlanFolders = () => { cardReads++; return { plans: [card()], warnings: [] }; };

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
    const foreign = await request(port, '/api/plans/00000000-0000-4000-8000-000000000002/progress?detail=card', 'ws-a');
    assert.equal(foreign.status, 403);
    assert.equal(cardReads, 1, 'foreign plan must be rejected before any card projection read');
  } finally {
    server.stop();
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
