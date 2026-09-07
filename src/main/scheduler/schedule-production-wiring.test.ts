import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SCHEDULE_CHANNELS } from '../../shared/types';

const handlers = new Map<string, (...args: any[]) => any>();
const sent: Array<{ channel: string; payload: unknown }> = [];
const noop = () => undefined;
const electronPath = require.resolve('electron');
const ipcHandlersPath = require.resolve('../ipc-handlers');
const priorElectron = require.cache[electronPath];
const priorHandlers = require.cache[ipcHandlersPath];

require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    ipcMain: {
      handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler),
      on: noop,
    },
    app: { getPath: () => '', isPackaged: false, on: noop },
    dialog: { showOpenDialog: noop, showMessageBox: noop },
    shell: { openExternal: noop, trashItem: noop },
    BrowserWindow: class {},
    nativeTheme: { on: noop, themeSource: 'system', shouldUseDarkColors: false },
    nativeImage: { createFromPath: noop },
    powerMonitor: { on: noop },
  },
  children: [],
  paths: [],
} as any;
delete require.cache[ipcHandlersPath];

(async () => {
  try {
    const { registerIpcHandlers } = require('../ipc-handlers') as typeof import('../ipc-handlers');
    const schedule = {
      id: 'schedule-1', agentId: 'agent-1', message: 'hello',
      recurrence: { kind: 'interval', everyMs: 60_000 }, stopping: { kind: 'manual' },
      enabled: true, lifecycle: 'active', nextFireAt: 61_000, revision: 1,
      occurrenceCount: 0, fireCount: 0, lastFiredAt: null, lastOutcome: null,
      lastNotificationRoute: null,
    };
    const scheduler = {
      summaries: () => [],
      setSchedule: () => schedule,
      getSchedule: () => schedule,
      clearSchedule: () => true,
      history: () => [],
    };
    const supervisor = new Proxy({}, { get: () => noop });
    const mainWindow = new Proxy({
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    }, { get: (target, key) => Reflect.get(target, key) ?? noop });
    registerIpcHandlers(supervisor as any, mainWindow as any, {} as any, undefined, scheduler as any);

    assert.ok(handlers.has(SCHEDULE_CHANNELS.hydrate), 'production registerIpcHandlers must register schedule:hydrate');
    assert.ok(handlers.has(SCHEDULE_CHANNELS.set), 'production registerIpcHandlers must register schedule:set');
    handlers.get(SCHEDULE_CHANNELS.set)!({}, 'agent-1', {
      message: 'hello', recurrence: { kind: 'interval', everyMs: 60_000 },
      stopping: { kind: 'manual' }, enabled: true, revision: null,
    });
    assert.equal(sent.at(-1)?.channel, SCHEDULE_CHANNELS.changed, 'production set handler must reach schedule:changed');

    const source = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8');
    const bootstrapAt = source.indexOf('agentScheduler = bootstrapAgentScheduler({');
    const registerAt = source.indexOf('registerIpcHandlers(supervisor, mainWindow!, detachedWindowDeps, apiConnectionGate, agentScheduler, scheduleBroadcast);');
    assert.ok(bootstrapAt >= 0, 'REACHABILITY:cron-bootstrap-index must retain the production bootstrap assignment');
    assert.ok(registerAt > bootstrapAt, 'the scheduler bootstrap result must feed registerIpcHandlers in boot order');
    const stopAt = source.indexOf('agentScheduler?.stop();');
    const supervisorStopAt = source.indexOf('supervisor?.stop();', stopAt);
    assert.ok(stopAt >= 0 && supervisorStopAt > stopAt, 'shutdown must stop the scheduler before the supervisor');

    console.log('  ok  schedule production IPC and bootstrap wiring (1 test)');
  } finally {
    if (priorElectron) require.cache[electronPath] = priorElectron;
    else delete require.cache[electronPath];
    if (priorHandlers) require.cache[ipcHandlersPath] = priorHandlers;
    else delete require.cache[ipcHandlersPath];
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
