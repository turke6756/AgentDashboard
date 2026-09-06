import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { FsEvent, Workspace } from '../../shared/types';
import { LIBRARY_CHANNELS, registerProductionLibraryIpc } from './library-ipc';
import {
  LIBRARY_REPORT_COALESCE_MS,
  LIBRARY_REPORT_REFRESH_MS,
  LIBRARY_REPORT_SETTLE_MS,
  LibraryReportWatcher,
  startLibraryReportWatcher,
  type LibraryReportWatcherOptions,
  type LibraryReportWatcherScheduler,
} from './library-report-watcher';
import type { LibraryReportRootInventory, LibraryReportSourcesInventory } from './library-report-sources';
import type { LibraryDocumentRow, LibraryStore } from './library-store';

class FakeScheduler implements LibraryReportWatcherScheduler {
  now = 0;
  private nextId = 1;
  private timers = new Map<number, { due: number; callback: () => void; interval?: number }>();
  setTimeout(callback: () => void, delayMs: number): unknown { const id = this.nextId++; this.timers.set(id, { due: this.now + delayMs, callback }); return id; }
  clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  setInterval(callback: () => void, delayMs: number): unknown { const id = this.nextId++; this.timers.set(id, { due: this.now + delayMs, callback, interval: delayMs }); return id; }
  clearInterval(timer: unknown): void { this.timers.delete(timer as number); }
  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.due;
      if (timer.interval) timer.due += timer.interval; else this.timers.delete(id);
      timer.callback();
    }
    this.now = target;
  }
  pendingDelays(): number[] { return [...this.timers.values()].map((timer) => timer.due - this.now).sort((a, b) => a - b); }
}

const workspace: Workspace = { id: 'workspace-1', title: 'Workspace', path: 'C:\\repo', pathType: 'windows', description: '', defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: null };
const fakeStore = {} as LibraryStore;
const emptyRoot = (root: 'inbox' | 'cleared', health: 'complete' | 'incomplete' = 'complete'): LibraryReportRootInventory => ({ root, root_path: path.join(workspace.path, '.lares', 'library', root), files: [], directories: [{ abs_path: path.join(workspace.path, '.lares', 'library', root), pathType: 'windows' }], health });
const inventory = (files: Array<{ root: 'inbox' | 'cleared'; name: string; size: number; mtimeMs: number }> = [], health: Partial<Record<'inbox' | 'cleared', 'complete' | 'incomplete'>> = {}): LibraryReportSourcesInventory => {
  const result = { inbox: emptyRoot('inbox', health.inbox), cleared: emptyRoot('cleared', health.cleared) };
  for (const file of files) result[file.root].files.push({ rel_path: file.name, abs_path: path.join(result[file.root].root_path, file.name), size: file.size, mtimeMs: file.mtimeMs });
  return result;
};

async function flush(): Promise<void> { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }

function harness(overrides: Partial<LibraryReportWatcherOptions> = {}) {
  const scheduler = new FakeScheduler();
  let current = inventory();
  const listeners: Array<(event: FsEvent) => void> = [];
  const subscriptions: string[] = [];
  let unsubscribed = 0;
  const ingests: Array<{ sourcePath: string; trigger: string }> = [];
  const events: unknown[] = [];
  const watcher = new LibraryReportWatcher({
    now: () => scheduler.now,
    scheduler,
    getWorkspaces: () => [workspace],
    inventory: async () => current,
    subscribe: (directory, _pathType, listener) => { subscriptions.push(directory); listeners.push(listener); return () => { unsubscribed += 1; }; },
    openStore: () => fakeStore,
    closeStore: () => undefined,
    listDocuments: () => [],
    deleteDocuments: () => 0,
    ingest: async ({ sourcePath, trigger }) => { ingests.push({ sourcePath, trigger }); },
    publish: (event) => events.push(event),
    ensureDirectory: () => undefined,
    log: () => undefined,
    ...overrides,
  });
  return { watcher, scheduler, listeners, subscriptions, ingests, events, setInventory: (next: LibraryReportSourcesInventory) => { current = next; }, getUnsubscribed: () => unsubscribed };
}

test('production start seam attaches recursively, settles a write burst once, and stops every resource', async () => {
  const scheduler = new FakeScheduler();
  const order: string[] = [];
  const nested = path.join(workspace.path, '.lares', 'library', 'inbox', 'nested');
  let current = inventory([{ root: 'inbox', name: 'nested/report.md', size: 10, mtimeMs: 1 }]);
  current.inbox.directories.push({ abs_path: nested, pathType: 'windows' });
  const listeners: Array<(event: FsEvent) => void> = [];
  const ingests: Array<{ trigger: string }> = [];
  const pushes: unknown[] = [];
  let closes = 0;
  let enumerations = 0;
  const watcher = await startLibraryReportWatcher({
    now: () => scheduler.now, scheduler, getWorkspaces: () => [workspace],
    inventory: async () => { enumerations += 1; order.push('enumerate'); return current; },
    subscribe: (directory, _pathType, listener) => { order.push(`subscribe:${directory}`); listeners.push(listener); return () => { closes += 1; }; },
    openStore: () => fakeStore, closeStore: () => undefined, listDocuments: () => [], deleteDocuments: () => 0,
    ingest: async ({ trigger }) => { ingests.push({ trigger }); }, publish: (event) => pushes.push(event), ensureDirectory: () => undefined, log: () => undefined,
  });
  assert.ok((order[0] ?? '').startsWith('subscribe:') && (order[1] ?? '').startsWith('subscribe:') && order[2] === 'enumerate', 'REACHABILITY:startLibraryReportWatcher did not enter production attach');
  assert.ok(order.indexOf(`subscribe:${nested}`) > order.indexOf('enumerate'));
  assert.equal(enumerations, 2, 'attach must re-enumerate after subscribing newly discovered directories');
  assert.equal(ingests.length, 0, 'immediate attachment re-enumeration must not satisfy settling');
  assert.ok(pushes.some((event) => (event as { type?: string }).type === LIBRARY_CHANNELS.shelfChanged), 'REACHABILITY:library:shelf-changed watcher did not publish pending report');

  scheduler.advance(100);
  current = inventory([{ root: 'inbox', name: 'nested/report.md', size: 20, mtimeMs: 2 }]);
  current.inbox.directories.push({ abs_path: nested, pathType: 'windows' });
  listeners[0]({ type: 'change', path: current.inbox.files[0].abs_path, parentDir: current.inbox.root_path });
  scheduler.advance(LIBRARY_REPORT_COALESCE_MS);
  await flush();
  assert.equal(ingests.length, 0);
  scheduler.advance(LIBRARY_REPORT_SETTLE_MS - 1);
  await flush();
  assert.equal(ingests.length, 0);
  scheduler.advance(LIBRARY_REPORT_SETTLE_MS + 1);
  await flush();
  assert.deepEqual(ingests, [{ trigger: 'report-arrival' }], 'a burst must produce exactly one report-arrival ingest');
  scheduler.advance(LIBRARY_REPORT_REFRESH_MS);
  await flush();
  assert.equal(ingests.length, 1);
  watcher.stop();
  assert.ok(closes >= 3);
  assert.deepEqual(scheduler.pendingDelays(), []);
});

test('shelf-changed production construct is emitted through the watcher publisher', async () => {
  const h = harness({ inventory: async () => inventory([{ root: 'inbox', name: 'arrival.md', size: 1, mtimeMs: 1 }]) });
  await h.watcher.start();
  assert.ok(h.events.some((event) => (event as { type?: string }).type === LIBRARY_CHANNELS.shelfChanged), 'REACHABILITY:library:shelf-changed watcher publisher was not reached');
  h.watcher.stop();
});

test('reconcile and ingest are single-flight and an event during ingest causes one dirty rerun', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  let maxActive = 0;
  let inventoryCalls = 0;
  const h = harness({
    inventory: async () => { inventoryCalls += 1; return inventory([{ root: 'inbox', name: 'a.md', size: 1, mtimeMs: 1 }, { root: 'cleared', name: 'b.md', size: 1, mtimeMs: 1 }]); },
    ingest: async ({ sourcePath }) => { active += 1; maxActive = Math.max(maxActive, active); if (sourcePath.endsWith('a.md')) await gate; active -= 1; h.ingests.push({ sourcePath, trigger: 'report-arrival' }); },
  });
  await h.watcher.start();
  h.scheduler.advance(LIBRARY_REPORT_SETTLE_MS);
  await flush();
  const beforeDirty = inventoryCalls;
  h.listeners[0]({ type: 'change', path: path.join(workspace.path, '.lares', 'library', 'inbox', 'a.md'), parentDir: workspace.path });
  h.scheduler.advance(LIBRARY_REPORT_COALESCE_MS);
  await flush();
  release();
  await flush();
  assert.equal(maxActive, 1, 'ingests must never interleave');
  assert.equal(h.ingests.length, 2);
  assert.equal(inventoryCalls, beforeDirty + 1, 'an in-flight event must collapse to exactly one dirty rerun');
  h.watcher.stop();
});

test('deletion is root-health-aware and never removes user-dropped rows', async () => {
  const watched = { source_rel_path: '.lares/library/inbox/gone.md' } as LibraryDocumentRow;
  const user = { source_rel_path: '.lares/library/sources/manual.md' } as LibraryDocumentRow;
  const deleted: string[][] = [];
  let current = inventory([], { inbox: 'incomplete' });
  const h = harness({ inventory: async () => current, listDocuments: () => [watched, user], deleteDocuments: (_store, paths) => { deleted.push([...paths]); return paths.length; } });
  await h.watcher.start();
  assert.deepEqual(deleted, []);
  current = inventory();
  h.listeners[0]({ type: 'unlink', path: path.join(workspace.path, '.lares', 'library', 'inbox', 'gone.md'), parentDir: workspace.path });
  h.scheduler.advance(LIBRARY_REPORT_COALESCE_MS);
  await flush();
  assert.deepEqual(deleted, [['.lares/library/inbox/gone.md']]);
  h.watcher.stop();
});

test('list-shelf and rescan reject empty workspace ids before workspace lookup', async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let resolutions = 0;
  registerProductionLibraryIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, () => { resolutions += 1; return null; }, () => undefined);
  assert.throws(() => handlers.get(LIBRARY_CHANNELS.listShelf)!({} as never, ''), /non-empty string/);
  assert.throws(() => handlers.get(LIBRARY_CHANNELS.rescan)!({} as never, '   '), /non-empty string/);
  assert.equal(resolutions, 0);
});
