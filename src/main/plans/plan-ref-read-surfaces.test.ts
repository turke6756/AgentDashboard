// WP-4 — dual-namespace plan references on read, focus, and filter HTTP seams.
//   npm run build:main
//   node dist/main/main/plans/plan-ref-read-surfaces.test.js

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AgentSupervisor } from '../supervisor';
import { getApiToken } from '../security/api-auth';
import { agentCapabilities } from '../security/agent-capabilities';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

interface Response { status: number; body: Record<string, any> }
function request(
  port: number,
  method: string,
  pathname: string,
  authorization: string,
  body?: Record<string, unknown>,
  identityHeaders: Record<string, string> = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string | number> = {
      Authorization: authorization,
      ...identityHeaders,
    };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method, headers, agent: false,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: raw ? JSON.parse(raw) as Record<string, any> : {},
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const workspaceId = 'ws-read-local';
const supervisorId = 'supervisor-read-local';
const canonicalPlanId = '11111111-1111-4111-8111-111111111111';
const deletedPlanId = '22222222-2222-4222-8222-222222222222';
const foreignPlanId = '33333333-3333-4333-8333-333333333333';
const portablePlanId = 'plan_1234abcd';
const deletedPortablePlanId = 'plan_deadbeef';

function plan(id: string, artifactId: string, planWorkspaceId: string, deletedAt: string | null = null) {
  return {
    id, artifactId, workspaceId: planWorkspaceId,
    path: `.lares/plans/${artifactId}/plan.md`, slug: artifactId, format: 'structured',
    runState: 'executing', mtimeMs: 1, sizeBytes: 1,
    createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
    deletedAt,
  };
}

function assertPlanRefFailure(response: Response, status: number, code: string): void {
  assert.deepEqual({ status: response.status, code: response.body.code }, { status, code });
}

(async () => {
  // Load the production server after obtaining mutable CommonJS database exports.
  // The real listener, auth gates, route registration, resolver, and serializer run;
  // only persistence/projection dependencies are deterministic fakes.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const planIpc = require('./plan-ipc') as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ApiServer } = require('../api-server') as typeof import('../api-server');

  const workspace = {
    id: workspaceId, title: 'Read workspace', path: 'C:/fixture/read-workspace',
    pathType: 'windows', defaultCommand: 'codex',
  };
  const supervisorAgent = {
    id: supervisorId, workspaceId, title: 'Read supervisor', isSupervisor: true,
    isSupervised: false, privilegeLane: 'supervisor', status: 'idle',
  };
  const localPlan = plan(canonicalPlanId, portablePlanId, workspaceId);
  const deletedPlan = plan(deletedPlanId, deletedPortablePlanId, workspaceId, '2026-08-18T01:00:00.000Z');
  const foreignPlan = plan(foreignPlanId, 'plan_feedface', 'ws-read-foreign');
  const plans = new Map([[canonicalPlanId, localPlan], [deletedPlanId, deletedPlan], [foreignPlanId, foreignPlan]]);

  const focused: string[] = [];
  const unfocused: string[] = [];
  const activityListPlanIds: Array<string | undefined> = [];
  const activityDigestPlanIds: Array<string | undefined> = [];
  const checkpointPlanIds: Array<string | undefined> = [];
  const dbKeys = [
    'getWorkspace', 'getPlan', 'getPlanByWorkspaceArtifactId', 'getSupervisorAgent',
    'getAgent', 'listPlanWorkPackagesOrdered', 'upsertSupervisorFocus', 'deleteSupervisorFocus',
  ];
  const originals = new Map<string, unknown>(dbKeys.map((key) => [key, db[key]]));
  const originalPlanFolders = planIpc.listPromotedPlanFolders;

  db.getWorkspace = (id: string) => id === workspaceId ? workspace : null;
  db.getPlan = (id: string) => plans.get(id) ?? null;
  db.getPlanByWorkspaceArtifactId = (ws: string, ref: string) => {
    if (ws !== workspaceId) return null;
    if (ref === portablePlanId) return localPlan;
    if (ref === deletedPortablePlanId) return deletedPlan;
    return null;
  };
  db.getSupervisorAgent = () => supervisorAgent;
  db.getAgent = (id: string) => id === supervisorId ? supervisorAgent : null;
  db.listPlanWorkPackagesOrdered = () => [];
  db.upsertSupervisorFocus = (input: { planId: string }) => { focused.push(input.planId); return input; };
  db.deleteSupervisorFocus = (_supervisor: string, planId: string) => { unfocused.push(planId); };
  planIpc.listPromotedPlanFolders = () => ({ plans: [], warnings: [] });

  const activityRoutes = {
    list: async (input: { planId?: string }) => {
      activityListPlanIds.push(input.planId);
      return { workspaceId, snapshot: null, items: [], hasMore: false };
    },
    digest: async (input: { planId?: string }) => {
      activityDigestPlanIds.push(input.planId);
      return { workspaceId, snapshot: null, groups: [] };
    },
    heartbeat: () => ({ workspaceId }),
    markViewed: async () => ({ ok: true }),
  };
  const checkpointRoutes = {
    list: (_ws: string, opts?: { planId?: string }) => {
      checkpointPlanIds.push(opts?.planId);
      return [];
    },
  };

  const server = new ApiServer({
    getContextStats: () => null, isInputInFlight: () => false, emit: () => false,
  } as unknown as AgentSupervisor, 0, undefined, '127.0.0.1');
  server.setActivityRoutes(activityRoutes as any);
  server.setCheckpointRoutes(checkpointRoutes as any);
  const port = await server.start();
  const globalAuth = `Bearer ${getApiToken()}`;
  const capabilityAuth = `Bearer ${agentCapabilities.mint({
    agentId: supervisorId, workspaceId, privilegeLane: 'supervisor',
  })}`;
  const identity = { 'X-Workspace-Id': workspaceId, 'X-Supervisor-Id': supervisorId };

  test('plan-progress-accepts-portable-ref', async () => {
    const portable = await request(port, 'GET', `/api/plans/${portablePlanId}/progress?detail=card`, globalAuth, undefined, identity);
    const uuid = await request(port, 'GET', `/api/plans/${canonicalPlanId}/progress?detail=card`, globalAuth, undefined, identity);
    assert.equal(portable.status, 200, 'REACHABILITY:plan-progress-plan-ref portable ref must enter the production progress route');
    assert.deepEqual(portable.body, uuid.body);
    assertPlanRefFailure(await request(port, 'GET', `/api/plans/${foreignPlanId}/progress?detail=card`, globalAuth, undefined, identity), 403, 'plan_wrong_workspace');
    assertPlanRefFailure(await request(port, 'GET', `/api/plans/${deletedPlanId}/progress?detail=card`, globalAuth, undefined, identity), 409, 'plan_deleted');
  });

  test('focus-self-accepts-portable-ref', async () => {
    const portable = await request(port, 'POST', '/api/supervisor-focus/self', globalAuth, { plan_id: portablePlanId }, identity);
    const uuid = await request(port, 'POST', '/api/supervisor-focus/self', globalAuth, { plan_id: canonicalPlanId }, identity);
    assert.equal(portable.status, 200, 'REACHABILITY:focus-self-plan-ref portable ref must enter the production self-focus route');
    assert.equal(uuid.status, 200);
    assert.deepEqual(
      focused.slice(-2),
      [canonicalPlanId, canonicalPlanId],
      'REACHABILITY:focus-self-plan-ref self-focus must persist the resolved row UUID',
    );
    assertPlanRefFailure(await request(port, 'POST', '/api/supervisor-focus/self', globalAuth, { plan_id: foreignPlanId }, identity), 403, 'plan_wrong_workspace');
    assertPlanRefFailure(await request(port, 'POST', '/api/supervisor-focus/self', globalAuth, { plan_id: deletedPlanId }, identity), 409, 'plan_deleted');
  });

  test('unfocus-self accepts either namespace and deletes by row UUID', async () => {
    assert.equal((await request(port, 'DELETE', `/api/supervisor-focus/self/${portablePlanId}`, globalAuth, undefined, identity)).status, 200);
    assert.equal((await request(port, 'DELETE', `/api/supervisor-focus/self/${canonicalPlanId}`, globalAuth, undefined, identity)).status, 200);
    assert.deepEqual(unfocused.slice(-2), [canonicalPlanId, canonicalPlanId]);
    assertPlanRefFailure(await request(port, 'DELETE', `/api/supervisor-focus/self/${foreignPlanId}`, globalAuth, undefined, identity), 403, 'plan_wrong_workspace');
    assertPlanRefFailure(await request(port, 'DELETE', `/api/supervisor-focus/self/${deletedPlanId}`, globalAuth, undefined, identity), 409, 'plan_deleted');
  });

  for (const [pathname, captured] of [
    ['/api/activity', activityListPlanIds],
    ['/api/activity/digest', activityDigestPlanIds],
  ] as const) {
    test(`${pathname} planId filter resolves before querying`, async () => {
      assert.equal((await request(port, 'GET', `${pathname}?planId=${portablePlanId}`, capabilityAuth)).status, 200);
      assert.equal((await request(port, 'GET', `${pathname}?planId=${canonicalPlanId}`, capabilityAuth)).status, 200);
      assert.deepEqual(captured.slice(-2), [canonicalPlanId, canonicalPlanId]);
      assertPlanRefFailure(await request(port, 'GET', `${pathname}?planId=${foreignPlanId}`, capabilityAuth), 403, 'plan_wrong_workspace');
      assertPlanRefFailure(await request(port, 'GET', `${pathname}?planId=${deletedPlanId}`, capabilityAuth), 409, 'plan_deleted');
    });
  }

  test('/api/checkpoints planId filter resolves before querying', async () => {
    assert.equal((await request(port, 'GET', `/api/checkpoints?planId=${portablePlanId}`, capabilityAuth)).status, 200);
    assert.equal((await request(port, 'GET', `/api/checkpoints?planId=${canonicalPlanId}`, capabilityAuth)).status, 200);
    assert.deepEqual(checkpointPlanIds.slice(-2), [canonicalPlanId, canonicalPlanId]);
    assertPlanRefFailure(await request(port, 'GET', `/api/checkpoints?planId=${foreignPlanId}`, capabilityAuth), 403, 'plan_wrong_workspace');
    assertPlanRefFailure(await request(port, 'GET', `/api/checkpoints?planId=${deletedPlanId}`, capabilityAuth), 409, 'plan_deleted');
  });

  let failed = 0;
  try {
    for (const current of tests) {
      try { await current.run(); console.log(`  ok  ${current.name}`); }
      catch (error) { failed += 1; console.error(`  FAIL ${current.name}`); console.error(error); }
    }
  } finally {
    server.stop();
    agentCapabilities.clear();
    for (const [key, value] of originals) db[key] = value;
    planIpc.listPromotedPlanFolders = originalPlanFolders;
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
