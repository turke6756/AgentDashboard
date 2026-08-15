import assert from 'node:assert/strict';
import { PLAN_BADGES_INVALIDATED } from '../shared/types';
import type {
  BadgeInvalidationCoordinator as BadgeInvalidationCoordinatorType,
  BadgeInvalidationWindow,
} from './badge-invalidation';

interface ScheduledTask {
  id: number;
  callback: () => void;
  dueAt: number;
}

class FakeScheduler {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, ScheduledTask>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { id, callback, dueAt: this.now + delayMs });
    return id;
  }

  clearTimeout(id: number): void {
    this.tasks.delete(id);
  }

  advanceBy(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks.values()]
        .filter((task) => task.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
      if (!next) break;
      this.now = next.dueAt;
      this.tasks.delete(next.id);
      next.callback();
    }
    this.now = target;
  }

  get size(): number {
    return this.tasks.size;
  }
}

const sent: Array<{ name: string; channel: string; payload: unknown }> = [];
function fakeWindow(
  name: string,
  windowDestroyed = false,
  contentsDestroyed = false,
  sendThrows = false,
): BadgeInvalidationWindow {
  return {
    isDestroyed: () => windowDestroyed,
    webContents: {
      isDestroyed: () => contentsDestroyed,
      send: (channel, payload) => {
        if (sendThrows) throw new Error('window disposed during send');
        sent.push({ name, channel, payload });
      },
    },
  };
}

const electronPath = require.resolve('electron');
const modulePath = require.resolve('./badge-invalidation');
const preloadPath = require.resolve('../preload/index');
const priorElectron = require.cache[electronPath];
const priorModule = require.cache[modulePath];
const priorPreload = require.cache[preloadPath];
const windows = [
  fakeWindow('main'),
  fakeWindow('disposed-during-send', false, false, true),
  fakeWindow('detached-view'),
  fakeWindow('detached-file'),
  fakeWindow('destroyed-window', true),
  fakeWindow('destroyed-web-contents', false, true),
];
const listeners = new Map<string, (...args: unknown[]) => void>();
const removed: Array<{ channel: string; listener: (...args: unknown[]) => void }> = [];
let exposedApi: any;
const noop = () => undefined;

require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    BrowserWindow: { getAllWindows: () => windows },
    contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { exposedApi = api; } },
    ipcRenderer: {
      invoke: noop,
      on: (channel: string, listener: (...args: unknown[]) => void) => listeners.set(channel, listener),
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => removed.push({ channel, listener }),
    },
    webUtils: { getPathForFile: () => '' },
  },
  children: [],
  paths: [],
} as any;
delete require.cache[modulePath];
delete require.cache[preloadPath];

try {
  const {
    BadgeInvalidationCoordinator,
    BADGE_INVALIDATION_QUIET_WINDOW_MS,
    broadcastPlanBadgesInvalidated,
  } = require('./badge-invalidation') as typeof import('./badge-invalidation');

  const deliveryScheduler = new FakeScheduler();
  const deliveryCoordinator = new BadgeInvalidationCoordinator({
    scheduler: deliveryScheduler,
    broadcast: broadcastPlanBadgesInvalidated,
  });
  deliveryCoordinator.notify('workspace-a');
  deliveryCoordinator.notify('workspace-a');
  deliveryCoordinator.notify('workspace-a');
  assert.doesNotThrow(
    () => deliveryScheduler.advanceBy(BADGE_INVALIDATION_QUIET_WINDOW_MS),
    'a racy send failure must not escape the coalesced timer callback',
  );
  assert.deepEqual(sent, [
    { name: 'main', channel: PLAN_BADGES_INVALIDATED, payload: { workspaceId: 'workspace-a' } },
    { name: 'detached-view', channel: PLAN_BADGES_INVALIDATED, payload: { workspaceId: 'workspace-a' } },
    { name: 'detached-file', channel: PLAN_BADGES_INVALIDATED, payload: { workspaceId: 'workspace-a' } },
  ], 'REACHABILITY:badge-invalidation-broadcast');

  const scheduler = new FakeScheduler();
  const broadcasts: string[] = [];
  const coordinator: BadgeInvalidationCoordinatorType<number> = new BadgeInvalidationCoordinator({
    scheduler,
    broadcast: (workspaceId) => broadcasts.push(workspaceId),
  });
  coordinator.notify('workspace-a');
  scheduler.advanceBy(200);
  coordinator.notify('workspace-a');
  coordinator.notify('workspace-b');
  assert.equal(scheduler.size, 2, 'one pending timer per workspace');
  scheduler.advanceBy(BADGE_INVALIDATION_QUIET_WINDOW_MS - 1);
  assert.deepEqual(broadcasts, [], 'the replaced timer must not fire at the first notify deadline');
  scheduler.advanceBy(1);
  assert.deepEqual(broadcasts, ['workspace-a', 'workspace-b'], 'many notifies coalesce to one trailing broadcast per workspace');

  const stoppedScheduler = new FakeScheduler();
  const stoppedBroadcasts: string[] = [];
  const stoppedCoordinator = new BadgeInvalidationCoordinator({
    scheduler: stoppedScheduler,
    broadcast: (workspaceId) => stoppedBroadcasts.push(workspaceId),
  });
  stoppedCoordinator.notify('workspace-a');
  stoppedCoordinator.notify('workspace-b');
  stoppedCoordinator.stop();
  assert.equal(stoppedScheduler.size, 0, 'stop clears and empties all pending timers');
  stoppedCoordinator.notify('workspace-c');
  assert.equal(stoppedScheduler.size, 0, 'notify after stop is a no-op');
  stoppedCoordinator.stop();
  assert.equal(stoppedScheduler.size, 0, 'a second stop is a safe no-op');
  stoppedScheduler.advanceBy(10_000);
  assert.deepEqual(stoppedBroadcasts, [], 'nothing fires after terminal stop');

  const inFlightScheduler = new FakeScheduler();
  const inFlightBroadcasts: string[] = [];
  let notifiedDuringBroadcast = false;
  const inFlightCoordinator = new BadgeInvalidationCoordinator({
    scheduler: inFlightScheduler,
    broadcast: (workspaceId) => {
      inFlightBroadcasts.push(workspaceId);
      if (!notifiedDuringBroadcast) {
        notifiedDuringBroadcast = true;
        inFlightCoordinator.notify(workspaceId);
      }
    },
  });
  inFlightCoordinator.notify('workspace-a');
  inFlightScheduler.advanceBy(BADGE_INVALIDATION_QUIET_WINDOW_MS);
  assert.deepEqual(inFlightBroadcasts, ['workspace-a']);
  assert.equal(inFlightScheduler.size, 1, 'notify during broadcast schedules a fresh trailing window');
  inFlightScheduler.advanceBy(BADGE_INVALIDATION_QUIET_WINDOW_MS);
  assert.deepEqual(inFlightBroadcasts, ['workspace-a', 'workspace-a']);

  require('../preload/index');
  let received: unknown;
  const unsubscribe = exposedApi.agents.onPlanBadgesInvalidated((payload: unknown) => { received = payload; });
  const listener = listeners.get(PLAN_BADGES_INVALIDATED);
  assert.ok(listener, 'preload registers the badge invalidation channel');
  listener({}, { workspaceId: 'workspace-a' });
  assert.deepEqual(received, { workspaceId: 'workspace-a' });
  unsubscribe();
  assert.equal(removed.length, 1);
  assert.equal(removed[0].channel, PLAN_BADGES_INVALIDATED);
  assert.equal(removed[0].listener, listener, 'unsubscribe removes the exact registered listener');

  console.log('  ok  badge invalidation acceptance (coalescing, terminal stop, broadcaster, preload)');
  console.log('REACHABILITY:badge-invalidation-broadcast entering test executes coordinator delivery seam');
} finally {
  if (priorElectron) require.cache[electronPath] = priorElectron; else delete require.cache[electronPath];
  if (priorModule) require.cache[modulePath] = priorModule; else delete require.cache[modulePath];
  if (priorPreload) require.cache[preloadPath] = priorPreload; else delete require.cache[preloadPath];
}
