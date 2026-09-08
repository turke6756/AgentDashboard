import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { publishLibraryBroadcast, registerProductionLibraryIpc, resetLibraryBroadcastForTests } from './library-ipc';
import {
  createLibraryMainWindowInteractiveBarrier,
  startLibraryStartupCatchup,
  type LibraryStartupScheduler,
} from './library-startup-catchup';

class FakeWebContents extends EventEmitter {
  url = '';
  loading = true;
  getURL(): string { return this.url; }
  isLoadingMainFrame(): boolean { return this.loading; }
}

class FakeScheduler implements LibraryStartupScheduler {
  callback: (() => void) | null = null;
  cleared = false;
  setTimeout(callback: () => void): unknown { this.callback = callback; return 1; }
  clearTimeout(): void { this.cleared = true; this.callback = null; }
  fire(): void { this.callback?.(); }
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

test('startup catch-up waits for both barriers, runs once, and isolates workspace failure', async () => {
  const watcher = deferred();
  const interactive = deferred();
  const calls: Array<{ id: string; initiator: string }> = [];
  const logs: string[] = [];
  const catchup = startLibraryStartupCatchup({
    watcherAttached: watcher.promise,
    mainWindowInteractive: interactive.promise,
    listWorkspaceIds: () => ['one', 'broken', 'two'],
    coordinator: { run: async (id, initiator) => { calls.push({ id, initiator }); if (id === 'broken') throw new Error('poison'); return { scanned: 0, ingested: 0, skipped: 0, failed: 0 }; } },
    log: (message) => logs.push(message),
  });
  watcher.resolve(); await flush();
  assert.deepEqual(calls, [], 'REACHABILITY:library:startup-catchup must wait for main-window interactivity');
  interactive.resolve(); await catchup.done;
  assert.deepEqual(calls, [
    { id: 'one', initiator: 'automatic' },
    { id: 'broken', initiator: 'automatic' },
    { id: 'two', initiator: 'automatic' },
  ], 'REACHABILITY:library:startup-catchup must enter automatic coordinator runs after both barriers');
  assert.equal(logs.length, 1);
});

test('failed load and diagnostic timeout do not release the interactive barrier, but a later success does', async () => {
  const webContents = new FakeWebContents();
  const scheduler = new FakeScheduler();
  const logs: string[] = [];
  let resolved = false;
  const barrier = createLibraryMainWindowInteractiveBarrier(webContents, { scheduler, log: (message) => logs.push(message) });
  barrier.then(() => { resolved = true; });
  webContents.emit('did-fail-load');
  scheduler.fire();
  await flush();
  assert.equal(resolved, false, 'diagnostic timeout and did-fail-load must not release startup');
  assert.equal(logs.length, 1);
  webContents.url = 'http://localhost:5173';
  webContents.loading = false;
  webContents.emit('did-finish-load');
  await barrier;
  assert.equal(resolved, true);
});

test('an already loaded non-empty main frame resolves immediately', async () => {
  const webContents = new FakeWebContents();
  webContents.url = 'file:///app/index.html';
  webContents.loading = false;
  const scheduler = new FakeScheduler();
  await createLibraryMainWindowInteractiveBarrier(webContents, { scheduler });
  assert.equal(scheduler.cleared, true);
});

test('startup progress reaches the production broadcaster with the resolved workspace id', async () => {
  resetLibraryBroadcastForTests();
  const delivered: unknown[] = [];
  registerProductionLibraryIpc({ handle: () => undefined }, () => null, (event) => delivered.push(event));
  const catchup = startLibraryStartupCatchup({
    watcherAttached: Promise.resolve(), mainWindowInteractive: Promise.resolve(), listWorkspaceIds: () => ['workspace-1'],
    coordinator: { run: async (workspaceId, initiator) => {
      assert.equal(initiator, 'automatic');
      publishLibraryBroadcast({ workspace_id: workspaceId, document_id: 'doc', status: 'queued', attempt_count: 1 });
      return { scanned: 1, ingested: 0, skipped: 0, failed: 1 };
    } },
  });
  await catchup.done;
  assert.deepEqual(delivered, [{ workspace_id: 'workspace-1', document_id: 'doc', status: 'queued', attempt_count: 1 }]);
});
