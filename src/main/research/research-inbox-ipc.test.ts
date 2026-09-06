import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

(async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const noop = () => undefined;
  const electronPath = require.resolve('electron');
  const priorElectron = require.cache[electronPath];
  let exposedApi: any = null;
  const ipcMain = {
    handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler),
  };
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      ipcMain,
      app: { getPath: () => process.cwd(), getAppPath: () => process.cwd(), isPackaged: false, on: noop },
      contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { exposedApi = api; } },
      ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => {
          const handler = handlers.get(channel);
          if (!handler) throw new Error(`no handler for ${channel}`);
          return handler({}, ...args);
        },
        on: noop,
        removeListener: noop,
      },
      webUtils: { getPathForFile: () => '' },
      dialog: { showOpenDialog: noop, showMessageBox: noop },
      shell: { openExternal: noop, trashItem: noop, showItemInFolder: noop },
      BrowserWindow: class {},
      nativeTheme: { on: noop, themeSource: 'system', shouldUseDarkColors: false },
    },
    children: [], paths: [],
  } as unknown as NodeModule;

  const cacheRoot = path.join(process.cwd(), 'node_modules', '.cache');
  fs.mkdirSync(cacheRoot, { recursive: true });
  const workspaceRoot = fs.mkdtempSync(path.join(cacheRoot, 'wp10b-ipc-'));
  fs.mkdirSync(path.join(workspaceRoot, '.lares'));

  try {
    const bridge = require('../ipc-handlers') as typeof import('../ipc-handlers');
    const proxy = new Proxy({}, { get: () => noop });
    bridge.registerIpcHandlers(proxy as any, proxy as any, {} as any);
    const productionHandler = handlers.get(bridge.RESEARCH_LIST_INBOX_REPORTS_CHANNEL);
    assert.ok(productionHandler, 'REACHABILITY:registerIpcHandlers:research:list-inbox-reports');
    await assert.rejects(
      () => productionHandler({}, { absInboxDir: 'C:\\renderer-controlled' }),
      /non-empty workspaceId/,
    );

    let listedPath = '';
    bridge.registerResearchInboxIpc(
      ipcMain as any,
      (workspaceId) => workspaceId === 'ws-1'
        ? { path: workspaceRoot, pathType: 'windows' }
        : null,
      async (inboxDir) => {
        listedPath = inboxDir;
        return [{
          status: 'ok', relPath: 'historical/report.md',
          frontmatter: {
            id: 'research-duplicate-id', topic: 'Topic', created: '2026-08-15',
            source_urls: ['https://example.com'], trust: 'untrusted', summary: 'Summary',
          },
        }];
      },
    );
    const mapped = await handlers.get(bridge.RESEARCH_LIST_INBOX_REPORTS_CHANNEL)!({}, 'ws-1');
    assert.equal(listedPath, path.join(workspaceRoot, '.lares', 'research', 'inbox'));
    assert.deepEqual(mapped, [{
      status: 'ok', relPath: 'historical/report.md',
      filePath: path.join(workspaceRoot, '.lares', 'research', 'inbox', 'historical', 'report.md'),
      artifactId: 'research-duplicate-id', topic: 'Topic', created: '2026-08-15', summary: 'Summary',
    }]);
    assert.equal('id' in mapped[0], false, 'wire DTO maps id to artifactId');

    require('../../preload/index');
    assert.equal(typeof exposedApi?.research?.listInboxReports, 'function',
      'REACHABILITY:preload:research.listInboxReports');
    const throughPreload = await exposedApi.research.listInboxReports('ws-1');
    assert.deepEqual(throughPreload, mapped);
    await assert.rejects(
      () => exposedApi.research.listInboxReports({ absInboxDir: 'C:\\renderer-controlled' }),
      /non-empty workspaceId/,
    );
    console.log('research inbox production registration + preload entry: passed');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    if (priorElectron) require.cache[electronPath] = priorElectron; else delete require.cache[electronPath];
  }
})().catch((error) => { console.error(error); process.exit(1); });
