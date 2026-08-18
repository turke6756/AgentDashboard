// WP-3 — plan references on the production POST /api/agents launch seam.
//   npm run build:main
//   node dist/main/main/plans/plan-launch-binding.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { patchApplyStatusTransition } from '../supervisor/test-helpers/patch-apply-transition';
import type { Agent } from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

interface HttpResponse { status: number; body: Record<string, unknown>; }
function post(
  port: number,
  body: Record<string, unknown>,
  workspaceId: string,
  supervisorId: string,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/agents', method: 'POST', agent: false,
      headers: {
        Authorization: `Bearer ${require('../security/api-auth').getApiToken()}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Workspace-Id': workspaceId,
        'X-Supervisor-Id': supervisorId,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

(async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'wp3-plan-launch-appdata-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp3-plan-launch-ws-'));
  const originalGrokHome = process.env.GROK_HOME;
  process.env.APPDATA = appData;
  process.env.GROK_HOME = path.join(appData, 'grok-home');

  // Load production modules, then replace their CommonJS database dependencies
  // with a deterministic in-memory boundary. The route and AgentSupervisor launch
  // implementation remain real; only persistence and process spawn are captured.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { AgentSupervisor } = require('../supervisor') as typeof import('../supervisor');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WindowsRunner } = require('../supervisor/windows-runner') as typeof import('../supervisor/windows-runner');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ApiServer } = require('../api-server') as typeof import('../api-server');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { makeAgent } = require('../supervisor/test-helpers/fake-bridge-deps') as typeof import('../supervisor/test-helpers/fake-bridge-deps');

  const workspaceId = 'ws-launch-local';
  const supervisorId = 'supervisor-launch';
  const canonicalPlanId = '11111111-1111-4111-8111-111111111111';
  const foreignPlanId = '22222222-2222-4222-8222-222222222222';
  const portablePlanId = 'plan_1234abcd';
  const deletedPortablePlanId = 'plan_deadbeef';
  const workspace = {
    id: workspaceId, title: 'Launch workspace', path: workspaceRoot,
    pathType: 'windows', defaultCommand: 'claude --dangerously-skip-permissions',
  };
  const supervisorAgent = makeAgent(supervisorId, {
    workspaceId, title: 'Launch supervisor', isSupervisor: true, isSupervised: false,
  });
  const plan = (id: string, artifactId: string, planWorkspaceId = workspaceId, deletedAt: string | null = null) => ({
    id, planId: id, artifactId, workspaceId: planWorkspaceId,
    path: `.lares/plans/${artifactId}/plan.md`, deletedAt,
    title: artifactId, slug: artifactId, format: 'structured', mtimeMs: 1,
    sizeBytes: 1, createdAt: '2026-08-18T00:00:00.000Z',
  });
  const localPlan = plan(canonicalPlanId, portablePlanId);
  const deletedPlan = plan('33333333-3333-4333-8333-333333333333', deletedPortablePlanId, workspaceId, '2026-08-18T01:00:00.000Z');
  const foreignPlan = plan(foreignPlanId, 'plan_feedface', 'ws-launch-foreign');

  const createdAgents: Agent[] = [];
  const launchedEnvs: Array<Record<string, string> | undefined> = [];
  const focusedPlanIds: string[] = [];
  const dbKeys = [
    'getWorkspace', 'getPlan', 'getPlanByWorkspaceArtifactId', 'getSupervisorAgent',
    'getAgent', 'createAgent', 'upsertSupervisorFocus', 'updateAgentStatus',
    'applyStatusTransition', 'updateAgentPid', 'addEvent', 'updateAgentLastOutput',
    'updateAgentExitCode', 'getActiveAgents', 'getAllAgents', 'addFileActivity',
    'updateAgentResumeSessionId', 'getTeamMembership', 'getAgentTemplate',
    'getFileActivities', 'insertAgentSession', 'getCurrentBrick',
    'getContinuationAttempt',
  ];
  const originalDb = new Map<string, unknown>(dbKeys.map((key) => [key, db[key]]));
  const originalLaunch = WindowsRunner.prototype.launch;

  db.getWorkspace = (id: string) => id === workspaceId ? workspace : null;
  db.getPlan = (id: string) => id === canonicalPlanId ? localPlan : id === foreignPlanId ? foreignPlan : null;
  db.getPlanByWorkspaceArtifactId = (ws: string, ref: string) => {
    if (ws !== workspaceId) return null;
    if (ref === portablePlanId) return localPlan;
    if (ref === deletedPortablePlanId) return deletedPlan;
    return null;
  };
  db.getSupervisorAgent = () => supervisorAgent;
  db.getAgent = (id: string) => id === supervisorId
    ? supervisorAgent
    : createdAgents.find((agent) => agent.id === id) ?? null;
  db.createAgent = (input: Partial<Agent>) => {
    const agent = makeAgent(`launched-${createdAgents.length + 1}`, input);
    createdAgents.push(agent);
    return agent;
  };
  db.upsertSupervisorFocus = (input: { planId: string }) => { focusedPlanIds.push(input.planId); return input; };
  db.updateAgentStatus = () => {};
  db.updateAgentPid = () => {};
  db.addEvent = () => {};
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => createdAgents;
  db.getAllAgents = () => [supervisorAgent, ...createdAgents];
  db.addFileActivity = () => null;
  db.updateAgentResumeSessionId = () => {};
  db.getTeamMembership = () => null;
  db.getAgentTemplate = () => null;
  db.getFileActivities = () => [];
  db.insertAgentSession = () => {};
  db.getCurrentBrick = () => null;
  db.getContinuationAttempt = () => null;
  patchApplyStatusTransition(db);

  WindowsRunner.prototype.launch = function (
    _workDir: string,
    _command: string,
    _args: string[],
    _logPath: string,
    _directSpawn = false,
    extraEnv?: Record<string, string>,
  ): void {
    launchedEnvs.push(extraEnv);
    Object.assign(this as unknown as Record<string, unknown>, { _pid: 12345, _alive: true });
  };

  const supervisor = new AgentSupervisor();
  (supervisor as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
  (supervisor as unknown as { ensureWorkspaceScripts: () => void }).ensureWorkspaceScripts = () => {};
  const server = new ApiServer(supervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  supervisor.setApiServerPort(port);

  test('agent-plan-env-holds-canonical-uuid', async () => {
    const response = await post(port, {
      workspaceId, title: 'portable-bound worker', provider: 'grok',
      isSupervised: true, plan_id: portablePlanId,
    }, workspaceId, supervisorId);
    assert.equal(response.status, 200);
    const agent = createdAgents.at(-1)!;
    assert.equal(
      agent.planId,
      canonicalPlanId,
      'REACHABILITY:agent-plan-env-uuid agents.plan_id must freeze the resolved row UUID',
    );
    assert.equal(
      launchedEnvs.at(-1)?.AGENT_DASHBOARD_PLAN_ID,
      canonicalPlanId,
      'REACHABILITY:agent-plan-env-uuid child env must carry the resolved row UUID',
    );
    assert.equal(focusedPlanIds.at(-1), canonicalPlanId, 'auto-focus must record the resolved row UUID');
  });

  test('agents-route-resolves-plan-ref-after-authorization', async () => {
    const unauthorizedScope = await post(port, {
      workspaceId: 'ws-launch-foreign', title: 'wrong-scope worker', provider: 'grok',
      isSupervised: true, plan_id: portablePlanId,
    }, workspaceId, supervisorId);
    assert.deepEqual(
      { status: unauthorizedScope.status, code: unauthorizedScope.body.code },
      { status: 403, code: 'workspace-scope-mismatch' },
      'REACHABILITY:agents-route-plan-ref workspace authorization must run before plan resolution',
    );

    const deleted = await post(port, {
      workspaceId, title: 'deleted-plan worker', provider: 'grok',
      isSupervised: true, plan_id: deletedPortablePlanId,
    }, workspaceId, supervisorId);
    assert.deepEqual(
      { status: deleted.status, code: deleted.body.code },
      { status: 409, code: 'plan_deleted' },
      'REACHABILITY:agents-route-plan-ref deleted plans must be rejected by the production route',
    );

    const foreign = await post(port, {
      workspaceId, title: 'foreign-plan worker', provider: 'grok',
      isSupervised: true, plan_id: foreignPlanId,
    }, workspaceId, supervisorId);
    assert.deepEqual(
      { status: foreign.status, code: foreign.body.code },
      { status: 403, code: 'plan_wrong_workspace' },
      'REACHABILITY:agents-route-plan-ref foreign UUID plans must be rejected by the production route',
    );
  });

  test('launch without a plan binding is unaffected', async () => {
    const focusCount = focusedPlanIds.length;
    const response = await post(port, {
      workspaceId, title: 'unbound worker', provider: 'grok', isSupervised: true,
    }, workspaceId, supervisorId);
    assert.equal(response.status, 200);
    assert.equal(createdAgents.at(-1)?.planId ?? null, null);
    assert.equal(launchedEnvs.at(-1)?.AGENT_DASHBOARD_PLAN_ID, undefined);
    assert.equal(focusedPlanIds.length, focusCount);
  });

  let failed = 0;
  try {
    for (const current of tests) {
      try { await current.run(); console.log(`  ok  ${current.name}`); }
      catch (error) { failed += 1; console.error(`  FAIL ${current.name}`); console.error(error); }
    }
  } finally {
    server.stop();
    WindowsRunner.prototype.launch = originalLaunch;
    for (const [key, value] of originalDb) db[key] = value;
    if (originalGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalGrokHome;
    try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(appData, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
