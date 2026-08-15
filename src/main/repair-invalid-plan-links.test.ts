import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): {
    bind(params: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  };
};

let sqlJsCtor: new () => SqlJsDatabase;

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;

  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new sqlJsCtor();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
    this.db = store;
  }

  pragma(_sql: string): unknown { return undefined; }
  close(): void { /* Keep the persistent test store for the startup re-open. */ }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => {
        const statement = inner.prepare(sql);
        try {
          statement.bind(params);
          return statement.step() ? statement.getAsObject() : undefined;
        } finally {
          statement.free();
        }
      },
      all: (...params: unknown[]) => {
        const statement = inner.prepare(sql);
        try {
          statement.bind(params);
          const rows: Record<string, unknown>[] = [];
          while (statement.step()) rows.push(statement.getAsObject());
          return rows;
        } finally {
          statement.free();
        }
      },
    };
  }

  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    };
  }
}

function insertProposal(
  database: any,
  id: string,
  promotedToPlanId: string,
  updatedAt: number,
): void {
  database.prepare(`INSERT INTO proposals (
    id, workspace_id, path, state, author_role, created_at, updated_at, promoted_to_plan_id
  ) VALUES (?, 'ws-repair', ?, 'promoted', 'unknown', 1, ?, ?)`)
    .run(id, `.lares/proposals/${id}.md`, updatedAt, promotedToPlanId);
}

function insertPlan(
  database: any,
  id: string,
  artifactId: string,
  folderRelPath: string,
): void {
  database.prepare(`INSERT INTO plans (
    id, workspace_id, path, slug, format, run_state, mtime_ms, size_bytes,
    artifact_id, folder_rel_path
  ) VALUES (?, 'ws-repair', ?, ?, 'structured', 'active', 10, 20, ?, ?)`)
    .run(id, `${folderRelPath}/plan.md`, path.basename(folderRelPath), artifactId, folderRelPath);
}

(async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-invalid-plan-links-'));
  process.env.APPDATA = appData;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  const dbm = require('./database') as typeof import('./database');
  dbm.initDatabase();
  const database: any = dbm.getDb();
  database.prepare(`INSERT INTO workspaces (id, title, path, path_type)
    VALUES ('ws-repair', 'Repair', 'C:/repair', 'windows')`).run();

  const correctPlanId = '11111111-1111-4111-8111-111111111111';
  const conflictingPlanId = '22222222-2222-4222-8222-222222222222';
  const orphanedPlanId = '33333333-3333-4333-8333-333333333333';
  insertPlan(database, correctPlanId, 'plan_11111111', '.lares/plans/correct-11111111');
  insertPlan(database, conflictingPlanId, 'plan_22222222', '.lares/plans/conflict-22222222');
  insertPlan(database, '44444444-4444-4444-8444-444444444444', 'plan_pigt5a83', '.lares/plans/legacy-pigt5a83');

  insertProposal(database, 'prop-folder-slug', 'correct-11111111', 901);
  insertProposal(database, 'prop-correct', correctPlanId, 902);
  insertProposal(database, 'prop-conflict', conflictingPlanId, 903);
  insertProposal(database, 'prop-orphan', orphanedPlanId, 904);

  const staleBefore = database.prepare(`SELECT * FROM plans WHERE artifact_id = 'plan_pigt5a83'`).get();
  const report = dbm.repairInvalidPlanLinks(database);
  assert.deepEqual(report.clearedLinks, [{ id: 'prop-folder-slug', was: 'correct-11111111' }]);
  assert.deepEqual(report.staleNonContractPlans, [{
    id: '44444444-4444-4444-8444-444444444444',
    artifactId: 'plan_pigt5a83',
    folderRelPath: '.lares/plans/legacy-pigt5a83',
  }]);
  assert.equal(database.prepare(`SELECT promoted_to_plan_id FROM proposals WHERE id = 'prop-folder-slug'`).get()!.promoted_to_plan_id, null);
  assert.equal(database.prepare(`SELECT updated_at FROM proposals WHERE id = 'prop-folder-slug'`).get()!.updated_at, 901);
  assert.equal(database.prepare(`SELECT promoted_to_plan_id FROM proposals WHERE id = 'prop-correct'`).get()!.promoted_to_plan_id, correctPlanId);
  assert.equal(database.prepare(`SELECT promoted_to_plan_id FROM proposals WHERE id = 'prop-conflict'`).get()!.promoted_to_plan_id, conflictingPlanId);
  assert.equal(database.prepare(`SELECT promoted_to_plan_id FROM proposals WHERE id = 'prop-orphan'`).get()!.promoted_to_plan_id, orphanedPlanId);
  assert.deepEqual(database.prepare(`SELECT * FROM plans WHERE artifact_id = 'plan_pigt5a83'`).get(), staleBefore);

  insertProposal(database, 'prop-fail-a', 'folder-fail-a', 905);
  insertProposal(database, 'prop-fail-b', 'folder-fail-b', 906);
  database.exec(`CREATE TRIGGER abort_second_invalid_plan_link
    BEFORE UPDATE OF promoted_to_plan_id ON proposals
    WHEN OLD.id = 'prop-fail-b'
    BEGIN SELECT RAISE(ABORT, 'wp2 injected abort'); END`);
  dbm.closeDatabaseForTests();

  // This local sequencing harness proves initDatabase throws before later
  // callbacks in this block; it does not invoke production runProposalScan or
  // startPlansWatcher (their ordering is covered by the src/main/index.ts read).
  let startupError: unknown;
  let proposalScanCalls = 0;
  let watcherEntryCalls = 0;
  try {
    dbm.initDatabase();
    proposalScanCalls += 1;
    watcherEntryCalls += 1;
  } catch (error) {
    startupError = error;
  }
  assert.ok(startupError, 'REACHABILITY:repair-invalid-plan-links must abort startup through initDatabase');
  assert.match(String(startupError), /wp2 injected abort/);
  assert.equal(proposalScanCalls, 0);
  assert.equal(watcherEntryCalls, 0);
  assert.equal(database.prepare(`SELECT promoted_to_plan_id FROM proposals WHERE id = 'prop-fail-a'`).get()!.promoted_to_plan_id, 'folder-fail-a');
  assert.equal(database.prepare(`SELECT promoted_to_plan_id FROM proposals WHERE id = 'prop-fail-b'`).get()!.promoted_to_plan_id, 'folder-fail-b');

  console.log('repair-invalid-plan-links tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
