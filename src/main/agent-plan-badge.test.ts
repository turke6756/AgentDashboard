import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type SqlDb = { exec(sql: string): void; run(sql: string, params?: unknown[]): void; prepare(sql: string): any };
let SQL: any;
class FakeDb {
  static store: SqlDb;
  private db: SqlDb;
  constructor() { this.db = FakeDb.store; }
  pragma(): void {}
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string): any {
    const db = this.db;
    return {
      run: (...params: unknown[]) => { db.run(sql, params); return {}; },
      get: (...params: unknown[]) => { const s = db.prepare(sql); s.bind(params); const hit = s.step(); const row = hit ? s.getAsObject() : undefined; s.free(); return row; },
      all: (...params: unknown[]) => { const s = db.prepare(sql); s.bind(params); const rows: any[] = []; while (s.step()) rows.push(s.getAsObject()); s.free(); return rows; },
    };
  }
  transaction(fn: Function): Function { return (...args: unknown[]) => { this.db.exec('BEGIN'); try { const r = fn(...args); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }; }
}

const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'badge-summary-'));
process.env.APPDATA = appData;
const tests: Array<() => void> = [];
tests.push(() => {
  const db = require('./database') as any;
  db.initDatabase();
  const ws = db.createWorkspace({ title: 'badge', path: appData, pathType: 'local' });
  const author = db.createAgent({ workspaceId: ws.id, title: 'Author', roleDescription: '', workingDirectory: appData, command: 'test', isSupervisor: true, tmuxSessionName: null, autoRestartEnabled: false, logPath: '' });
  const carrier = db.createAgent({ workspaceId: ws.id, title: 'Carrier', roleDescription: '', workingDirectory: appData, command: 'test', isSupervisor: true, tmuxSessionName: null, autoRestartEnabled: false, logPath: '' });
  const both = db.createAgent({ workspaceId: ws.id, title: 'Both', roleDescription: '', workingDirectory: appData, command: 'test', isSupervisor: true, tmuxSessionName: null, autoRestartEnabled: false, logPath: '' });
  const insertPlan = (id: string, artifact: string, source: string | null = null) => FakeDb.store.run(
    `INSERT INTO plans (id, workspace_id, path, slug, format, mtime_ms, size_bytes, artifact_id, source_proposal_id) VALUES (?, ?, ?, ?, 'structured', 1, 1, ?, ?)`,
    [id, ws.id, `.lares/plans/${id}/plan.md`, id, artifact, source]);
  insertPlan('plan-one', 'plan_one', 'proposal-one');
  insertPlan('plan-two', 'plan_two', 'proposal-two');
  db.insertProposalRecord({ id: 'proposal-one', artifactId: 'proposal_one', workspaceId: ws.id, path: '.lares/proposals/one.md', slug: 'one', title: 'one', state: 'promoted', authorAgentId: both.id, authorRole: 'worker', authorDisplay: null, authoredAt: null, createdAt: 1, updatedAt: 1, mtimeMs: 1, sizeBytes: 1, promotedToPlanId: 'plan-one', deletedAt: null });
  db.insertProposalRecord({ id: 'proposal-two', artifactId: 'proposal_two', workspaceId: ws.id, path: '.lares/proposals/two.md', slug: 'two', title: 'two', state: 'promoted', authorAgentId: author.id, authorRole: 'worker', authorDisplay: null, authoredAt: null, createdAt: 1, updatedAt: 1, mtimeMs: 1, sizeBytes: 1, promotedToPlanId: 'plan-two', deletedAt: null });
  db.insertProposalRecord({ id: 'proposal-unpromoted', artifactId: 'proposal_unpromoted', workspaceId: ws.id, path: '.lares/proposals/unpromoted.md', slug: 'unpromoted', title: 'u', state: 'proposal', authorAgentId: carrier.id, authorRole: 'worker', authorDisplay: null, authoredAt: null, createdAt: 1, updatedAt: 1, mtimeMs: 1, sizeBytes: 1, promotedToPlanId: null, deletedAt: null });
  db.upsertSupervisorFocus({ supervisorId: both.id, planId: 'plan-one' });
  db.upsertSupervisorFocus({ supervisorId: carrier.id, planId: 'plan-two' });
  const result = db.getAgentPlanBadgeSummary(ws.id);
  assert.deepEqual(result[both.id], { authored: ['plan_one'], carrying: ['plan_one'] });
  assert.deepEqual(result[author.id], { authored: ['plan_two'], carrying: [] });
  assert.deepEqual(result[carrier.id], { authored: [], carrying: ['plan_two'] });
  assert.equal(result[carrier.id].authored.includes('plan_unpromoted'), false);
});

(async () => {
  const initSqlJs = require('sql.js');
  SQL = await initSqlJs();
  FakeDb.store = new SQL.Database();
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeDb } as any;
  let passed = 0;
  for (const test of tests) { test(); passed++; }
  const handlers = new Map<string, (...args: any[]) => any>();
  const electronPath = require.resolve('electron');
  const ipcHandlersPath = require.resolve('./ipc-handlers');
  const priorElectron = require.cache[electronPath];
  const priorHandlers = require.cache[ipcHandlersPath];
  const noop = () => undefined;
  let exposedApi: any;
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
    app: { getPath: () => appData, isPackaged: false, on: noop }, contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { exposedApi = api; } },
    ipcRenderer: { invoke: noop, on: noop, removeListener: noop }, webUtils: { getPathForFile: () => '' },
    dialog: { showOpenDialog: noop, showMessageBox: noop }, shell: { openExternal: noop, trashItem: noop },
    BrowserWindow: class {}, nativeTheme: { on: noop, themeSource: 'system', shouldUseDarkColors: false },
  }, children: [], paths: [] } as any;
  delete require.cache[ipcHandlersPath];
  try {
    const bridge = require('./ipc-handlers') as any;
    bridge.registerIpcHandlers(new Proxy({}, { get: () => noop }) as any, new Proxy({}, { get: () => noop }) as any, {});
    const handler = handlers.get('agents:planBadgeSummary');
    assert.ok(handler, 'REACHABILITY:badge-summary-ipc');
    const preloadPath = require.resolve('../preload/index');
    delete require.cache[preloadPath];
    require('../preload/index');
    assert.equal(typeof exposedApi?.agents?.getAgentPlanBadgeSummary, 'function', 'REACHABILITY:preload:badge-summary');
  } finally {
    if (priorElectron) require.cache[electronPath] = priorElectron; else delete require.cache[electronPath];
    if (priorHandlers) require.cache[ipcHandlersPath] = priorHandlers; else delete require.cache[ipcHandlersPath];
  }
  console.log(`  ok  badge query acceptance (${passed} test)`);
  console.log('REACHABILITY:badge-summary-ipc entering test executes database seam');
})().catch((error) => { console.error(error); process.exit(1); });
