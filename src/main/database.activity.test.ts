// While-you-were-away WP-P1 — activity database paging and bookkeeping.
//
//   npm run build:main
//   node dist/main/main/database.activity.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

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
  static stores = new Map<string, SqlJsDatabase>();
  static queryLog: string[] = [];
  private db: SqlJsDatabase;
  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new sqlJsCtor();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
    this.db = store;
  }
  pragma(_s: string): unknown { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    FakeBetterSqlite.queryLog.push(sql);
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          return stmt.step() ? stmt.getAsObject() : undefined;
        } finally { stmt.free(); }
      },
      all: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally { stmt.free(); }
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
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
  }
}

interface TurnRecord { id: string; turnSeq: number; planId?: string | null; planItemId?: string | null; }
interface ActivitySnapshot { throughTurnSeq: number; throughFileActivityId: number; capturedAt: number; }
interface SourcePage<T> { rows: T[]; before: number | null; exhausted: boolean; scanned: number; }
interface ActivityFa { id: number; enclosed: boolean; agentId: string; }
interface CaptureAttempt { id: string; status: string; reason: string | null; openedAt: number | null; beforeResult: string; }
type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  allocateAndInsertTurn(workspaceId: string, fields: Record<string, unknown>): TurnRecord;
  updateTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null;
  listTurnRecords(workspaceId: string, opts?: Record<string, unknown>): TurnRecord[];
  snapshotActivityBounds(workspaceId: string, now?: () => number): ActivitySnapshot;
  listActivityTurnRecordsThrough(workspaceId: string, opts: Record<string, unknown>): SourcePage<TurnRecord>;
  listWorkspaceWriteActivitiesThrough(workspaceId: string, opts: Record<string, unknown>): SourcePage<ActivityFa>;
  getWorkspaceActivityView(workspaceId: string): { turnSeq: number; fileActivityId: number; viewedAt: number | null } | null;
  markWorkspaceActivityViewed(workspaceId: string, snapshot: ActivitySnapshot, viewedAt?: number): unknown;
  upsertCommitTurnLink(link: Record<string, unknown>): void;
  listCommitLinksForTurns(repositoryKey: string, turnIds: readonly string[]): { turnId: string; commitOid: string }[];
  insertCaptureAttempt(input: Record<string, unknown>): CaptureAttempt;
  updateCaptureAttempt(id: string, updates: Record<string, unknown>): CaptureAttempt | null;
  listCaptureAttempts(workspaceId: string): CaptureAttempt[];
  reconcileCaptureAttempts(workspaceId?: string, at?: number): number;
};

let dbm: DbModule;
let raw: SqlJsDatabase;
let workspaceSeq = 0;
let agentSeq = 0;

function runSql(sql: string, params: unknown[] = []): void { raw.run(sql, params); }
function allSql(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const stmt = raw.prepare(sql);
  try {
    stmt.bind(params);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally { stmt.free(); }
}

function freshWorkspace(): { workspaceId: string; agentId: string } {
  const workspaceId = dbm.createWorkspace({
    title: `activity-${++workspaceSeq}`,
    path: `C:\\activity\\${workspaceSeq}`,
    pathType: 'windows',
  }).id;
  const agentId = `activity-agent-${++agentSeq}`;
  runSql(
    `INSERT INTO agents (id, workspace_id, title, slug, working_directory, command)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [agentId, workspaceId, agentId, agentId, `C:\\activity\\${workspaceSeq}`, 'codex'],
  );
  return { workspaceId, agentId };
}

function seedTurn(
  workspaceId: string,
  agentId: string,
  startedAt: number,
  touched: { path: string; op: string }[] | null,
  extra: Record<string, unknown> = {},
): TurnRecord {
  const turn = dbm.allocateAndInsertTurn(workspaceId, { agentId, startedAt, ...extra });
  if (touched !== null) dbm.updateTurnRecord(turn.id, { touched });
  return turn;
}

function seedFa(agentId: string, id: number, timestamp: string, sessionId: string | null = null): void {
  runSql(
    `INSERT INTO file_activities (id, agent_id, file_path, operation, timestamp, generation, session_id)
     VALUES (?, ?, ?, 'write', ?, 0, ?)`,
    [id, agentId, `C:\\activity\\file-${id}.txt`, timestamp, sessionId],
  );
}

test('T5: file-only activity advances only the file-activity last-viewed cursor', () => {
  const { workspaceId, agentId } = freshWorkspace();
  const empty = dbm.snapshotActivityBounds(workspaceId, () => 1000);
  dbm.markWorkspaceActivityViewed(workspaceId, empty, 1000);
  seedFa(agentId, 10_001, '2026-08-14 10:00:00');
  const snapshot = dbm.snapshotActivityBounds(workspaceId, () => 2000);
  assert.equal(snapshot.throughTurnSeq, empty.throughTurnSeq, 'no new turn');
  assert.ok(snapshot.throughFileActivityId > empty.throughFileActivityId, 'new FA is visible');
  const page = dbm.listWorkspaceWriteActivitiesThrough(workspaceId, {
    throughFileActivityId: snapshot.throughFileActivityId,
    throughTurnSeq: snapshot.throughTurnSeq,
    snapshotCapturedAt: snapshot.capturedAt,
    before: null,
    limit: 10,
  });
  assert.deepEqual(page.rows.map((row) => row.id), [10_001]);
  assert.equal(page.rows[0].enclosed, false);
  dbm.markWorkspaceActivityViewed(workspaceId, snapshot, 2001);
  assert.deepEqual(dbm.getWorkspaceActivityView(workspaceId), {
    turnSeq: empty.throughTurnSeq,
    fileActivityId: 10_001,
    viewedAt: 2001,
  });
});

test('T5b: enclosed lookahead advances the independent FA cursor without emission', () => {
  const { workspaceId, agentId } = freshWorkspace();
  seedFa(agentId, 20_001, '2026-08-14 10:00:01');
  seedFa(agentId, 20_002, '2026-08-14 10:00:02');
  const turn = seedTurn(workspaceId, agentId, Date.parse('2026-08-14T10:00:00Z'), null);
  dbm.updateTurnRecord(turn.id, { endedAt: Date.parse('2026-08-14T10:00:03Z'), status: 'accepted' });
  const snapshot = dbm.snapshotActivityBounds(workspaceId, () => Date.parse('2026-08-14T10:00:04Z'));
  const first = dbm.listWorkspaceWriteActivitiesThrough(workspaceId, {
    throughFileActivityId: snapshot.throughFileActivityId,
    throughTurnSeq: snapshot.throughTurnSeq,
    snapshotCapturedAt: snapshot.capturedAt,
    before: null,
    limit: 1,
  });
  assert.deepEqual(first.rows.map((row) => row.id), [20_002]);
  assert.equal(first.rows[0].enclosed, true, 'enclosed page row is not an emitted tool-unjoined candidate');
  assert.equal(first.before, 20_002, 'before comes from the page row, not lookahead');
  assert.equal(first.exhausted, false, 'REACHABILITY:activity-lookahead');
  const second = dbm.listWorkspaceWriteActivitiesThrough(workspaceId, {
    throughFileActivityId: snapshot.throughFileActivityId,
    throughTurnSeq: snapshot.throughTurnSeq,
    snapshotCapturedAt: snapshot.capturedAt,
    before: first.before,
    limit: 1,
  });
  assert.deepEqual(second.rows.map((row) => row.id), [20_001]);
  assert.equal(second.rows[0].enclosed, true);
  assert.equal(second.before, 20_001);
  assert.equal(second.exhausted, true);
});

test('T5c: an older page reuses its ceilings and a fresh snapshot sees concurrent inserts', () => {
  const { workspaceId, agentId } = freshWorkspace();
  seedTurn(workspaceId, agentId, 1, [{ path: 'old.ts', op: 'write' }]);
  seedFa(agentId, 30_001, '2026-08-14 11:00:00');
  const oldSnapshot = dbm.snapshotActivityBounds(workspaceId, () => Date.parse('2026-08-14T11:00:01Z'));
  seedTurn(workspaceId, agentId, 2, [{ path: 'new.ts', op: 'write' }]);
  seedFa(agentId, 30_002, '2026-08-14 11:00:02');
  const oldTurns = dbm.listActivityTurnRecordsThrough(workspaceId, {
    throughTurnSeq: oldSnapshot.throughTurnSeq, before: null, limit: 10,
  });
  const oldFas = dbm.listWorkspaceWriteActivitiesThrough(workspaceId, {
    throughFileActivityId: oldSnapshot.throughFileActivityId,
    throughTurnSeq: oldSnapshot.throughTurnSeq,
    snapshotCapturedAt: oldSnapshot.capturedAt,
    before: null,
    limit: 10,
  });
  assert.equal(oldTurns.rows.length, 1);
  assert.deepEqual(oldFas.rows.map((row) => row.id), [30_001]);
  const fresh = dbm.snapshotActivityBounds(workspaceId, () => Date.parse('2026-08-14T11:00:03Z'));
  assert.ok(fresh.throughTurnSeq > oldSnapshot.throughTurnSeq);
  assert.ok(fresh.throughFileActivityId > oldSnapshot.throughFileActivityId);
});

test('T5d/T5e: sources exhaust independently and exact-limit pages are exhausted', () => {
  const { workspaceId, agentId } = freshWorkspace();
  seedTurn(workspaceId, agentId, 1, [{ path: 'one.ts', op: 'write' }]);
  seedFa(agentId, 40_001, '2026-08-14 12:00:01');
  seedFa(agentId, 40_002, '2026-08-14 12:00:02');
  const snapshot = dbm.snapshotActivityBounds(workspaceId, () => Date.parse('2026-08-14T12:00:03Z'));
  const turns = dbm.listActivityTurnRecordsThrough(workspaceId, {
    throughTurnSeq: snapshot.throughTurnSeq, before: null, limit: 1,
  });
  const fas = dbm.listWorkspaceWriteActivitiesThrough(workspaceId, {
    throughFileActivityId: snapshot.throughFileActivityId,
    throughTurnSeq: snapshot.throughTurnSeq,
    snapshotCapturedAt: snapshot.capturedAt,
    before: null,
    limit: 1,
  });
  assert.equal(turns.exhausted, true, 'exactly turn limit means exhausted');
  assert.equal(fas.exhausted, false);
  const skippedTurns = dbm.listActivityTurnRecordsThrough(workspaceId, {
    throughTurnSeq: snapshot.throughTurnSeq, before: turns.before, exhausted: true, limit: 1,
  });
  assert.deepEqual(skippedTurns.rows, [], 'an exhausted source is not queried/re-emitted');
  const lastFa = dbm.listWorkspaceWriteActivitiesThrough(workspaceId, {
    throughFileActivityId: snapshot.throughFileActivityId,
    throughTurnSeq: snapshot.throughTurnSeq,
    snapshotCapturedAt: snapshot.capturedAt,
    before: fas.before,
    limit: 1,
  });
  assert.equal(lastFa.exhausted, true, 'the remaining exact-limit FA page is exhausted');
});

test('P7: a turn inserted after the snapshot cannot retroactively enclose FA', () => {
  const { workspaceId, agentId } = freshWorkspace();
  seedFa(agentId, 50_001, '2026-08-14 13:00:01');
  const snapshot = dbm.snapshotActivityBounds(workspaceId, () => Date.parse('2026-08-14T13:00:02Z'));
  const turn = seedTurn(workspaceId, agentId, Date.parse('2026-08-14T13:00:00Z'), null);
  dbm.updateTurnRecord(turn.id, { endedAt: Date.parse('2026-08-14T13:00:03Z'), status: 'accepted' });
  const page = dbm.listWorkspaceWriteActivitiesThrough(workspaceId, {
    throughFileActivityId: snapshot.throughFileActivityId,
    throughTurnSeq: snapshot.throughTurnSeq,
    snapshotCapturedAt: snapshot.capturedAt,
    before: null,
    limit: 10,
  });
  assert.equal(page.rows[0].enclosed, false);
});

test('T12: eligibleOnly is applied before LIMIT', () => {
  const { workspaceId, agentId } = freshWorkspace();
  const write = seedTurn(workspaceId, agentId, 1, [{ path: 'write.ts', op: 'write' }]);
  dbm.updateTurnRecord(write.id, { status: 'accepted', endedAt: 2 });
  for (let i = 0; i < 50; i++) {
    const quiet = seedTurn(workspaceId, agentId, 10 + i, null);
    dbm.updateTurnRecord(quiet.id, { status: 'accepted', endedAt: 100 + i });
  }
  assert.deepEqual(dbm.listTurnRecords(workspaceId, { eligibleOnly: true, limit: 1 }).map((row) => row.id), [write.id]);
});

test('T15: reverse commit lookup returns a page in one query', () => {
  const { workspaceId, agentId } = freshWorkspace();
  const a = seedTurn(workspaceId, agentId, 1, [{ path: 'a', op: 'write' }]);
  const b = seedTurn(workspaceId, agentId, 2, [{ path: 'b', op: 'write' }]);
  for (const [commitOid, turnId] of [['c1', a.id], ['c2', b.id], ['c3', b.id]]) {
    dbm.upsertCommitTurnLink({
      repositoryKey: 'repo', commitOid, turnId, planId: null, planItemId: null,
      relation: 'candidate_member', captureQuality: null,
    });
  }
  FakeBetterSqlite.queryLog = [];
  const links = dbm.listCommitLinksForTurns('repo', [a.id, b.id]);
  assert.equal(links.length, 3);
  const reverseQueries = FakeBetterSqlite.queryLog.filter((sql) => /FROM commit_turn_links[\s\S]*turn_id IN/.test(sql));
  assert.equal(reverseQueries.length, 1, 'one reverse lookup query for the whole page');
});

test('T16: planId and planItemId filters compose', () => {
  const { workspaceId, agentId } = freshWorkspace();
  seedTurn(workspaceId, agentId, 1, [{ path: 'a', op: 'write' }], {
    planId: 'plan-a', planItemId: 'wp-a', planStampSource: 'explicit',
  });
  seedTurn(workspaceId, agentId, 2, [{ path: 'b', op: 'write' }], {
    planId: 'plan-a', planItemId: 'wp-b', planStampSource: 'explicit',
  });
  seedTurn(workspaceId, agentId, 3, [{ path: 'c', op: 'write' }], {
    planId: 'plan-b', planItemId: 'wp-a', planStampSource: 'explicit',
  });
  const rows = dbm.listTurnRecords(workspaceId, { planId: 'plan-a', planItemId: 'wp-a' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].planItemId, 'wp-a');
});

test('H1: restart reconciliation fails pending/opened attempts and retains openedAt', () => {
  const { workspaceId, agentId } = freshWorkspace();
  dbm.insertCaptureAttempt({ id: 'attempt-pending', workspaceId, agentId, createdAt: 1 });
  dbm.insertCaptureAttempt({ id: 'attempt-opened', workspaceId, agentId, createdAt: 2 });
  dbm.updateCaptureAttempt('attempt-opened', {
    status: 'opened', openedAt: 3, beforeResult: 'ready', turnId: 'turn-opened', updatedAt: 3,
  });
  dbm.insertCaptureAttempt({ id: 'attempt-complete', workspaceId, agentId, createdAt: 4 });
  dbm.updateCaptureAttempt('attempt-complete', { status: 'completed', reason: null, updatedAt: 5 });
  assert.equal(dbm.reconcileCaptureAttempts(workspaceId, 10), 2);
  const byId = new Map(dbm.listCaptureAttempts(workspaceId).map((attempt) => [attempt.id, attempt]));
  assert.equal(byId.get('attempt-pending')?.status, 'failed');
  assert.equal(byId.get('attempt-pending')?.reason, 'process-restart');
  assert.equal(byId.get('attempt-opened')?.status, 'failed');
  assert.equal(byId.get('attempt-opened')?.openedAt, 3);
  assert.equal(byId.get('attempt-opened')?.beforeResult, 'ready');
  assert.equal(byId.get('attempt-complete')?.status, 'completed');
});

test('schema carries the enclosure/reverse indexes and activity/attempt columns', () => {
  const turnIndexes = allSql(`PRAGMA index_list('turn_records')`).map((row) => row.name);
  const commitIndexes = allSql(`PRAGMA index_list('commit_turn_links')`).map((row) => row.name);
  const workspaceColumns = allSql(`PRAGMA table_info('workspaces')`).map((row) => row.name);
  const attemptColumns = allSql(`PRAGMA table_info('capture_attempts')`).map((row) => row.name);
  assert.ok(turnIndexes.includes('idx_turn_records_ws_agent_started'));
  assert.ok(commitIndexes.includes('idx_commit_turn_links_repo_turn'));
  assert.ok(workspaceColumns.includes('activity_last_viewed_seq'));
  assert.ok(workspaceColumns.includes('activity_last_viewed_file_activity_id'));
  assert.ok(workspaceColumns.includes('activity_last_viewed_at'));
  assert.ok(attemptColumns.includes('opened_at'));
  assert.ok(attemptColumns.includes('before_result'));
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-db-'));
  process.env.APPDATA = tmpAppData;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
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

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('./database') as DbModule;
  dbm.initDatabase();
  raw = Array.from(FakeBetterSqlite.stores.values())[0];

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
