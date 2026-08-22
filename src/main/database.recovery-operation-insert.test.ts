// Regression: insertRecoveryOperation must bind a value for EVERY column in the
// INSERT INTO recovery_operations statement.
//
// The statement names 17 columns (… created_at, ended_at) with 17 `?`
// placeholders. A prior version passed only 16 values — it forgot `ended_at` —
// so EVERY execution threw:
//
//     RangeError: Too few parameter values were provided
//
// which surfaced to the human as a failed "Confirm undo" in the RestoreDialog
// (`checkpoint:revert`). The sql.js stand-in used elsewhere silently binds a
// missing trailing param as NULL and does NOT reproduce this, so this test runs
// the REAL prepared statement against a REAL better-sqlite3 database (no mock of
// db.prepare). It must be run under the Electron ABI (ELECTRON_RUN_AS_NODE) like
// the agy-session-reader suite.
//
// Mutation check (perform once, then restore): drop the 17th argument
// (`fields.endedAt ?? null`) from insertRecoveryOperation's `.run(...)` in
// database.ts and this test fails with the RangeError above.
//
//   npm run build:main
//   (run under Electron: node dist requires the native binding's Electron ABI)

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

type RecoveryOperation = {
  id: string;
  workspaceId: string;
  status: string;
  actor: string;
  kind: string;
  requestedPaths: unknown;
  createdAt: number | null;
  endedAt: number | null;
};
type DbModule = {
  initDatabase(): void;
  insertRecoveryOperation(workspaceId: string, fields: Record<string, unknown>): RecoveryOperation;
  getRecoveryOperation(id: string): RecoveryOperation | null;
};
let dbm: DbModule;

test('insertRecoveryOperation binds all 17 columns and round-trips (real better-sqlite3)', () => {
  const ws = 'ws-recovery-insert';
  // The exact shape the checkpoint:revert path inserts: no endedAt yet (the
  // operation has not ended). This is precisely the call that used to throw.
  const op = dbm.insertRecoveryOperation(ws, {
    kind: 'revert_turn',
    actor: 'human-ipc',
    status: 'pending',
    requestedPaths: ['a.ts', 'b.ts'],
  });
  assert.ok(op && op.id, 'insert must return the persisted operation');
  assert.equal(op.status, 'pending');
  assert.equal(op.endedAt, null, 'ended_at defaults to null when not supplied');

  const read = dbm.getRecoveryOperation(op.id);
  assert.ok(read, 'the row must be readable back');
  assert.equal(read?.workspaceId, ws);
  assert.equal(read?.kind, 'revert_turn');
  assert.equal(read?.actor, 'human-ipc');
  assert.equal(read?.status, 'pending');
  assert.deepEqual(read?.requestedPaths, ['a.ts', 'b.ts']);
});

test('insertRecoveryOperation persists an explicit endedAt in the 17th column', () => {
  const op = dbm.insertRecoveryOperation('ws-recovery-ended', {
    kind: 'restore_paths',
    actor: 'human-ipc',
    status: 'completed',
    endedAt: 424242,
  });
  assert.equal(op.endedAt, 424242, 'explicit endedAt must be bound and returned');
  assert.equal(dbm.getRecoveryOperation(op.id)?.endedAt, 424242, 'endedAt must round-trip from disk');
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-insert-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('./database') as DbModule;
  dbm.initDatabase();

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
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
