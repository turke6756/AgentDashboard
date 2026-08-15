import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ingestProposalBatch, type ParsedProposal } from './proposal-ingest';
import { isCanonicalPlanRowId, PLAN_ROW_ID_RE } from '../shared/planning-artifact-ids';

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): { bind(params: unknown[]): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): boolean };
};

let sqlJsCtor: new () => SqlJsDatabase;

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private static lastPath = '';
  private db: SqlJsDatabase;
  constructor(dbPath = ':memory:') {
    FakeBetterSqlite.lastPath = dbPath;
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) { store = new sqlJsCtor(); FakeBetterSqlite.stores.set(dbPath, store); }
    this.db = store;
  }
  pragma(_sql: string): unknown { return undefined; }
  close(): void { /* retain fixture store like the house test */ }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => { const s = inner.prepare(sql); try { s.bind(params); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } },
      all: (...params: unknown[]) => { const s = inner.prepare(sql); try { s.bind(params); const rows: Record<string, unknown>[] = []; while (s.step()) rows.push(s.getAsObject()); return rows; } finally { s.free(); } },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) { return (...args: A) => { this.db.exec('BEGIN'); try { const result = fn(...args); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }; }
  static handle(): any {
    const inner = FakeBetterSqlite.stores.get(FakeBetterSqlite.lastPath)!;
    return {
      exec: (sql: string) => inner.exec(sql),
      prepare: (sql: string) => ({
        run: (...p: unknown[]) => { inner.run(sql, p); return {}; },
        get: (...p: unknown[]) => { const s = inner.prepare(sql); try { s.bind(p); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } },
        all: (...p: unknown[]) => { const s = inner.prepare(sql); try { s.bind(p); const rows: Record<string, unknown>[] = []; while (s.step()) rows.push(s.getAsObject()); return rows; } finally { s.free(); } },
      }),
    };
  }
}

const file = (path: string, artifactId: string | null, title = path): ParsedProposal => ({ path, artifactId, authorAgentId: 'external-cli', title });
const scan = (paths: string[], failed: string[] = []) => ({ seenPaths: new Set(paths), parseFailedPaths: new Set(failed) });

(async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-ingest-'));
  process.env.APPDATA = appData;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs(); sqlJsCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite } as unknown as NodeJS.Module;
  const dbm = require('./database') as { initDatabase(): void; closeDatabaseForTests(): void };
  dbm.initDatabase();
  const db = FakeBetterSqlite.handle();
  const ws = 'ws-ingest';
  try {
    ingestProposalBatch(db, ws, [file('z.md', 'ax'), file('a.md', 'ax')], scan(['z.md', 'a.md']));
    assert.deepEqual(db.prepare('SELECT path,artifact_id FROM proposals WHERE workspace_id=? ORDER BY path').all(ws), [{ path: 'a.md', artifact_id: 'ax' }, { path: 'z.md', artifact_id: null }]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM proposal_ingest_conflicts WHERE klass='duplicate-artifact-id'").get() as any).n, 1);

    const before = db.prepare('SELECT * FROM proposals WHERE workspace_id=? AND path=?').get(ws, 'a.md');
    ingestProposalBatch(db, ws, [file('b.md', 'bx')], scan(['a.md', 'b.md'], ['a.md']));
    assert.deepEqual(db.prepare('SELECT * FROM proposals WHERE workspace_id=? AND path=?').get(ws, 'a.md'), before);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM proposal_ingest_conflicts WHERE path='a.md' AND klass='parse-failed'").get() as any).n, 1);
    assert.ok(db.prepare('SELECT * FROM proposals WHERE workspace_id=? AND path=?').get(ws, 'b.md'));

    ingestProposalBatch(db, ws, [file('b2.md', 'ax')], scan(['a.md', 'b2.md'], ['a.md']));
    assert.equal((db.prepare('SELECT artifact_id FROM proposals WHERE workspace_id=? AND path=?').get(ws, 'a.md') as any).artifact_id, 'ax');
    assert.equal((db.prepare('SELECT artifact_id FROM proposals WHERE workspace_id=? AND path=?').get(ws, 'b2.md') as any).artifact_id, null);

    const reassignmentWs = 'ws-reassign';
    ingestProposalBatch(db, reassignmentWs, [file('a.md', 'x')], scan(['a.md']));
    ingestProposalBatch(db, reassignmentWs, [file('a.md', 'y'), file('b.md', 'x')], scan(['a.md', 'b.md']));
    assert.deepEqual(db.prepare('SELECT path,artifact_id FROM proposals WHERE workspace_id=? ORDER BY path').all(reassignmentWs), [{ path: 'a.md', artifact_id: 'y' }, { path: 'b.md', artifact_id: 'x' }]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM proposal_ingest_conflicts WHERE workspace_id=? AND path='a.md' AND klass='artifact-id-reassigned'").get(reassignmentWs) as any).n, 1);

    const revivalPath = 'revival.md';
    const revivalArtifact = 'revival-artifact';
    ingestProposalBatch(db, ws, [file(revivalPath, revivalArtifact)], scan([revivalPath]));
    const original = db.prepare('SELECT id FROM proposals WHERE workspace_id=? AND path=?').get(ws, revivalPath) as any;
    db.prepare('UPDATE proposals SET deleted_at=? WHERE workspace_id=? AND path=?').run(123, ws, revivalPath);
    ingestProposalBatch(db, ws, [file(revivalPath, revivalArtifact)], scan([revivalPath]));
    const revivedByPath = db.prepare('SELECT id,artifact_id,deleted_at FROM proposals WHERE workspace_id=? AND path=?').get(ws, revivalPath) as any;
    const revivedByArtifact = db.prepare('SELECT id,artifact_id,deleted_at FROM proposals WHERE workspace_id=? AND artifact_id=?').get(ws, revivalArtifact) as any;
    assert.equal(revivedByPath.deleted_at, null);
    assert.equal(revivedByPath.id, original.id);
    assert.deepEqual(revivedByArtifact, revivedByPath);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM proposals WHERE workspace_id=? AND path=?').get(ws, revivalPath) as any).n, 1);

    const snapshot = JSON.stringify(db.prepare('SELECT path,artifact_id,title,author_agent_id,updated_at FROM proposals WHERE workspace_id=? ORDER BY path').all(ws));
    ingestProposalBatch(db, ws, [file('z.md', 'ax'), file('a.md', 'ax')], scan(['z.md', 'a.md']));
    assert.equal(JSON.stringify(db.prepare('SELECT path,artifact_id,title,author_agent_id,updated_at FROM proposals WHERE workspace_id=? ORDER BY path').all(ws)), snapshot);

    const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-ingest-scan-'));
    try {
      const proposalRoot = path.join(scanRoot, '.lares', 'proposals');
      fs.mkdirSync(proposalRoot, { recursive: true });
      fs.writeFileSync(path.join(proposalRoot, 'linked.md'), '---\nartifact_id: prop_1234abcd\npromoted_to: 2026-08-14-folder-slug\ntitle: Linked\n---\nBody\n');
      const workspace = { id: 'ws-scan-link', title: 'scan', path: scanRoot, pathType: 'windows', description: '', defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: null } as any;
      const { runProposalScan } = require('./proposal-scan') as typeof import('./proposal-scan');
      runProposalScan(workspace, { db, now: () => 700 });
      const proposalPath = '.lares/proposals/linked.md';
      assert.equal((db.prepare('SELECT promoted_to_plan_id FROM proposals WHERE workspace_id=? AND path=?').get(workspace.id, proposalPath) as any).promoted_to_plan_id, null);

      const reconciledPlanId = '12345678-1234-4abc-8def-1234567890ab';
      db.prepare('UPDATE proposals SET promoted_to_plan_id=? WHERE workspace_id=? AND path=?').run(reconciledPlanId, workspace.id, proposalPath);
      runProposalScan(workspace, { db, now: () => 800 });
      assert.equal((db.prepare('SELECT promoted_to_plan_id FROM proposals WHERE workspace_id=? AND path=?').get(workspace.id, proposalPath) as any).promoted_to_plan_id, reconciledPlanId);
    } finally {
      fs.rmSync(scanRoot, { recursive: true, force: true });
    }

    const canonicalPlanId = '12345678-1234-4abc-8def-1234567890ab';
    assert.equal(PLAN_ROW_ID_RE.test(canonicalPlanId), true);
    assert.equal(isCanonicalPlanRowId(canonicalPlanId), true);
    assert.equal(isCanonicalPlanRowId('2026-08-14-folder-slug'), false);
    assert.equal(isCanonicalPlanRowId(canonicalPlanId.toUpperCase()), false);
    assert.equal(isCanonicalPlanRowId(canonicalPlanId.slice(0, -1)), false);
    console.log('proposal-ingest.test: 8 passed');
  } finally { dbm.closeDatabaseForTests(); try { fs.rmSync(appData, { recursive: true, force: true }); } catch { /* best effort */ } }
})().catch((error) => { console.error(error); process.exitCode = 1; });
