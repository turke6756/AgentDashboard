// WP-6 production-seam acceptance. Recovery operations enter only through:
// createCheckpointInvokeApi -> registered IPC handler -> recovery-surface routes.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  CheckpointPreviewResult,
  CheckpointRestoreResult,
  GitCapability,
  IpcApi,
} from '../../shared/types';
import type { RecoveryOperation } from '../database';
import type { CheckpointEngineHandle } from './engine-bootstrap';
import type { IpcLike } from './checkpoint-ipc';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

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

let sqlJsCtor: new () => SqlJsDatabase;

/** Real SQLite semantics in an isolated sql.js store. better-sqlite3 itself is
 * Electron-ABI-only in this workspace and cannot load in the required node run. */
class IsolatedSqlite {
  private static readonly stores = new Map<string, SqlJsDatabase>();
  private readonly db: SqlJsDatabase;

  constructor(dbPath = ':memory:') {
    let store = IsolatedSqlite.stores.get(dbPath);
    if (!store) {
      store = new sqlJsCtor();
      IsolatedSqlite.stores.set(dbPath, store);
    }
    this.db = store;
  }

  pragma(_sql: string): unknown { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  close(): void { /* path-keyed store intentionally survives like an on-disk DB */ }

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
        } finally { statement.free(); }
      },
      all: (...params: unknown[]) => {
        const statement = db.prepare(sql);
        try {
          statement.bind(params);
          const rows: Record<string, unknown>[] = [];
          while (statement.step()) rows.push(statement.getAsObject());
          return rows;
        } finally { statement.free(); }
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

type Handler = (event: unknown, ...args: unknown[]) => unknown;

/** Transport only: all domain handlers are installed by registerCheckpointIpc. */
class RegisteredIpcTransport implements IpcLike {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, listener: Handler): void { this.handlers.set(channel, listener); }
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const handler = this.handlers.get(channel);
    assert.ok(handler, `production registrar must install ${channel}`);
    return await handler({}, ...args) as T;
  }
}

type DbModule = typeof import('../database');
type EngineModule = typeof import('./engine-bootstrap');
type IpcModule = typeof import('./checkpoint-ipc');
type PreloadModule = typeof import('../../preload/index');
type GitRuntimeModule = typeof import('../git/git-runtime');

let db: DbModule;
let engine: CheckpointEngineHandle;
let api: IpcApi['checkpoints'];
let probeWorkspaceGit: GitRuntimeModule['probeWorkspaceGit'];
let appData = '';
const repositories: string[] = [];

function git(cwd: string, args: string[], input?: string | Buffer): string {
  return execFileSync(engine?.gitExe ?? 'git', args, { cwd, input }).toString();
}

function makeRepo(autocrlf: boolean): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-merge-acceptance-'));
  repositories.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'acceptance@lares.local'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Lares Acceptance'], { cwd: repo });
  execFileSync('git', ['config', 'core.autocrlf', autocrlf ? 'true' : 'false'], { cwd: repo });
  return repo;
}

function commitAll(repo: string, message: string): void {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
}

function numberedLines(count = 460): string[] {
  return Array.from({ length: count }, (_, index) => `line-${index + 1}`);
}

function writeCrlf(filePath: string, lines: readonly string[]): void {
  fs.writeFileSync(filePath, `${lines.join('\r\n')}\r\n`);
}

function normalizedLines(filePath: string): string[] {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').trimEnd().split('\n');
}

function assertOnlyCrlf(filePath: string): void {
  const text = fs.readFileSync(filePath, 'utf8');
  assert.ok(text.includes('\r\n'), 'worktree retains CRLF');
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'worktree has no bare LF');
}

function assertLfBlob(repo: string, spec: string): void {
  const blob = execFileSync(engine.gitExe, ['show', spec], { cwd: repo });
  assert.equal(blob.includes(Buffer.from('\r\n')), false, `${spec} is normalized LF`);
  assert.ok(blob.includes(Buffer.from('\n')));
}

function indexSnapshot(repo: string): string {
  return git(repo, ['ls-files', '--stage', '-z']);
}

function recoveryRefs(repo: string): string[] {
  return git(repo, ['for-each-ref', '--format=%(refname)', 'refs/lares/recovery'])
    .trim().split(/\r?\n/).filter(Boolean).sort();
}

async function registerWorkspace(repo: string, title: string): Promise<{
  workspaceId: string;
  agentId: string;
  capability: GitCapability;
}> {
  const workspace = db.createWorkspace({ title, path: repo, pathType: 'windows' });
  const agent = db.createAgent({
    workspaceId: workspace.id,
    title: `${title} agent`,
    roleDescription: '',
    workingDirectory: repo,
    command: 'codex',
    provider: 'codex',
    tmuxSessionName: null,
    autoRestartEnabled: false,
    logPath: path.join(repo, 'agent.log'),
  });
  const capability = await probeWorkspaceGit(fs.realpathSync.native(repo));
  assert.equal(capability.repoState, 'repo');
  assert.ok(capability.repoRoot);
  return { workspaceId: workspace.id, agentId: agent.id, capability };
}

async function captureTurn(
  identity: { workspaceId: string; agentId: string; capability: GitCapability },
  mutate: () => void,
  witnesses: Array<{ path: string; op: 'write' | 'create' }>,
): Promise<string> {
  const before = await engine.coordinator.beforeCheckpoint(identity.agentId, {
    workspaceId: identity.workspaceId,
    agentId: identity.agentId,
    agentTitle: 'Acceptance Agent',
    capability: identity.capability,
    taskLabel: 'WP-6 merge undo acceptance',
    quality: 'guaranteed',
  });
  assert.equal(before.ready, true, `before checkpoint ready: ${before.failureReason}`);
  mutate();
  for (const witness of witnesses) {
    engine.witnessObserve(identity.agentId, path.join(identity.capability.repoRoot!, witness.path), witness.op);
  }
  const closed = new Promise<void>((resolve) => {
    const unsubscribe = engine.coordinator.onTurnClosed((event) => {
      if (event.turnId !== before.turnId) return;
      unsubscribe();
      resolve();
    });
  });
  engine.completionTracker.noteHookStop(identity.agentId);
  await closed;
  const row = db.getTurnRecord(before.turnId);
  assert.equal(row?.beforeReady, true);
  assert.equal(row?.afterReady, true);
  assert.equal(row?.status, 'accepted');
  return before.turnId;
}

function operations(workspaceId: string, turnId: string): RecoveryOperation[] {
  return db.listRecoveryOperations(workspaceId, { sourceTurnId: turnId });
}

function assertCompletedRecovery(
  repo: string,
  operation: RecoveryOperation,
  token: string,
  expectedPaths: string[],
): void {
  assert.equal(operation.kind, 'merge_undo_paths');
  assert.equal(operation.status, 'completed');
  assert.equal(operation.previewToken, token);
  assert.deepEqual(operation.requestedPaths, expectedPaths);
  assert.deepEqual(operation.completedPaths, expectedPaths);
  assert.equal(operation.preReady, true);
  assert.ok(operation.preRef && operation.preOid);
  assert.equal(git(repo, ['rev-parse', '--verify', `${operation.preRef}^{commit}`]).trim(), operation.preOid);
  const included = operation.preIncludedPaths as Array<{
    path: string;
    oid?: string | null;
    indexOid?: string | null;
    indexState: 'present' | 'absent';
  }>;
  assert.deepEqual(included.map((entry) => entry.path).sort(), [...expectedPaths].sort());
  for (const entry of included) {
    assert.ok(entry.indexState === 'present' || entry.indexState === 'absent');
    if (entry.indexState === 'present') {
      assert.ok(entry.oid, `PRE worktree oid for ${entry.path}`);
      assert.ok(entry.indexOid, `PRE index oid for ${entry.path}`);
    }
  }
}

function mergePreview(workspaceId: string, turnId: string, paths: string[]): Promise<CheckpointPreviewResult> {
  return api.preview(workspaceId, turnId, { paths, strategy: 'merge-undo' });
}

function mergeRestore(
  workspaceId: string,
  turnId: string,
  paths: string[],
  mergePreviewToken: string,
): Promise<CheckpointRestoreResult> {
  return api.restore({ workspaceId, turnId, paths, strategy: 'merge-undo', mergePreviewToken });
}

test('distant-line autocrlf undo preserves staged later work and complete recovery', async () => {
  const repo = makeRepo(true);
  const filePath = path.join(repo, 'story.txt');
  const base = numberedLines();
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt text\n');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'unchanged\r\n');
  writeCrlf(filePath, base);
  commitAll(repo, 'B');
  assertOnlyCrlf(filePath);
  assertLfBlob(repo, 'HEAD:story.txt');
  const identity = await registerWorkspace(repo, 'distant-lines');

  const after = [...base];
  for (let index = 9; index < 20; index++) after[index] = `turn-change-${index + 1}`;
  const turnId = await captureTurn(identity, () => {
    writeCrlf(filePath, after);
    commitAll(repo, 'A');
  }, [{ path: 'story.txt', op: 'write' }]);
  const later = [...after];
  for (let index = 399; index < 420; index++) later[index] = `later-staged-${index + 1}`;
  writeCrlf(filePath, later);
  git(repo, ['add', '--', 'story.txt']);
  const headBefore = git(repo, ['rev-parse', 'HEAD']).trim();
  const unrelatedBefore = fs.readFileSync(path.join(repo, 'unrelated.txt'));

  const preview = await mergePreview(identity.workspaceId, turnId, ['story.txt']);
  assert.equal(preview.available, true, `preview failed: ${JSON.stringify(preview)}`);
  assert.equal(preview.pathStates?.[0]?.state, 'merged');
  assert.ok(preview.mergePreviewToken);
  const result = await mergeRestore(identity.workspaceId, turnId, ['story.txt'], preview.mergePreviewToken);
  assert.equal(result.status, 'completed', result.failureReason ?? 'restore failed');
  assert.equal(result.kind, 'merge_undo_paths');

  const merged = normalizedLines(filePath);
  assert.deepEqual(merged.slice(9, 20), base.slice(9, 20));
  assert.deepEqual(merged.slice(399, 420), later.slice(399, 420));
  assertOnlyCrlf(filePath);
  assertLfBlob(repo, ':story.txt');
  assert.deepEqual(git(repo, ['show', ':story.txt']).trimEnd().split(/\r?\n/), merged);
  assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), headBefore);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'unrelated.txt')), unrelatedBefore);
  const recovery = operations(identity.workspaceId, turnId);
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].id, result.operationId);
  assertCompletedRecovery(repo, recovery[0], preview.mergePreviewToken, ['story.txt']);
});

test('same-line autocrlf undo refuses with true line range and no mutation', async () => {
  const repo = makeRepo(true);
  const filePath = path.join(repo, 'story.txt');
  const base = numberedLines();
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt text\n');
  writeCrlf(filePath, base);
  commitAll(repo, 'B');
  const identity = await registerWorkspace(repo, 'same-lines');
  const after = [...base];
  for (let index = 9; index < 20; index++) after[index] = `turn-version-${index + 1}`;
  const turnId = await captureTurn(identity, () => {
    writeCrlf(filePath, after);
    commitAll(repo, 'A');
  }, [{ path: 'story.txt', op: 'write' }]);
  const later = [...after];
  for (let index = 9; index < 20; index++) later[index] = `later-conflict-${index + 1}`;
  writeCrlf(filePath, later);
  git(repo, ['add', '--', 'story.txt']);
  const bytesBefore = fs.readFileSync(filePath);
  const indexBefore = indexSnapshot(repo);
  const headBefore = git(repo, ['rev-parse', 'HEAD']).trim();
  const refsBefore = recoveryRefs(repo);

  const preview = await mergePreview(identity.workspaceId, turnId, ['story.txt']);
  assert.equal(preview.available, false);
  assert.equal(preview.reason, 'merge-undo-conflict');
  assert.equal(preview.mergePreviewToken, undefined);
  const state = preview.pathStates?.find((entry) => entry.path === 'story.txt');
  assert.equal(state?.state, 'conflicted');
  assert.equal(state?.reason, 'merge-undo-conflict');
  assert.match(state?.patch ?? '', /@@ -10,11 \+10,11 @@ current\/base\/inverse conflict/);
  assert.match(state?.patch ?? '', /<<<<<<< current:story\.txt/);
  assert.match(state?.patch ?? '', /\|\|\|\|\|\|\| base:story\.txt/);
  assert.match(state?.patch ?? '', />>>>>>> inverse:story\.txt/);

  const refused = await mergeRestore(identity.workspaceId, turnId, ['story.txt'], 'fabricated-token');
  assert.equal(refused.status, 'failed');
  assert.equal(refused.failureReason, 'merge-preview-token-invalid');
  assert.deepEqual(refused.completedPaths, []);
  assert.deepEqual(fs.readFileSync(filePath), bytesBefore);
  assert.equal(indexSnapshot(repo), indexBefore);
  assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), headBefore);
  assert.deepEqual(recoveryRefs(repo), refsBefore);
  const recovery = operations(identity.workspaceId, turnId);
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].kind, 'merge_undo_paths');
  assert.equal(recovery[0].status, 'failed');
  assert.equal(recovery[0].failureReason, 'merge-preview-token-invalid');
  assert.equal(recovery[0].previewToken, 'fabricated-token');
  assert.equal(recovery[0].preReady, false);
  assert.equal(recovery[0].preRef, null);
  assert.equal(recovery[0].preOid, null);
  assert.equal(recovery[0].completedPaths, null);
});

test('rename refuses one endpoint then atomically restores both with recovery', async () => {
  const repo = makeRepo(false);
  fs.writeFileSync(path.join(repo, 'old.txt'), 'before rename\n');
  commitAll(repo, 'B');
  const identity = await registerWorkspace(repo, 'rename');
  const turnId = await captureTurn(identity, () => {
    fs.renameSync(path.join(repo, 'old.txt'), path.join(repo, 'new.txt'));
    commitAll(repo, 'A rename');
  }, [
    { path: 'old.txt', op: 'write' },
    { path: 'new.txt', op: 'create' },
  ]);
  const headBefore = git(repo, ['rev-parse', 'HEAD']).trim();
  const indexBefore = indexSnapshot(repo);
  const refsBefore = recoveryRefs(repo);

  const incomplete = await mergePreview(identity.workspaceId, turnId, ['new.txt']);
  assert.equal(incomplete.available, false);
  assert.equal(incomplete.pathStates?.find((entry) => entry.path === 'new.txt')?.state, 'rename-pair-incomplete');
  assert.equal(indexSnapshot(repo), indexBefore);
  assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), headBefore);
  assert.deepEqual(recoveryRefs(repo), refsBefore);
  assert.deepEqual(operations(identity.workspaceId, turnId), []);

  const preview = await mergePreview(identity.workspaceId, turnId, ['old.txt', 'new.txt']);
  assert.equal(preview.available, true, preview.reason ?? 'rename preview failed');
  assert.ok(preview.mergePreviewToken);
  const result = await mergeRestore(
    identity.workspaceId,
    turnId,
    ['old.txt', 'new.txt'],
    preview.mergePreviewToken,
  );
  assert.equal(result.status, 'completed', result.failureReason ?? 'rename undo failed');
  assert.equal(fs.existsSync(path.join(repo, 'old.txt')), true);
  assert.equal(fs.existsSync(path.join(repo, 'new.txt')), false);
  assert.equal(fs.readFileSync(path.join(repo, 'old.txt'), 'utf8'), 'before rename\n');
  assert.equal(git(repo, ['show', ':old.txt']), 'before rename\n');
  assert.equal(git(repo, ['ls-files', '--', 'new.txt']), '');
  assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), headBefore);
  const recovery = operations(identity.workspaceId, turnId);
  assert.equal(recovery.length, 1);
  assertCompletedRecovery(repo, recovery[0], preview.mergePreviewToken, ['old.txt', 'new.txt']);
});

async function bootstrap(): Promise<void> {
  appData = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-merge-acceptance-db-'));
  process.env.APPDATA = appData;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js') as () => Promise<{ Database: new () => SqlJsDatabase }>;
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;
  const sqlitePath = require.resolve('better-sqlite3');
  require.cache[sqlitePath] = {
    id: sqlitePath,
    filename: sqlitePath,
    loaded: true,
    exports: IsolatedSqlite,
  } as unknown as NodeJS.Module;

  // Load production modules only after the isolated database adapter is installed.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  db = require('../database') as DbModule;
  db.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const engineModule = require('./engine-bootstrap') as EngineModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ipcModule = require('./checkpoint-ipc') as IpcModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const preloadModule = require('../../preload/index') as PreloadModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const gitRuntime = require('../git/git-runtime') as GitRuntimeModule;
  probeWorkspaceGit = gitRuntime.probeWorkspaceGit;

  const surface = await ipcModule.createCheckpointRecoverySurface({
    createEngine: engineModule.createCheckpointEngine,
  });
  assert.ok(surface, 'production recovery surface creates the checkpoint engine');
  engine = surface;
  const transport = new RegisteredIpcTransport();
  ipcModule.registerCheckpointIpc(transport, () => surface.humanCheckpointRoutes);
  api = preloadModule.createCheckpointInvokeApi((channel, ...args) => transport.invoke(channel, ...args));
}

async function cleanup(): Promise<void> {
  try { await engine?.coordinator.shutdown(); } catch { /* best effort */ }
  try { db?.closeDatabase(); } catch { /* best effort */ }
  for (const repo of repositories.splice(0)) {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (appData) {
    try { fs.rmSync(appData, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

(async () => {
  let failures = 0;
  try {
    await bootstrap();
    for (const entry of tests) {
      try {
        await entry.run();
        console.log(`  ok  ${entry.name}`);
      } catch (error) {
        failures++;
        console.error(`  FAIL ${entry.name}`);
        console.error(error instanceof Error ? error.stack : String(error));
      }
    }
  } catch (error) {
    failures++;
    console.error('  FAIL production acceptance bootstrap');
    console.error(error instanceof Error ? error.stack : String(error));
  } finally {
    await cleanup();
  }
  console.log(`\n${tests.length - failures} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
