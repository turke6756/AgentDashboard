// WP-1 plan-reference resolver acceptance tests.
//
//   npx tsc -p tsconfig.main.json
//   node dist/main/main/plans/resolve-plan-ref.test.js

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLAN_REF_ERROR_CODES } from '../../shared/planning-artifact-ids';

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  getRowsModified(): number;
  prepare(sql: string): {
    bind(params: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  };
};

let SqlDatabase: new () => SqlJsDatabase;

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private readonly db: SqlJsDatabase;
  private transactionSerial = 0;

  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new SqlDatabase();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
    this.db = store;
  }

  pragma(_sql: string): undefined { return undefined; }
  close(): void { /* sql.js memory store is released with the test process */ }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const db = this.db;
    return {
      run: (...params: unknown[]) => {
        db.run(sql, params);
        return { changes: db.getRowsModified() };
      },
      get: (...params: unknown[]) => {
        const statement = db.prepare(sql);
        try {
          statement.bind(params);
          return statement.step() ? statement.getAsObject() : undefined;
        } finally {
          statement.free();
        }
      },
      all: (...params: unknown[]) => {
        const statement = db.prepare(sql);
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
      const savepoint = `resolver_test_${++this.transactionSerial}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = fn(...args);
        this.db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${savepoint}`);
        this.db.exec(`RELEASE ${savepoint}`);
        throw error;
      }
    };
  }
}

type DatabaseModule = typeof import('../database');
type ResolverModule = typeof import('./resolve-plan-ref');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-ref-resolver-'));
const priorAppData = process.env.APPDATA;

void (async () => {
  process.env.APPDATA = scratch;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  SqlDatabase = SQL.Database;
  const sqlitePath = require.resolve('better-sqlite3');
  require.cache[sqlitePath] = {
    id: sqlitePath,
    filename: sqlitePath,
    loaded: true,
    exports: FakeBetterSqlite,
  } as unknown as NodeModule;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as DatabaseModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const resolver = require('./resolve-plan-ref') as ResolverModule;
  db.initDatabase();

  let serial = 0;
  function workspace(label: string): string {
    serial += 1;
    return db.createWorkspace({
      title: label,
      path: path.join(scratch, `${label}-${serial}`),
      pathType: 'windows',
    }).id;
  }

  function plan(workspaceId: string, artifactId: string | null, label: string): string {
    serial += 1;
    const created = db.createOrRevivePlan({
      workspaceId,
      path: `.lares/plans/${label}-${serial}/plan.md`,
      format: 'structured',
      runState: 'hardening',
    });
    if (artifactId !== null) {
      db.getDb().prepare('UPDATE plans SET artifact_id = ? WHERE id = ?').run(artifactId, created.id);
    }
    return created.id;
  }

  function intent(
    workspaceId: string,
    planId: string,
    artifactId: string,
    intentId: string,
    status: 'active' | 'withdrawn' | 'superseded',
  ): void {
    db.getDb().prepare(
      `INSERT INTO plan_intents
         (id, workspace_id, plan_id, plan_artifact_id, intent_id, kind,
          source_doc_rel_path, status, first_seen_at, updated_at, last_scanned_at)
       VALUES (?, ?, ?, ?, ?, 'research', 'plan.md', ?, 1, 1, 1)`,
    ).run(`intent-row-${++serial}`, workspaceId, planId, artifactId, intentId, status);
  }

  function expectError(
    action: () => unknown,
    statusCode: number,
    code: InstanceType<typeof resolver.PlanRefError>['code'],
    message: string,
  ): void {
    assert.throws(action, (error: unknown) => {
      assert.ok(error instanceof resolver.PlanRefError);
      assert.equal(error.statusCode, statusCode);
      assert.equal(error.code, code);
      assert.equal(error.message, message);
      return true;
    });
  }

  after(() => {
    db.closeDatabaseForTests();
    if (priorAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = priorAppData;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test('error vocabulary has seven unique machine codes', () => {
    assert.equal(PLAN_REF_ERROR_CODES.length, 7);
    assert.equal(new Set(PLAN_REF_ERROR_CODES).size, PLAN_REF_ERROR_CODES.length);
  });

  test('resolvePlanRef resolves a UUID and its workspace-scoped portable alias', () => {
    const workspaceId = workspace('both-namespaces');
    const artifactId = 'plan_a1b2c3d4';
    const planId = plan(workspaceId, artifactId, 'both-namespaces');
    assert.equal(resolver.resolvePlanRef(workspaceId, planId).planId, planId);
    assert.equal(resolver.resolvePlanRef(workspaceId, artifactId).planId, planId);
  });

  test('legacy UUID-only plans remain resolvable', () => {
    const workspaceId = workspace('legacy');
    const planId = plan(workspaceId, null, 'legacy');
    assert.equal(resolver.resolvePlanRef(workspaceId, planId).planId, planId);
  });

  test('the same portable id resolves independently within two workspaces', () => {
    const artifactId = 'plan_11223344';
    const workspaceA = workspace('scope-a');
    const workspaceB = workspace('scope-b');
    const planA = plan(workspaceA, artifactId, 'scope-a');
    const planB = plan(workspaceB, artifactId, 'scope-b');
    assert.notEqual(planA, planB);
    assert.equal(resolver.resolvePlanRef(workspaceA, artifactId).planId, planA);
    assert.equal(resolver.resolvePlanRef(workspaceB, artifactId).planId, planB);
  });

  test('portable refs never expose that the same id exists in another workspace', () => {
    const artifactId = 'plan_55667788';
    const ownerWorkspace = workspace('portable-owner');
    const callerWorkspace = workspace('portable-caller');
    plan(ownerWorkspace, artifactId, 'portable-owner');
    expectError(
      () => resolver.resolvePlanRef(callerWorkspace, artifactId),
      404,
      'plan_not_found',
      `No plan matching plan_id '${artifactId}' exists in the requested workspace scope.`,
    );
  });

  test('soft-deleted plans report plan_deleted through both namespaces', () => {
    const workspaceId = workspace('deleted');
    const artifactId = 'plan_deadbeef';
    const planId = plan(workspaceId, artifactId, 'deleted');
    db.softDeletePlan(planId);
    for (const ref of [planId, artifactId]) {
      expectError(
        () => resolver.resolvePlanRef(workspaceId, ref),
        409,
        'plan_deleted',
        `Plan '${ref}' resolves to a deleted plan row; deleted plans are not a valid target.`,
      );
    }
  });

  test('the first four rungs use the settled codes and exact messages in order', () => {
    const workspaceId = workspace('plan-rungs');
    const otherWorkspace = workspace('plan-rungs-other');
    const foreignPlanId = plan(otherWorkspace, 'plan_abcdef01', 'foreign');
    const deletedForeignPlanId = plan(otherWorkspace, 'plan_abcdef02', 'deleted-foreign');
    db.softDeletePlan(deletedForeignPlanId);
    const unknownUuid = '00000000-0000-4000-8000-000000000001';
    const malformed = 'plan_nothex';

    expectError(
      () => resolver.resolvePlanRef(workspaceId, malformed),
      400,
      'plan_ref_malformed',
      `plan_id '${malformed}' must be a plan row UUID or a portable plan artifact id matching plan_<8hex>.`,
    );
    expectError(
      () => resolver.resolvePlanRef(workspaceId, unknownUuid),
      404,
      'plan_not_found',
      `No plan matching plan_id '${unknownUuid}' exists in the requested workspace scope.`,
    );
    // Both later guards apply; only checking liveness before ownership yields plan_deleted.
    expectError(
      () => resolver.resolvePlanRef(workspaceId, deletedForeignPlanId),
      409,
      'plan_deleted',
      `Plan '${deletedForeignPlanId}' resolves to a deleted plan row; deleted plans are not a valid target.`,
    );
    expectError(
      () => resolver.resolvePlanRef(workspaceId, foreignPlanId),
      403,
      'plan_wrong_workspace',
      `Plan '${foreignPlanId}' does not belong to workspace '${workspaceId}'.`,
    );
  });

  test('resolveActivePlanRef distinguishes missing and inactive intents exactly', () => {
    const workspaceId = workspace('intent-rungs');
    const artifactId = 'plan_01020304';
    const planId = plan(workspaceId, artifactId, 'intent-rungs');
    const missingIntentId = 'int_00000000';
    const inactiveIntentId = 'int_11111111';
    intent(workspaceId, planId, artifactId, inactiveIntentId, 'withdrawn');

    expectError(
      () => resolver.resolveActivePlanRef(workspaceId, artifactId, missingIntentId),
      404,
      'planning_intent_not_found',
      `Planning intent '${missingIntentId}' is not recorded for plan '${planId}' (resolved from '${artifactId}').`,
    );
    expectError(
      () => resolver.resolveActivePlanRef(workspaceId, artifactId, inactiveIntentId),
      409,
      'planning_intent_not_active',
      `Planning intent '${inactiveIntentId}' for plan '${planId}' has status 'withdrawn'; expected 'active'.`,
    );
  });

  test('two active intents on one plan resolve independently by the canonical UUID', () => {
    const workspaceId = workspace('two-intents');
    const artifactId = 'plan_1234abcd';
    const planId = plan(workspaceId, artifactId, 'two-intents');
    const firstIntentId = 'int_22222222';
    const secondIntentId = 'int_33333333';
    intent(workspaceId, planId, artifactId, firstIntentId, 'active');
    intent(workspaceId, planId, artifactId, secondIntentId, 'active');

    const first = resolver.resolveActivePlanRef(workspaceId, artifactId, firstIntentId);
    const second = resolver.resolveActivePlanRef(workspaceId, artifactId, secondIntentId);
    assert.equal(first.planId, planId);
    assert.deepEqual(first.intent, { intentId: firstIntentId, status: 'active' });
    assert.equal(second.planId, planId);
    assert.deepEqual(second.intent, { intentId: secondIntentId, status: 'active' });
  });
})().catch((error) => {
  process.nextTick(() => { throw error; });
});
