import assert from 'node:assert/strict';
import http from 'node:http';
import { ApiServer } from './api-server';
import { getApiToken } from './security/api-auth';
import type { AgentSupervisor } from './supervisor';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('./database') as Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const implement = require('./plans/plan-implement') as Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lifecycle = require('./plans/plan-lifecycle') as Record<string, any>;

const PLAN_ID = '11111111-2222-4333-8444-555555555555';
const WORKSPACE = { id: 'ws-1', title: 'Workspace', path: 'C:/workspace', pathType: 'windows' };
const PLAN = {
  id: PLAN_ID, workspaceId: WORKSPACE.id, path: '.lares/plans/one/plan.md',
  slug: 'one', format: 'structured', runState: 'ready', mtimeMs: 1, sizeBytes: 1,
  createdAt: 't0', updatedAt: 't0', deletedAt: null, artifactId: 'plan_1234abcd',
};

let implementInput: any = null;
let markReadyInput: any = null;
let planRunState = 'ready';
let markReadyResult: any = null;
let callOrder: string[] = [];

function agent(id: string, supervisor: boolean): any {
  return { id, workspaceId: WORKSPACE.id, isSupervisor: supervisor, privilegeLane: null };
}

function installStubs(): void {
  implementInput = null;
  markReadyInput = null;
  planRunState = 'ready';
  markReadyResult = null;
  callOrder = [];
  db.getWorkspace = (id: string) => id === WORKSPACE.id ? WORKSPACE : null;
  db.getSupervisorAgent = () => agent('sup-owner', true);
  db.getAgent = (id: string) => {
    if (id === 'worker') return agent(id, false);
    if (id === 'sup-owner' || id === 'sup-other') return agent(id, true);
    return null;
  };
  db.getPlan = (id: string) => id === PLAN_ID ? { ...PLAN, runState: planRunState } : null;
  db.getPlanResponsibleSupervisorId = (id: string) => id === PLAN_ID ? 'sup-owner' : null;
  lifecycle.markPlanReady = async (input: any) => {
    markReadyInput = input;
    callOrder.push('mark-ready');
    if (!markReadyResult) throw new Error('unexpected markPlanReady call');
    if (markReadyResult.ok) planRunState = 'ready';
    return markReadyResult;
  };
  implement.implementPlan = async (input: any) => {
    implementInput = input;
    callOrder.push('implement');
    return {
      ok: true,
      run: {
        id: 'run-1', planId: PLAN_ID, repositoryKey: 'repo', baselineKind: 'head',
        baselineHeadOid: 'a'.repeat(40), baselineRef: 'refs/lares/plan',
        triggerSource: input.trigger.source, appUserId: input.trigger.agentId,
        triggeredAt: 1, lifecycleState: 'active',
      },
      failures: [],
      tabsMissingOverview: [],
    };
  };
}

const stubSupervisor = {
  getContextStats: () => null,
  isInputInFlight: () => false,
  emit: () => false,
} as unknown as AgentSupervisor;

interface Response { status: number; body: any; }
function request(port: number, supervisorId: string): Promise<Response> {
  const headers = {
    Authorization: `Bearer ${getApiToken()}`,
    'X-Workspace-Id': WORKSPACE.id,
    'X-Supervisor-Id': supervisorId,
  };
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST',
      path: `/api/plans/${PLAN_ID}/implement`, headers, agent: false,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(run: (port: number) => Promise<void>): Promise<void> {
  installStubs();
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  try { await run(port); } finally { server.stop(); }
}

test('POST implement rejects a non-supervisor caller with 403', () =>
  withServer(async (port) => {
    const response = await request(port, 'worker');
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'not-a-supervisor');
    assert.equal(implementInput, null);
  }));

test('POST implement rejects a supervisor who is not responsible with 403', () =>
  withServer(async (port) => {
    const response = await request(port, 'sup-other');
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'not-responsible-supervisor');
    assert.equal(implementInput, null);
  }));

test('REACHABILITY:plan-implement-http stamps the authenticated responsible supervisor', () =>
  withServer(async (port) => {
    const response = await request(port, 'sup-owner');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(implementInput, {
      planId: PLAN_ID,
      appUserId: 'sup-owner',
      trigger: { source: 'supervisor-agent', agentId: 'sup-owner' },
    });
    assert.equal(response.body.run.triggerSource, 'supervisor-agent');
    assert.equal(response.body.run.appUserId, 'sup-owner');
  }));

test('REACHABILITY:plan-implement-http marks a ready hardening plan then executes as the supervisor agent', () =>
  withServer(async (port) => {
    planRunState = 'hardening';
    markReadyResult = { ok: true, runState: 'ready', failures: [], tabsMissingOverview: [] };

    const response = await request(port, 'sup-owner');

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(markReadyInput, { planId: PLAN_ID, actor: 'sup-owner' });
    assert.deepEqual(callOrder, ['mark-ready', 'implement']);
    assert.deepEqual(implementInput, {
      planId: PLAN_ID,
      appUserId: 'sup-owner',
      trigger: { source: 'supervisor-agent', agentId: 'sup-owner' },
    });
    assert.equal(response.body.run.triggerSource, 'supervisor-agent');
    assert.equal(response.body.run.appUserId, 'sup-owner');
  }));

test('hardening readiness failure returns its diagnostics without creating a run', () =>
  withServer(async (port) => {
    planRunState = 'hardening';
    markReadyResult = {
      ok: false,
      runState: 'hardening',
      failures: ['no-ready-package'],
      tabsMissingOverview: ['discussion'],
    };

    const response = await request(port, 'sup-owner');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      ok: false,
      run: null,
      failures: ['no-ready-package'],
      tabsMissingOverview: ['discussion'],
    });
    assert.deepEqual(markReadyInput, { planId: PLAN_ID, actor: 'sup-owner' });
    assert.deepEqual(callOrder, ['mark-ready']);
    assert.equal(implementInput, null);
  }));

(async () => {
  let failed = 0;
  for (const entry of tests) {
    try { await entry.run(); console.log(`  ✓ ${entry.name}`); }
    catch (error) {
      failed++;
      console.error(`  ✗ ${entry.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} api-server-plan-implement tests passed`);
})();
