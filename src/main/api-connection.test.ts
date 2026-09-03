import assert from 'node:assert/strict';

const handlers = new Map<string, (...args: any[]) => any>();
const noop = () => undefined;
const electronPath = require.resolve('electron');
const priorElectron = require.cache[electronPath];

require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
    app: { getPath: () => '', isPackaged: false, on: noop },
    dialog: { showOpenDialog: noop, showMessageBox: noop },
    shell: { openExternal: noop, trashItem: noop },
    BrowserWindow: class {},
    nativeTheme: { on: noop, themeSource: 'system', shouldUseDarkColors: false },
  },
  children: [],
  paths: [],
} as any;

(async () => {
  try {
    const { createApiConnectionGate, startApiAndPublishPort } = require('./api-connection') as typeof import('./api-connection');
    const { registerIpcHandlers } = require('./ipc-handlers') as typeof import('./ipc-handlers');
    const gate = createApiConnectionGate();
    const proxy = new Proxy({}, { get: () => noop });
    registerIpcHandlers(proxy as any, proxy as any, {} as any, gate);

    const handler = handlers.get('system:get-api-connection');
    assert.ok(handler, 'REACHABILITY:wp3-api-connection-gate handler must be registered');

    let settled = false;
    const pendingConnection = Promise.resolve(handler({})).then((connection) => {
      settled = true;
      return connection;
    });
    await Promise.resolve();
    assert.equal(settled, false, 'REACHABILITY:wp3-api-connection-gate must wait for port publication');

    const events: string[] = [];
    const published = await startApiAndPublishPort(
      { start: async () => { events.push('start'); return 24682; } },
      { setApiServerPort: (port: number) => events.push(`set:${port}`) },
      gate,
    );
    const connection = await pendingConnection;
    events.push('ready');

    assert.deepEqual(connection, { port: 24682, token: published.token });
    assert.equal(typeof connection.token, 'string');
    assert.ok(connection.token.length > 0);
    assert.deepEqual(events, ['start', 'set:24682', 'ready']);
    console.log('  ok  API connection readiness gate (1 test)');
    console.log('REACHABILITY:wp3-api-connection-gate real IPC handler awaits publication');
  } finally {
    if (priorElectron) require.cache[electronPath] = priorElectron;
    else delete require.cache[electronPath];
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
