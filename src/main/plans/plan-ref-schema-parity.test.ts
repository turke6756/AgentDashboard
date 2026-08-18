// WP-5 Plan DTO observability and agent-facing schema parity.
//
//   npx tsc -p tsconfig.main.json
//   node dist/main/main/plans/plan-ref-schema-parity.test.js

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLAN_ARTIFACT_ID_RE, PLAN_ROW_ID_RE } from '../../shared/planning-artifact-ids';

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
      const savepoint = `schema_parity_test_${++this.transactionSerial}`;
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
type ToolDefinition = {
  name: string;
  inputSchema: { properties: { plan_id?: { pattern?: string; description?: string } } };
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-ref-schema-parity-'));
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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const orchestrationTools = require(path.join(process.cwd(), 'scripts/mcp-tools-orchestration.js')) as {
    getOrchestrationToolDefinitions(): ToolDefinition[];
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const planTools = require(path.join(process.cwd(), 'scripts/mcp-tools-plans.js')) as {
    getPlansToolDefinitions(): ToolDefinition[];
  };
  db.initDatabase();

  after(() => {
    db.closeDatabaseForTests();
    if (priorAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = priorAppData;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test('plan-dto-exposes-artifact-id', () => {
    const workspaceId = db.createWorkspace({
      title: 'schema parity',
      path: path.join(scratch, 'workspace'),
      pathType: 'windows',
    }).id;
    const portable = db.createOrRevivePlan({
      workspaceId,
      path: '.lares/plans/portable/plan.md',
      format: 'structured',
    });
    db.getDb().prepare('UPDATE plans SET artifact_id = ? WHERE id = ?')
      .run('plan_a1b2c3d4', portable.id);
    const legacy = db.createOrRevivePlan({
      workspaceId,
      path: 'plans/legacy.md',
      format: 'md',
    });

    assert.equal(db.getPlan(portable.id)?.artifactId, 'plan_a1b2c3d4', 'REACHABILITY:plan-dto-artifact-id');
    assert.equal(db.getPlan(legacy.id)?.artifactId, null);
    assert.equal(db.getPlanByWorkspacePath(workspaceId, portable.path)?.artifactId, 'plan_a1b2c3d4');
    assert.equal(db.getPlans({ workspaceId }).find((plan) => plan.id === portable.id)?.artifactId, 'plan_a1b2c3d4');

    const focus = db.upsertSupervisorFocus({ supervisorId: 'schema-parity-supervisor', planId: portable.id });
    assert.equal(focus.plan?.artifactId, 'plan_a1b2c3d4');
  });

  test('all five agent-facing plan_id schemas exactly match the resolver shapes', () => {
    const stripAnchors = (source: string) => source.replace(/^\^/, '').replace(/\$$/, '');
    const expected = `^(?:${stripAnchors(PLAN_ROW_ID_RE.source)}|${stripAnchors(PLAN_ARTIFACT_ID_RE.source)})$`;
    const definitions = [
      ...orchestrationTools.getOrchestrationToolDefinitions(),
      ...planTools.getPlansToolDefinitions(),
    ].filter((definition) => ['launch_agent', 'run_orchestration', 'read_plan_progress', 'focus_plan', 'unfocus_plan'].includes(definition.name));

    assert.deepEqual(definitions.map((definition) => definition.name).sort(),
      ['focus_plan', 'launch_agent', 'read_plan_progress', 'run_orchestration', 'unfocus_plan']);
    for (const definition of definitions) {
      const schema = definition.inputSchema.properties.plan_id;
      assert.equal(schema?.pattern, expected, `${definition.name} plan_id pattern drifted from the resolver`);
      assert.match(schema?.description ?? '', /registered plan row id \(uuid\)/);
      assert.match(schema?.description ?? '', /portable plan artifact id \(plan_<8hex>\) from the plan's own files/);
    }
  });

  test('a ref matching neither namespace is rejected with the settled diagnostic', () => {
    assert.throws(
      () => resolver.resolvePlanRef('workspace-does-not-matter', 'plans/new-plan.md'),
      (error: unknown) => {
        assert.ok(error instanceof resolver.PlanRefError);
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, 'plan_ref_malformed');
        assert.equal(error.message,
          "plan_id 'plans/new-plan.md' must be a plan row UUID or a portable plan artifact id matching plan_<8hex>.");
        return true;
      },
    );
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
