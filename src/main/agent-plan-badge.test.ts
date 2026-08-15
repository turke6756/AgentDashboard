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
  const owner = db.createAgent({ workspaceId: ws.id, title: 'Owner', roleDescription: '', workingDirectory: appData, command: 'test', isSupervisor: true, tmuxSessionName: null, autoRestartEnabled: false, logPath: '' });
  const follower = db.createAgent({ workspaceId: ws.id, title: 'Follower', roleDescription: '', workingDirectory: appData, command: 'test', isSupervisor: true, tmuxSessionName: null, autoRestartEnabled: false, logPath: '' });
  const unattached = db.createAgent({ workspaceId: ws.id, title: 'Unattached', roleDescription: '', workingDirectory: appData, command: 'test', isSupervisor: true, tmuxSessionName: null, autoRestartEnabled: false, logPath: '' });
  const insertPlan = (id: string, artifact: string, source: string | null, ownerId: string | null) => FakeDb.store.run(
    `INSERT INTO plans (id, workspace_id, path, slug, format, mtime_ms, size_bytes, artifact_id, source_proposal_id, responsible_supervisor_id) VALUES (?, ?, ?, ?, 'structured', 1, 1, ?, ?, ?)`,
    [id, ws.id, `.lares/plans/${id}/plan.md`, id, artifact, source, ownerId]);
  insertPlan('plan-one', 'plan_one', 'proposal-one', owner.id);
  insertPlan('plan-two', 'plan_two', 'proposal-two', owner.id);
  db.insertProposalRecord({ id: 'proposal-one', artifactId: 'proposal_one', workspaceId: ws.id, path: '.lares/proposals/one.md', slug: 'one', title: 'one', state: 'promoted', authorAgentId: follower.id, authorRole: 'worker', authorDisplay: null, authoredAt: null, createdAt: 1, updatedAt: 1, mtimeMs: 1, sizeBytes: 1, promotedToPlanId: 'plan-one', deletedAt: null });
  db.insertProposalRecord({ id: 'proposal-two', artifactId: 'proposal_two', workspaceId: ws.id, path: '.lares/proposals/two.md', slug: 'two', title: 'two', state: 'promoted', authorAgentId: author.id, authorRole: 'worker', authorDisplay: null, authoredAt: null, createdAt: 1, updatedAt: 1, mtimeMs: 1, sizeBytes: 1, promotedToPlanId: 'plan-two', deletedAt: null });
  db.upsertSupervisorFocus({ supervisorId: follower.id, planId: 'plan-one' });
  db.upsertSupervisorFocus({ supervisorId: author.id, planId: 'plan-two' });
  const result = db.getAgentPlanBadgeSummary(ws.id);
  assert.deepEqual(result[owner.id], [{
    kind: 'promoted-plan', planId: 'plan-one', planArtifactId: 'plan_one', title: 'one',
    relationships: ['carrying'], proposalPath: '.lares/proposals/one.md',
    proposalArtifactId: 'proposal_one',
  }, {
    kind: 'promoted-plan', planId: 'plan-two', planArtifactId: 'plan_two', title: 'two',
    relationships: ['carrying'], proposalPath: '.lares/proposals/two.md',
    proposalArtifactId: 'proposal_two',
  }]);
  assert.equal(result[follower.id], undefined, 'focus and authorship must not confer a card mark');
  assert.equal(result[author.id], undefined, 'authorship and focus must not confer a card mark');
  assert.equal(result[unattached.id], undefined);
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
