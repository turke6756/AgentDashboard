import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-scan-'));
process.env.APPDATA = appData;
const initSqlJs = require('sql.js');

type SqlJsDatabase = { exec(sql: string): unknown; run(sql: string, params?: unknown[]): unknown; prepare(sql: string): { bind(params: unknown[]): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): boolean } };
let SQL: { Database: new () => SqlJsDatabase };

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;
  constructor(dbPath = ':memory:') { this.db = FakeBetterSqlite.stores.get(dbPath) ?? new SQL.Database(); FakeBetterSqlite.stores.set(dbPath, this.db); }
  pragma(_sql: string): void {}
  close(): void {}
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) { const inner = this.db; return { run: (...p: unknown[]) => { inner.run(sql, p); return {}; }, get: (...p: unknown[]) => { const s = inner.prepare(sql); try { s.bind(p); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } }, all: (...p: unknown[]) => { const s = inner.prepare(sql); try { s.bind(p); const out: Record<string, unknown>[] = []; while (s.step()) out.push(s.getAsObject()); return out; } finally { s.free(); } } }; }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) { return (...args: A) => { this.db.exec('BEGIN'); try { const result = fn(...args); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }; }
}

(async () => {
  SQL = await initSqlJs();
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite } as unknown as NodeJS.Module;
  const dbm = require('./database') as {
    initDatabase(): void;
    getDb(): any;
    closeDatabaseForTests(): void;
    adoptStructuredPlan(input: {
      workspaceId: string; artifactId: string; folderRelPath: string; planPath: string;
      mtimeMs: number; sizeBytes: number;
    }): { planId: string; change: string };
  };
  const { runProposalScan } = require('./proposal-scan') as typeof import('./proposal-scan');
  const reconciler = require('./plans/plan-source-proposal-reconciler') as typeof import('./plans/plan-source-proposal-reconciler');
  dbm.initDatabase();
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-workspace-'));
  const proposalRoot = path.join(workspaceRoot, '.lares', 'proposals');
  fs.mkdirSync(proposalRoot, { recursive: true });
  const before = new Map<string, string>();
  const write = (name: string, body: string) => { const file = path.join(proposalRoot, name); fs.writeFileSync(file, body); before.set(file, fs.readFileSync(file, 'utf8')); };
  write('signed.md', '---\nartifact_id: prop_11111111\nauthor_agent_id: 11111111-1111-1111-1111-111111111111\nauthor_role: supervisor\ntitle: Signed\n---\nBody\n');
  write('external.md', '---\nartifact_id: prop_22222222\nauthor_agent_id: external-cli\ntitle: External\n---\nBody\n');
  write('unsigned.md', '# Unsigned\n');
  write('broken.md', '---\nartifact_id: prop_33333333\n');
  const workspace = { id: 'scan-ws', title: 'scan', path: workspaceRoot, pathType: 'windows', description: '', defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: null } as any;
  const report = runProposalScan(workspace, { db: dbm.getDb(), now: () => 123 });
  assert.equal(report.discovered, 4); assert.equal(report.parsed, 3); assert.equal(report.parseFailed, 1);
  const rows = dbm.getDb().prepare('SELECT path, artifact_id, author_agent_id FROM proposals WHERE workspace_id=? ORDER BY path').all(workspace.id);
  assert.deepEqual(rows, [
    { path: '.lares/proposals/external.md', artifact_id: 'prop_22222222', author_agent_id: 'external-cli' },
    { path: '.lares/proposals/signed.md', artifact_id: 'prop_11111111', author_agent_id: '11111111-1111-1111-1111-111111111111' },
    { path: '.lares/proposals/unsigned.md', artifact_id: null, author_agent_id: null },
  ]);
  runProposalScan(workspace, { db: dbm.getDb(), now: () => 999 });
  for (const [file, body] of before) assert.equal(fs.readFileSync(file, 'utf8'), body);

  // Consumer integration: the scan registers the proposal; the reconciler,
  // not the scanner, is the only code that fills plans.source_proposal_id.
  const promotedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-promoted-workspace-'));
  const promotedProposalRel = '.lares/proposals/promoted.md';
  const promotedPlanRel = '.lares/plans/promoted';
  fs.mkdirSync(path.join(promotedRoot, '.lares', 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(promotedRoot, '.lares', 'plans', 'promoted'), { recursive: true });
  fs.writeFileSync(path.join(promotedRoot, promotedProposalRel), '---\nartifact_id: prop_44444444\ntitle: Promoted\n---\n# Promoted\n');
  fs.writeFileSync(path.join(promotedRoot, promotedPlanRel, 'plan.json'), JSON.stringify({
    schema_version: 1,
    plan_artifact_id: 'plan_44444444',
    source_proposal: { artifact_id: 'prop_44444444', rel_path: promotedProposalRel },
    created_at: 1_786_000_000_000,
  }));
  const promotedWorkspace = { ...workspace, id: 'promoted-ws', path: promotedRoot };
  const adopted = dbm.adoptStructuredPlan({
    workspaceId: promotedWorkspace.id,
    artifactId: 'plan_44444444',
    folderRelPath: promotedPlanRel,
    planPath: `${promotedPlanRel}/plan.md`,
    mtimeMs: 1,
    sizeBytes: 1,
  });
  const reconcileInput = {
    workspace: promotedWorkspace,
    planId: adopted.planId,
    folderAbs: path.join(promotedRoot, promotedPlanRel),
    expectedPlanArtifactId: 'plan_44444444',
    now: () => 1_786_000_000_100,
  };
  const beforeScan = reconciler.reconcilePlanSourceProposal(reconcileInput);
  assert.equal(beforeScan.status, 'absent');
  assert.equal(beforeScan.diagnostics[0]?.code, 'source-proposal-unregistered');
  assert.equal(dbm.getDb().prepare('SELECT source_proposal_id FROM plans WHERE id=?').get(adopted.planId).source_proposal_id, null);
  runProposalScan(promotedWorkspace, { db: dbm.getDb(), now: () => 456 });
  const afterScan = reconciler.reconcilePlanSourceProposal(reconcileInput);
  assert.equal(afterScan.status, 'synced');
  const linked = dbm.getDb().prepare('SELECT source_proposal_id FROM plans WHERE id=?').get(adopted.planId).source_proposal_id;
  const proposalId = dbm.getDb().prepare('SELECT id FROM proposals WHERE workspace_id=? AND path=?').get(promotedWorkspace.id, promotedProposalRel).id;
  assert.equal(linked, proposalId);
  fs.rmSync(promotedRoot, { recursive: true, force: true });
  console.log('proposal-scan.test: 5 passed');
  dbm.closeDatabaseForTests(); fs.rmSync(appData, { recursive: true, force: true }); fs.rmSync(workspaceRoot, { recursive: true, force: true });
})().catch((error) => { console.error(error); process.exitCode = 1; });
