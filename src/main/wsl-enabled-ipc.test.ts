import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const handlers = new Map<string, (...args: any[]) => any>();
const invocations: Array<[string, ...unknown[]]> = [];
let exposedApi: any;
const noop = () => undefined;
const electronPath = require.resolve('electron');
const priorElectron = require.cache[electronPath];
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => { invocations.push([channel, ...args]); return Promise.resolve(); },
      on: noop, removeListener: noop,
    },
    contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { exposedApi = api; } },
    app: { getPath: () => '', isPackaged: false, on: noop },
    dialog: { showOpenDialog: noop, showMessageBox: noop },
    shell: { openExternal: noop, trashItem: noop },
    BrowserWindow: class {},
    nativeTheme: { on: noop, themeSource: 'system', shouldUseDarkColors: false },
  },
  children: [],
  paths: [],
} as any;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wsl-ipc-'));
let resetWslProcessDeps: (() => void) | null = null;

(async () => {
  try {
    const setting = require('./wsl-enabled') as typeof import('./wsl-enabled');
    const wslBridge = require('./wsl-bridge') as typeof import('./wsl-bridge');
    let shutdownCalls = 0;
    const rawWslArgs: string[][] = [];
    wslBridge.__setWslProcessDepsForTest({
      execFile: ((file: string, args: string[], _opts: unknown, callback: (...args: any[]) => void) => {
        shutdownCalls++;
        rawWslArgs.push(args);
        assert.equal(file, 'wsl.exe');
        assert.deepEqual(args, ['--shutdown']);
        callback(null, '', '');
      }) as any,
    });
    resetWslProcessDeps = () => wslBridge.__setWslProcessDepsForTest(null);
    setting.__setWslEnabledStoragePathForTest(path.join(root, 'wsl-enabled.json'));
    const database = require('./database') as typeof import('./database');
    (database as any).getWorkspace = () => ({ id: 'wsl-ws', path: '/home/test', pathType: 'wsl' });
    (database as any).getWorkspaces = () => [{ id: 'wsl-ws', path: '/home/test', pathType: 'wsl' }];
    (database as any).getAllAgents = () => [];

    let launchCalls = 0;
    const stoppedAgentIds: string[] = [];
    const supervisor = new Proxy({
      launchAgent: () => { launchCalls++; },
      stopAgent: async (id: string) => { stoppedAgentIds.push(id); },
    }, { get: (target, key) => (target as any)[key] ?? noop });
    const windowProxy = new Proxy({}, { get: () => noop });
    const { registerIpcHandlers } = require('./ipc-handlers') as typeof import('./ipc-handlers');
    registerIpcHandlers(supervisor as any, windowProxy as any, {} as any);
    require('../preload');

    const getEnabled = handlers.get('system:get-wsl-enabled');
    const setEnabled = handlers.get('system:set-wsl-enabled');
    const launch = handlers.get('agent:launch');
    const shutdown = handlers.get('system:shutdown-wsl');
    assert.ok(getEnabled && setEnabled && launch && shutdown, 'production registration exposes WSL setting, shutdown, and launch gate');
    assert.equal(await getEnabled!({}), true);
    (database as any).getAllAgents = () => [{ id: 'live-wsl', workspaceId: 'wsl-ws', status: 'working' }];
    await setEnabled!({}, false);
    assert.equal(await getEnabled!({}), false);
    assert.deepEqual(stoppedAgentIds, ['live-wsl'], 'disable uses the supervisor normal stop path');
    assert.equal(shutdownCalls, 1, 'disable shuts WSL down after live agents stop');
    assert.throws(() => launch!({}, { workspaceId: 'wsl-ws' }), /WSL is disabled in Lares/);
    assert.equal(launchCalls, 0, 'disabled WSL launch never reaches the supervisor');
    await setEnabled!({}, true);
    (database as any).getAllAgents = () => [];
    await setEnabled!({}, false);
    assert.equal(shutdownCalls, 2, 'disable with no live WSL agents shuts down immediately');
    assert.deepEqual(rawWslArgs, [['--shutdown'], ['--shutdown']], 'disable uses raw wsl.exe --shutdown, never gated wslExec');
    await exposedApi.system.getWslEnabled();
    await exposedApi.system.setWslEnabled(true);
    await exposedApi.system.shutdownWsl();
    assert.deepEqual(invocations.slice(-3), [
      ['system:get-wsl-enabled'],
      ['system:set-wsl-enabled', true],
      ['system:shutdown-wsl'],
    ]);
    console.log('wsl-enabled-ipc: 12/12 passed');
    console.log('REACHABILITY:wsl-enabled-toggle real IPC registration and launch gate entered');
  } finally {
    const setting = require('./wsl-enabled') as typeof import('./wsl-enabled');
    setting.__setWslEnabledStoragePathForTest(null);
    resetWslProcessDeps?.();
    fs.rmSync(root, { recursive: true, force: true });
    if (priorElectron) require.cache[electronPath] = priorElectron;
    else delete require.cache[electronPath];
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
