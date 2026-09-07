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
  const registeredArtifactId = 'plan_00000001';
  const diskOnlyArtifactId = 'plan_00000002';
  const registeredPlanId = '00000000-0000-4000-8000-000000000111';
  const fleetEntries = Array.from({ length: 24 }, (_, index) => {
    const ordinal = String(index + 1).padStart(8, '0');
    return [`2026-08-23-fleet-${ordinal}`, `plan_${ordinal}`] as const;
  });
  for (const [folder, artifactId] of fleetEntries) {
    fs.mkdirSync(path.join(plansRoot, folder), { recursive: true });
    const stateCard = manifest(artifactId, folder);
    if (artifactId === diskOnlyArtifactId) delete stateCard.deploy;
    fs.writeFileSync(path.join(plansRoot, folder, 'plan.json'), JSON.stringify(stateCard));
  }

  // Patch the same database exports consumed by the production API and folder
  // enumerator, then enter through ApiServer.start() and the real HTTP route.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, any>;
  const keys = ['getWorkspace', 'getPlan', 'getPlanByWorkspaceArtifactId', 'getSupervisorAgent', 'listPlanWorkPackagesOrdered', 'readPlanGateProgressEvidence', 'listTurnRecords', 'getActiveAgents'];
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
  db.readPlanGateProgressEvidence = () => undefined;
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
    assert.equal(
      fleet.status,
      200,
      `REACHABILITY:list-plans-fleet real listener must register the fleet route: ${JSON.stringify(fleet.body)}`,
    );
    assert.equal(fleet.body.plans.length, 10, 'default page is limited to 10 plans');
    assert.equal(fleet.body.total_matched, fleetEntries.length);
    assert.equal(fleet.body.next_cursor, fleet.body.plans[9].plan_id);
    const diskOnly = fleet.body.plans.find((row: any) => row.plan_id === diskOnlyArtifactId);
    assert.ok(diskOnly);
    assert.equal(diskOnly.fresh, false);
    assert.equal(diskOnly.db_snapshot_version, null);
    assert.equal(diskOnly.snapshot_age_s, null);
    assert.equal(diskOnly.rollup, 'unknown');
    assert.equal(diskOnly.deploy, null);

    const filtered = await request(port, `/api/plans/state?plan_id=${diskOnlyArtifactId}`, workspaceId);
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.body.plans.map((row: any) => row.plan_id), [diskOnlyArtifactId]);
    assert.equal(filtered.body.next_cursor, null);
    assert.equal(filtered.body.total_matched, 1);

    const continued = await request(
      port,
      `/api/plans/state?cursor=${encodeURIComponent(fleet.body.next_cursor)}`,
      workspaceId,
    );
    assert.equal(continued.status, 200);
    const firstIds = fleet.body.plans.map((row: any) => row.plan_id);
    const continuedIds = continued.body.plans.map((row: any) => row.plan_id);
    assert.equal(firstIds.filter((id: string) => continuedIds.includes(id)).length, 0, 'pages do not overlap');
    assert.deepEqual(
      [...firstIds, ...continuedIds],
      fleetEntries.slice(0, 20).map(([, artifactId]) => artifactId),
      'cursor resumes immediately after the last returned plan_id',
    );

    const capped = await request(port, '/api/plans/state?limit=50', workspaceId);
    assert.equal(capped.status, 200);
    assert.ok(capped.body.plans.length < fleetEntries.length, 'oversized page is shrunk');
    assert.ok(capped.body.plans.length > 0, 'shrunk page still returns rows');
    assert.equal(capped.body.next_cursor, capped.body.plans.at(-1).plan_id);
    assert.equal(capped.body.total_matched, fleetEntries.length);
    assert.ok(Buffer.byteLength(JSON.stringify(capped.body), 'utf8') <= 6 * 1024);

    const invalidLimit = await request(port, '/api/plans/state?limit=0', workspaceId);
    assert.equal(invalidLimit.status, 400);
    console.log('  ok  list_plans fleet filters, pages, continues, and shrinks under the byte cap');
  } catch (error) {
    failed++;
    console.error('FAIL  list_plans fleet filters, pages, continues, and shrinks under the byte cap');
    console.error(error);
  } finally {
    server.stop();
    for (const [key, value] of originals) db[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n${1 - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
