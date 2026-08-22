// Save-card SC-WP-2A — immutable turn plan-stamp schema + accessor contract.
//
//   npm run build:main
//   node dist/main/main/database.turnStamp.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

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

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    const statement = sql.trim().startsWith('PRAGMA') ? sql : `PRAGMA ${sql}`;
    if (statement.includes('=')) {
      this.db.exec(statement);
      return [];
    }
    const stmt = this.db.prepare(statement);
    try {
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      if (options?.simple) return rows.length > 0 ? Object.values(rows[0])[0] : undefined;
      return rows;
    } finally { stmt.free(); }
  }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
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

type TurnRecord = {
  id: string;
  planId: string | null;
  planItemId: string | null;
  planStampSource: string;
  intentId: string | null;
  intentStampSource: string | null;
};
type DbModule = {
  initDatabase(): void;
  getDb(): {
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined;
      run(...params: unknown[]): unknown;
      all(...params: unknown[]): Record<string, unknown>[];
    };
  };
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  createAgent(input: Record<string, unknown>): { id: string };
  deleteAgent(id: string): void;
  allocateAndInsertTurn(workspaceId: string, fields?: Record<string, unknown>): TurnRecord;
  getTurnRecord(id: string): TurnRecord | null;
  updateTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null;
  createContinuationHandoffAttempt(agentId: string): { id: string };
  freezeContinuationAttemptBinding(attemptId: string, binding: Record<string, unknown>): Record<string, unknown>;
  getContinuationAttemptBinding(attemptId: string): Record<string, unknown> | null;
  recordCommitLedger(write: Record<string, unknown>): void;
  getCommitRecord(repositoryKey: string, commitOid: string): Record<string, unknown> | null;
  listCommitTurnLinks(repositoryKey: string, commitOid: string): Record<string, unknown>[];
  listCommitPathLinks(repositoryKey: string, paths?: readonly string[]): Record<string, unknown>[];
  createNamedSaveSet(input: Record<string, unknown>): { id: string; title: string };
  listNamedSaveSetMembers(repositoryKey: string): Array<{
    intentId: string; entryId: string; pathBytesBase64: string; inventoryDigest: string; createdAt: number;
  }>;
  insertAttributionResolution(input: Record<string, unknown>): Record<string, unknown>;
  findCurrentAttributionResolution(input: Record<string, unknown>): Record<string, unknown> | null;
};

let dbm: DbModule;
let workspaceSeq = 0;

const OLD_TURN_RECORDS_SCHEMA = `
  CREATE TABLE turn_records (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    turn_seq INTEGER NOT NULL,
    agent_id TEXT, agent_title TEXT,
    owner_agent_id TEXT, owner_brick_generation INTEGER,
    session_id TEXT, task_label TEXT,
    started_at INTEGER, ended_at INTEGER,
    status TEXT NOT NULL DEFAULT 'open',
    before_oid TEXT, after_oid TEXT,
    before_ref TEXT, after_ref TEXT,
    before_ready INTEGER NOT NULL DEFAULT 0,
    after_ready INTEGER NOT NULL DEFAULT 0,
    before_quality TEXT,
    after_quality TEXT,
    before_raw_filter_bypassed INTEGER NOT NULL DEFAULT 0,
    before_filtered_paths TEXT,
    before_pruned_at INTEGER, after_pruned_at INTEGER,
    touched TEXT,
    diff_stats TEXT,
    compact_diff TEXT,
    compact_diff_provenance TEXT,
    failure_reason TEXT,
    plan_id TEXT,
    plan_item_id TEXT,
    plan_stamp_source TEXT NOT NULL DEFAULT 'legacy-unstamped'
      CHECK (plan_stamp_source IN ('legacy-unstamped', 'explicit', 'agent-default',
        'fork-carry', 'revive-carry', 'continuation-carry', 'explicit-none',
        'unbound-manual')),
    intent_id TEXT,
    intent_stamp_source TEXT,
    UNIQUE(workspace_id, turn_seq)
  )`;

function seedOldSchemaFixture(dbPath: string): void {
  const fixture = new FakeBetterSqlite(dbPath);
  fixture.exec(`
    PRAGMA foreign_keys = ON;
    ${OLD_TURN_RECORDS_SCHEMA};
    CREATE TABLE save_intents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      execution_run_id TEXT,
      repository_key TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('task','named-save-set')),
      plan_id TEXT,
      plan_item_id TEXT,
      title TEXT NOT NULL,
      brief_digest TEXT,
      dispatch_attempt_id TEXT UNIQUE,
      created_by TEXT NOT NULL CHECK (created_by IN ('task-dispatch','human-save-card')),
      created_by_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('open','ready','committed','superseded','abandoned')),
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      ready_at INTEGER,
      committed_at INTEGER,
      CHECK (
        (kind='task' AND dispatch_attempt_id IS NOT NULL) OR
        (kind='named-save-set' AND dispatch_attempt_id IS NULL)
      )
    );
    CREATE TABLE attribution_resolutions (
      id TEXT PRIMARY KEY,
      repository_key TEXT NOT NULL,
      path_bytes_base64 TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      earlier_intent_id TEXT NOT NULL REFERENCES save_intents(id),
      later_intent_id TEXT NOT NULL REFERENCES save_intents(id),
      resolution TEXT NOT NULL CHECK (resolution IN
        ('commit-together','superseded-intentionally','restore-lost-work')),
      chosen_by_app_user_id TEXT NOT NULL,
      chosen_at INTEGER NOT NULL,
      superseded_intent_id TEXT REFERENCES save_intents(id),
      restore_turn_id TEXT REFERENCES turn_records(id),
      consumed_by_candidate_id TEXT,
      UNIQUE (repository_key, path_bytes_base64, evidence_digest,
              earlier_intent_id, later_intent_id)
    );
    INSERT INTO turn_records (
      id, workspace_id, turn_seq, agent_id, agent_title, owner_agent_id,
      owner_brick_generation, session_id, task_label, started_at, ended_at,
      status, before_oid, after_oid, before_ref, after_ref, before_ready,
      after_ready, before_quality, after_quality, before_raw_filter_bypassed,
      before_filtered_paths, before_pruned_at, after_pruned_at, touched,
      diff_stats, compact_diff, compact_diff_provenance, failure_reason,
      plan_id, plan_item_id, plan_stamp_source, intent_id, intent_stamp_source
    ) VALUES (
      'old-schema-turn', 'old-schema-workspace', 47, 'agent-old', 'Old Agent',
      'owner-old', 3, 'session-old', 'Old task', 100, 200, 'closed',
      'before-oid', 'after-oid', 'before-ref', 'after-ref', 1, 1,
      'guaranteed', 'hook', 1, '["filtered.txt"]', 300, 400,
      '[{"path":"kept.txt","op":"write"}]', '{"witnessed":{"files":1}}',
      'compact', 'witnessed', NULL, 'plan-old', 'item-old', 'explicit',
      'intent-old', 'task-dispatch'
    );
    INSERT INTO save_intents (
      id, workspace_id, kind, title, dispatch_attempt_id, created_by, state, created_at
    ) VALUES
      ('intent-earlier', 'old-schema-workspace', 'task', 'Earlier', 'dispatch-earlier',
       'task-dispatch', 'open', 1),
      ('intent-later', 'old-schema-workspace', 'task', 'Later', 'dispatch-later',
       'task-dispatch', 'open', 2);
    INSERT INTO attribution_resolutions (
      id, repository_key, path_bytes_base64, evidence_digest,
      earlier_intent_id, later_intent_id, resolution, chosen_by_app_user_id,
      chosen_at, restore_turn_id
    ) VALUES (
      'old-schema-resolution', 'repo-old', 'a2VwdC50eHQ=', 'digest-old',
      'intent-earlier', 'intent-later', 'restore-lost-work', 'human-old', 3,
      'old-schema-turn'
    );
  `);
}

function freshWorkspace(): string {
  workspaceSeq += 1;
  return dbm.createWorkspace({
    title: `turn-stamp-${workspaceSeq}`,
    path: `C:\\tmp\\turn-stamp-${workspaceSeq}`,
    pathType: 'windows',
  }).id;
}

test('schema creates workspace-leading indexes and the immutable trigger', () => {
  const rows = dbm.getDb().prepare(
    `SELECT type, name FROM sqlite_master
     WHERE name IN (?, ?, ?)
     ORDER BY name`,
  ).all(
    'idx_turn_records_ws_plan_seq',
    'idx_turn_records_ws_plan_item_seq',
    'turn_records_plan_stamp_immutable',
  );
  assert.deepEqual(rows, [
    { type: 'index', name: 'idx_turn_records_ws_plan_item_seq' },
    { type: 'index', name: 'idx_turn_records_ws_plan_seq' },
    { type: 'trigger', name: 'turn_records_plan_stamp_immutable' },
  ]);
});

test('WP-1 migration registers save_intents, intent columns, indexes, and immutable triggers', () => {
  const schema = dbm.getDb().prepare(
    `SELECT type, name FROM sqlite_master
      WHERE name IN (?, ?, ?, ?, ?, ?) ORDER BY name`,
  ).all(
    'save_intents', 'idx_save_intents_plan_item', 'idx_save_intents_run_state',
    'turn_records_intent_stamp_immutable', 'plan_dispatch_attempts_intent_immutable',
    'continuation_attempts_intent_immutable',
  );
  assert.deepEqual(schema, [
    { type: 'trigger', name: 'continuation_attempts_intent_immutable' },
    { type: 'index', name: 'idx_save_intents_plan_item' },
    { type: 'index', name: 'idx_save_intents_run_state' },
    { type: 'trigger', name: 'plan_dispatch_attempts_intent_immutable' },
    { type: 'table', name: 'save_intents' },
    { type: 'trigger', name: 'turn_records_intent_stamp_immutable' },
  ]);
  for (const [table, columns] of [
    ['turn_records', ['intent_id', 'intent_stamp_source']],
    ['plan_dispatch_attempts', ['intent_id']],
    ['continuation_handoff_attempts', ['intent_id']],
  ] as const) {
    const actual = dbm.getDb().prepare(`PRAGMA table_info(${table})`).all()
      .map((row) => row.name);
    for (const column of columns) assert.ok(actual.includes(column), `${table}.${column}`);
  }
});

test('WP-2 migration creates byte-addressed named save-set membership', () => {
  const schema = dbm.getDb().prepare(
    `SELECT type, name FROM sqlite_master
      WHERE name IN (?, ?) ORDER BY name`,
  ).all('named_save_set_members', 'idx_named_save_set_members_digest');
  assert.deepEqual(schema, [
    { type: 'index', name: 'idx_named_save_set_members_digest' },
    { type: 'table', name: 'named_save_set_members' },
  ]);
  const ws = freshWorkspace();
  const created = dbm.createNamedSaveSet({
    id: 'named-baseline', workspaceId: ws, repositoryKey: 'repo-named',
    title: 'Baseline 2026-08-09', inventoryDigest: 'digest-a', createdAt: 123,
    members: [
      { entryId: 'entry-a', pathBytesBase64: 'YS50cw==' },
      { entryId: 'entry-b', pathBytesBase64: 'Yi50cw==' },
    ],
  });
  assert.equal(created.id, 'named-baseline');
  assert.deepEqual(dbm.listNamedSaveSetMembers('repo-named'), [
    { intentId: 'named-baseline', entryId: 'entry-a', pathBytesBase64: 'YS50cw==', inventoryDigest: 'digest-a', createdAt: 123 },
    { intentId: 'named-baseline', entryId: 'entry-b', pathBytesBase64: 'Yi50cw==', inventoryDigest: 'digest-a', createdAt: 123 },
  ]);
});

test('WP-3 attribution resolutions are evidence-digest bound', () => {
  const schema = dbm.getDb().prepare(
    `SELECT type, name FROM sqlite_master WHERE name IN (?, ?, ?) ORDER BY name`,
  ).all('attribution_resolutions', 'idx_attribution_resolutions_evidence',
    'idx_attribution_resolutions_candidate');
  assert.deepEqual(schema, [
    { type: 'table', name: 'attribution_resolutions' },
    { type: 'index', name: 'idx_attribution_resolutions_candidate' },
    { type: 'index', name: 'idx_attribution_resolutions_evidence' },
  ]);
  const ws = freshWorkspace();
  for (const id of ['intent-resolution-a', 'intent-resolution-b']) {
    dbm.createNamedSaveSet({
      id, workspaceId: ws, repositoryKey: 'repo-resolution', title: id,
      inventoryDigest: 'inventory', createdAt: 10,
      members: [{ entryId: `entry-${id}`, pathBytesBase64: 'YS50cw==' }],
    });
  }
  dbm.insertAttributionResolution({
    id: 'resolution-1', repositoryKey: 'repo-resolution', pathBytesBase64: 'YS50cw==',
    evidenceDigest: 'evidence-before', earlierIntentId: 'intent-resolution-a',
    laterIntentId: 'intent-resolution-b', resolution: 'commit-together',
    chosenByAppUserId: 'human-1', chosenAt: 20, supersededIntentId: null,
    restoreTurnId: null, consumedByCandidateId: null,
  });
  const lookup = {
    repositoryKey: 'repo-resolution', pathBytesBase64: 'YS50cw==',
    earlierIntentId: 'intent-resolution-a', laterIntentId: 'intent-resolution-b',
  };
  assert.equal(dbm.findCurrentAttributionResolution({
    ...lookup, evidenceDigest: 'evidence-before',
  })?.id, 'resolution-1');
  assert.equal(dbm.findCurrentAttributionResolution({
    ...lookup, evidenceDigest: 'evidence-after-byte-or-witness-change',
  }), null);
});

test('turn allocation writes an immutable intent stamp and raw mutation is rejected', () => {
  const ws = freshWorkspace();
  const turn = dbm.allocateAndInsertTurn(ws, {
    id: 'intent-stamped-turn',
    intentId: 'svi_original',
    intentStampSource: 'task-dispatch',
  });
  assert.deepEqual(
    { intentId: turn.intentId, intentStampSource: turn.intentStampSource },
    { intentId: 'svi_original', intentStampSource: 'task-dispatch' },
  );
  assert.throws(
    () => dbm.getDb().prepare(
      'UPDATE turn_records SET intent_id = ? WHERE id = ?',
    ).run('svi_forged', turn.id),
    /turn intent stamp is immutable/,
  );
  assert.equal(dbm.getTurnRecord(turn.id)?.intentId, 'svi_original');
});

test('continuation freeze carries the latest immutable turn intent and retries cannot replace it', () => {
  const ws = freshWorkspace();
  const agent = dbm.createAgent({
    workspaceId: ws, title: 'continuation-intent', roleDescription: '',
    workingDirectory: 'C:\\tmp', command: 'claude', provider: 'claude',
    tmuxSessionName: null, autoRestartEnabled: false, logPath: 'C:\\tmp\\intent.log',
  });
  dbm.allocateAndInsertTurn(ws, {
    id: 'continuation-source-turn', agentId: agent.id, planId: 'plan-intent',
    planItemId: 'item-intent', planStampSource: 'explicit',
    intentId: 'svi_continuation', intentStampSource: 'task-dispatch',
  });
  const attempt = dbm.createContinuationHandoffAttempt(agent.id);
  const first = dbm.freezeContinuationAttemptBinding(attempt.id, {
    planId: 'plan-intent', planItemId: null, source: 'continuation-carry',
  });
  assert.deepEqual((first as { intentStamp?: unknown }).intentStamp, {
    intentId: 'svi_continuation', kind: 'task', executionRunId: null,
    planId: 'plan-intent', planItemId: null, source: 'continuation-carry',
  });

  dbm.allocateAndInsertTurn(ws, {
    id: 'later-unrelated-turn', agentId: agent.id, planStampSource: 'explicit-none',
    intentId: 'svi_other', intentStampSource: 'task-dispatch',
  });
  const retry = dbm.freezeContinuationAttemptBinding(attempt.id, {
    planId: null, planItemId: null, source: 'continuation-carry',
  });
  assert.equal(
    ((retry as { intentStamp?: { intentId: string } }).intentStamp)?.intentId,
    'svi_continuation',
  );
  assert.deepEqual(dbm.getContinuationAttemptBinding(attempt.id), retry,
    'restart rehydrates only the attempt-frozen carry');
});

test('commit protection ledger schema and CRUD round-trip exact evidence atomically', () => {
  const commitOid = 'a'.repeat(40);
  const encoded = Buffer.from('filtered.txt').toString('base64');
  dbm.recordCommitLedger({
    record: {
      repositoryKey: 'repo-ledger', commitOid, parentOid: null, observedAt: 100,
      source: 'lares', pushedRemoteCount: 1, lastReconciledAt: 110,
    },
    turnLinks: [{
      repositoryKey: 'repo-ledger', commitOid, turnId: 'turn-ledger',
      planId: 'plan-ledger', planItemId: null, relation: 'exact_path_match',
      captureQuality: 'hook',
    }],
    pathLinks: [{
      repositoryKey: 'repo-ledger', commitOid, pathBytesBase64: encoded,
      expectedState: 'present', rawBlobOidAtCommit: 'b'.repeat(40),
      commitBlobOid: 'c'.repeat(40), commitMode: '100644',
      contributingTurnIds: ['turn-ledger'], overlapCount: 1,
    }],
  });
  assert.deepEqual(dbm.getCommitRecord('repo-ledger', commitOid), {
    repositoryKey: 'repo-ledger', commitOid, parentOid: null, observedAt: 100,
    source: 'lares', pushedRemoteCount: 1, lastReconciledAt: 110,
  });
  assert.equal(dbm.listCommitTurnLinks('repo-ledger', commitOid)[0].relation, 'exact_path_match');
  assert.deepEqual(dbm.listCommitPathLinks('repo-ledger', [encoded])[0].contributingTurnIds, ['turn-ledger']);
  assert.deepEqual(dbm.listCommitPathLinks('repo-ledger', []), []);
});

test('mapper returns explicit stamps and allocations never write legacy-unstamped', () => {
  const ws = freshWorkspace();
  const explicit = dbm.allocateAndInsertTurn(ws, {
    id: 'stamped-explicit',
    planId: 'plan-1',
    planStampSource: 'explicit',
  });
  assert.deepEqual(
    {
      planId: explicit.planId,
      planItemId: explicit.planItemId,
      planStampSource: explicit.planStampSource,
    },
    { planId: 'plan-1', planItemId: null, planStampSource: 'explicit' },
  );

  const compatibilityAllocation = dbm.allocateAndInsertTurn(ws, { id: 'stamped-default' });
  assert.equal(compatibilityAllocation.planStampSource, 'agent-default');
  assert.notEqual(compatibilityAllocation.planStampSource, 'legacy-unstamped');
});

test('fresh database accepts owner-focus and still rejects a bogus stamp source', () => {
  const ws = freshWorkspace();
  const ownerFocused = dbm.allocateAndInsertTurn(ws, {
    id: 'stamped-owner-focus',
    planId: 'plan-owner',
    planStampSource: 'owner-focus',
  });
  assert.deepEqual(
    {
      planId: ownerFocused.planId,
      planItemId: ownerFocused.planItemId,
      planStampSource: ownerFocused.planStampSource,
    },
    { planId: 'plan-owner', planItemId: null, planStampSource: 'owner-focus' },
  );

  assert.throws(
    () => dbm.allocateAndInsertTurn(ws, {
      id: 'bad-bogus-source',
      planStampSource: 'bogus-source',
    }),
    /invalid turn plan stamp source/,
  );
  assert.equal(dbm.getTurnRecord('bad-bogus-source'), null);
});

test('old-schema database rebuild preserves rows, indexes, triggers, and restore FK', () => {
  const freshAppData = process.env.APPDATA;
  assert.ok(freshAppData);
  const fixtureAppData = path.join(freshAppData, 'old-schema-fixture');
  seedOldSchemaFixture(path.join(fixtureAppData, 'AgentDashboard', 'dashboard.db'));
  process.env.APPDATA = fixtureAppData;
  try {
    dbm.initDatabase();
    const raw = dbm.getDb();
    const preserved = raw.prepare(
      `SELECT id, turn_seq, plan_id, plan_item_id, plan_stamp_source,
              intent_id, intent_stamp_source, before_filtered_paths, touched
         FROM turn_records WHERE id = ?`,
    ).get('old-schema-turn');
    assert.deepEqual(preserved, {
      id: 'old-schema-turn',
      turn_seq: 47,
      plan_id: 'plan-old',
      plan_item_id: 'item-old',
      plan_stamp_source: 'explicit',
      intent_id: 'intent-old',
      intent_stamp_source: 'task-dispatch',
      before_filtered_paths: '["filtered.txt"]',
      touched: '[{"path":"kept.txt","op":"write"}]',
    });

    raw.prepare(
      `INSERT INTO turn_records (id, workspace_id, turn_seq, plan_id, plan_stamp_source)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('old-schema-owner-focus', 'old-schema-workspace', 48, 'plan-owner', 'owner-focus');
    assert.throws(
      () => raw.prepare(
        `INSERT INTO turn_records (id, workspace_id, turn_seq, plan_stamp_source)
         VALUES (?, ?, ?, ?)`,
      ).run('old-schema-bogus', 'old-schema-workspace', 49, 'bogus-source'),
      /CHECK constraint failed/,
    );

    const schemaObjects = raw.prepare(
      `SELECT type, name FROM sqlite_master
        WHERE name IN (?, ?, ?, ?, ?, ?, ?) ORDER BY name`,
    ).all(
      'idx_turn_records_ws_seq',
      'idx_turn_records_agent',
      'idx_turn_records_ws_agent_started',
      'idx_turn_records_ws_plan_seq',
      'idx_turn_records_ws_plan_item_seq',
      'turn_records_plan_stamp_immutable',
      'turn_records_intent_stamp_immutable',
    );
    assert.deepEqual(schemaObjects, [
      { type: 'index', name: 'idx_turn_records_agent' },
      { type: 'index', name: 'idx_turn_records_ws_agent_started' },
      { type: 'index', name: 'idx_turn_records_ws_plan_item_seq' },
      { type: 'index', name: 'idx_turn_records_ws_plan_seq' },
      { type: 'index', name: 'idx_turn_records_ws_seq' },
      { type: 'trigger', name: 'turn_records_intent_stamp_immutable' },
      { type: 'trigger', name: 'turn_records_plan_stamp_immutable' },
    ]);
    assert.throws(
      () => raw.prepare('UPDATE turn_records SET plan_id = ? WHERE id = ?')
        .run('plan-forged', 'old-schema-turn'),
      /turn plan stamp is immutable/,
    );
    assert.throws(
      () => raw.prepare('UPDATE turn_records SET intent_id = ? WHERE id = ?')
        .run('intent-forged', 'old-schema-turn'),
      /turn intent stamp is immutable/,
    );
    assert.deepEqual(
      raw.prepare(
        `SELECT ar.restore_turn_id, tr.id AS parent_id
           FROM attribution_resolutions ar
           JOIN turn_records tr ON tr.id = ar.restore_turn_id
          WHERE ar.id = ?`,
      ).get('old-schema-resolution'),
      { restore_turn_id: 'old-schema-turn', parent_id: 'old-schema-turn' },
    );
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);

    const beforeSchema = raw.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turn_records'`,
    ).get();
    const beforeRows = raw.prepare('SELECT COUNT(*) AS count FROM turn_records').get();
    dbm.initDatabase();
    const afterSchema = dbm.getDb().prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turn_records'`,
    ).get();
    const afterRows = dbm.getDb().prepare('SELECT COUNT(*) AS count FROM turn_records').get();
    assert.deepEqual(afterSchema, beforeSchema);
    assert.deepEqual(afterRows, beforeRows);
    assert.deepEqual(dbm.getDb().prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    process.env.APPDATA = freshAppData;
    dbm.initDatabase();
  }
});

test('legacy rows read legacy-unstamped through the mapper', () => {
  const ws = freshWorkspace();
  dbm.getDb().prepare(
    `INSERT INTO turn_records (id, workspace_id, turn_seq, status)
     VALUES (?, ?, ?, 'open')`,
  ).run('legacy-row', ws, 1);
  const legacy = dbm.getTurnRecord('legacy-row');
  assert.equal(legacy?.planId, null);
  assert.equal(legacy?.planItemId, null);
  assert.equal(legacy?.planStampSource, 'legacy-unstamped');
});

test('allocation enum validation rejects legacy and unknown sources without a row', () => {
  const ws = freshWorkspace();
  for (const source of ['legacy-unstamped', 'forged-source']) {
    assert.throws(
      () => dbm.allocateAndInsertTurn(ws, { id: `bad-${source}`, planStampSource: source }),
      /invalid turn plan stamp source/,
    );
    assert.equal(dbm.getTurnRecord(`bad-${source}`), null);
  }
});

test('SC-WP-3A: a resolved plan_item_id is stored now that plan_work_packages exists', () => {
  const ws = freshWorkspace();
  const stamped = dbm.allocateAndInsertTurn(ws, {
    id: 'stamped-item',
    planId: 'plan-1',
    planItemId: 'item-1',
    planStampSource: 'explicit',
  });
  assert.deepEqual(
    { planId: stamped.planId, planItemId: stamped.planItemId, planStampSource: stamped.planStampSource },
    { planId: 'plan-1', planItemId: 'item-1', planStampSource: 'explicit' },
  );
  assert.deepEqual(
    { planId: dbm.getTurnRecord('stamped-item')?.planId, planItemId: dbm.getTurnRecord('stamped-item')?.planItemId },
    { planId: 'plan-1', planItemId: 'item-1' },
  );
});

test('an item stamp without a plan is incoherent and is rejected with no row', () => {
  const ws = freshWorkspace();
  assert.throws(
    () => dbm.allocateAndInsertTurn(ws, {
      id: 'orphan-item',
      planItemId: 'item-1',
      planStampSource: 'explicit',
    }),
    /plan_item_id requires a plan_id/,
  );
  assert.equal(dbm.getTurnRecord('orphan-item'), null);
});

test('update accessor cannot mutate any stamp column', () => {
  const ws = freshWorkspace();
  const turn = dbm.allocateAndInsertTurn(ws, {
    id: 'accessor-immutable',
    planId: 'plan-original',
    planStampSource: 'explicit',
  });
  const after = dbm.updateTurnRecord(turn.id, {
    planId: 'plan-mutated',
    planItemId: 'item-mutated',
    planStampSource: 'revive-carry',
  });
  assert.deepEqual(
    { planId: after?.planId, planItemId: after?.planItemId, planStampSource: after?.planStampSource },
    { planId: 'plan-original', planItemId: null, planStampSource: 'explicit' },
  );
});

test('database trigger blocks raw mutation of every stamp column', () => {
  const ws = freshWorkspace();
  const turn = dbm.allocateAndInsertTurn(ws, {
    id: 'trigger-immutable',
    planId: 'plan-original',
    planStampSource: 'explicit',
  });
  const raw = dbm.getDb();
  for (const [column, value] of [
    ['plan_id', 'plan-mutated'],
    ['plan_item_id', 'item-mutated'],
    ['plan_stamp_source', 'revive-carry'],
  ]) {
    assert.throws(
      () => raw.prepare(`UPDATE turn_records SET ${column} = ? WHERE id = ?`).run(value, turn.id),
      /turn plan stamp is immutable/,
    );
  }
  assert.deepEqual(
    dbm.getTurnRecord(turn.id),
    turn,
    'failed raw updates leave the entire mapped turn unchanged',
  );
});

test('deleting an agent preserves its frozen turn stamps', () => {
  const ws = freshWorkspace();
  const agent = dbm.createAgent({
    workspaceId: ws,
    title: 'stamp-owner',
    roleDescription: '',
    workingDirectory: 'C:\\tmp',
    command: 'claude',
    provider: 'claude',
    tmuxSessionName: null,
    autoRestartEnabled: false,
    logPath: 'C:\\tmp\\stamp-owner.log',
  });
  const turn = dbm.allocateAndInsertTurn(ws, {
    id: 'deleted-agent-stamp',
    agentId: agent.id,
    planId: 'plan-survives',
    planStampSource: 'agent-default',
  });

  dbm.deleteAgent(agent.id);
  const preserved = dbm.getTurnRecord(turn.id);
  assert.equal(preserved?.planId, 'plan-survives');
  assert.equal(preserved?.planStampSource, 'agent-default');
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-stamp-'));
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

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }

  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
