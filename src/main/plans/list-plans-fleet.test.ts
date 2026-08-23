import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AgentSupervisor } from '../supervisor';
import { getApiToken } from '../security/api-auth';

interface Response { status: number; body: Record<string, any> }

function request(port: number, pathname: string, workspaceId: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: 'GET', agent: false,
      headers: { Authorization: `Bearer ${getApiToken()}`, 'X-Workspace-Id': workspaceId },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function manifest(planArtifactId: string, title: string): Record<string, unknown> {
  return {
    schema_version: 2,
    plan_artifact_id: planArtifactId,
    plan_sku: `2026-08-23-${title}`,
    source_proposal: { artifact_id: `prop_${planArtifactId.slice(5)}`, rel_path: `.lares/proposals/${title}.md` },
    responsibility_events: [],
    created_at: 1,
    updated_at: 1,
    title,
    status: 'code_complete',
    rollup: { total: 2, landed: 2, remaining: 0, dropped: 0 },
    deploy: { code: 'local_unpushed', restart_required: true },
    project: 'Fleet test',
    state_updated_at: 1,
  };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-list-plans-fleet-'));
  const plansRoot = path.join(root, '.lares', 'plans');
  const workspaceId = 'ws-list-plans-fleet';
  const registeredArtifactId = 'plan_11111111';
  const diskOnlyArtifactId = 'plan_22222222';
  const registeredPlanId = '00000000-0000-4000-8000-000000000111';
  for (const [folder, artifactId] of [
    ['2026-08-23-registered-11111111', registeredArtifactId],
    ['2026-08-23-disk-only-22222222', diskOnlyArtifactId],
  ] as const) {
    fs.mkdirSync(path.join(plansRoot, folder), { recursive: true });
    const stateCard = manifest(artifactId, folder);
    if (artifactId === diskOnlyArtifactId) delete stateCard.deploy;
    fs.writeFileSync(path.join(plansRoot, folder, 'plan.json'), JSON.stringify(stateCard));
  }

  // Patch the same database exports consumed by the production API and folder
  // enumerator, then enter through ApiServer.start() and the real HTTP route.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, any>;
  const keys = ['getWorkspace', 'getPlan', 'getPlanByWorkspaceArtifactId', 'getSupervisorAgent', 'listPlanWorkPackagesOrdered', 'listTurnRecords', 'getActiveAgents'];
  const originals = new Map(keys.map((key) => [key, db[key]]));
  const registeredPlan = {
    id: registeredPlanId, workspaceId, artifactId: registeredArtifactId, path: null,
    slug: 'registered', runState: 'code_complete', updatedAt: new Date().toISOString(),
    deletedAt: null, format: 'structured', mtimeMs: 1, sizeBytes: 1, createdAt: new Date().toISOString(),
  };
  db.getWorkspace = (id: string) => id === workspaceId
    ? { id: workspaceId, title: 'Fleet', path: root, pathType: 'windows', defaultCommand: 'codex' }
    : null;
  db.getPlan = (id: string) => id === registeredPlanId ? registeredPlan : null;
  db.getPlanByWorkspaceArtifactId = (ws: string, artifactId: string) =>
    ws === workspaceId && artifactId === registeredArtifactId ? registeredPlan : null;
  db.getSupervisorAgent = () => null;
  db.listPlanWorkPackagesOrdered = () => [];
  db.listTurnRecords = () => [];
  db.getActiveAgents = () => [];

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ApiServer } = require('../api-server') as typeof import('../api-server');
  const server = new ApiServer({
    getContextStats: () => null, isInputInFlight: () => false, emit: () => false,
  } as unknown as AgentSupervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  let failed = 0;
  try {
    const fleet = await request(port, '/api/plans/state', workspaceId);
    assert.equal(fleet.status, 200, 'REACHABILITY:list-plans-fleet real listener must register the fleet route');
    assert.deepEqual(fleet.body.plans.map((row: any) => row.plan_id), [registeredArtifactId, diskOnlyArtifactId]);
    const diskOnly = fleet.body.plans[1];
    assert.equal(diskOnly.fresh, false);
    assert.equal(diskOnly.db_snapshot_version, null);
    assert.equal(diskOnly.snapshot_age_s, null);
    assert.equal(diskOnly.rollup, 'unknown');
    assert.equal(diskOnly.deploy, null);

    const filtered = await request(port, `/api/plans/state?plan_id=${diskOnlyArtifactId}`, workspaceId);
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.body.plans.map((row: any) => row.plan_id), [diskOnlyArtifactId]);
    console.log('  ok  list_plans fleet includes and filters a disk-only stamped state card');
  } catch (error) {
    failed++;
    console.error('FAIL  list_plans fleet includes and filters a disk-only stamped state card');
    console.error(error);
  } finally {
    server.stop();
    for (const [key, value] of originals) db[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n${1 - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
