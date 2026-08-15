// WP-8: production-entry coverage for the targeted detached Plans reveal.
// Enters through createDetachedViewWindow, captures the registered
// plans:revealInDetached handler, and exercises request/ack cleanup behavior.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  __pendingPlansRevealCountForTest,
  __resetDetachedRegistryForTest,
  createDetachedViewWindow,
  type DetachedWindowDeps,
  type PlansRevealIpc,
  type PlansRevealTimer,
} from './detached-windows';
import {
  PLAN_DETACHED_REVEAL_CHANNELS,
  type PlanDetachedRevealAckPayload,
  type PlanDetachedRevealRequest,
  type ViewDetachRequest,
} from '../shared/types';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

type RequestHandler = (event: { sender: { id: number } }, request: PlanDetachedRevealRequest) => Promise<unknown>;
type AckHandler = (event: { sender: { id: number } }, payload: PlanDetachedRevealAckPayload) => void;

class FakeIpc implements PlansRevealIpc {
  requestHandler: RequestHandler | undefined;
  ackHandler: AckHandler | undefined;

  handle(channel: string, listener: unknown): void {
    assert.equal(channel, PLAN_DETACHED_REVEAL_CHANNELS.request);
    this.requestHandler = listener as RequestHandler;
  }

  on(channel: string, listener: unknown): this {
    assert.equal(channel, PLAN_DETACHED_REVEAL_CHANNELS.acknowledgement);
    this.ackHandler = listener as AckHandler;
    return this;
  }

  invoke(request: PlanDetachedRevealRequest): Promise<any> {
    assert.ok(this.requestHandler, 'production factory must register plans:revealInDetached');
    return this.requestHandler({ sender: { id: 1 } }, request);
  }

  acknowledge(senderId: number, payload: PlanDetachedRevealAckPayload): void {
    assert.ok(this.ackHandler, 'production factory must register plans:revealAck');
    this.ackHandler({ sender: { id: senderId } }, payload);
  }
}

class FakeTimer implements PlansRevealTimer {
  private nextId = 0;
  readonly callbacks = new Map<number, () => void>();
  clearCount = 0;

  set(callback: () => void, _timeoutMs: number): ReturnType<typeof setTimeout> {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clear(timer: ReturnType<typeof setTimeout>): void {
    if (this.callbacks.delete(timer as unknown as number)) this.clearCount++;
  }

  fireAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }

  reset(): void {
    this.callbacks.clear();
    this.clearCount = 0;
  }
}

interface SentMessage { channel: string; payload: unknown }

function makeWindow(id: number, webContentsId: number) {
  let destroyed = false;
  const windowListeners = new Map<string, () => void>();
  const contentsEvents = new EventEmitter();
  const sent: SentMessage[] = [];
  const webContents = {
    id: webContentsId,
    sent,
    setWindowOpenHandler() {},
    on(event: string, listener: () => void) { contentsEvents.on(event, listener); },
    once(event: string, listener: () => void) { contentsEvents.once(event, listener); },
    removeListener(event: string, listener: () => void) { contentsEvents.removeListener(event, listener); },
    listenerCount(event: string) { return contentsEvents.listenerCount(event); },
    send(channel: string, payload: unknown) { sent.push({ channel, payload }); },
    isDestroyed() { return destroyed; },
    destroy() {
      destroyed = true;
      contentsEvents.emit('destroyed');
    },
  };
  const win = {
    id,
    webContents,
    focusCount: 0,
    focus() { this.focusCount++; },
    loadURL() {},
    loadFile() {},
    isDestroyed() { return destroyed; },
    on(event: string, listener: () => void) { windowListeners.set(event, listener); },
    close() {
      windowListeners.get('close')?.();
      webContents.destroy();
      windowListeners.get('closed')?.();
    },
  };
  return win;
}

const ipc = new FakeIpc();
const timer = new FakeTimer();
let nextWindowId = 10;
let nextContentsId = 100;

function createView(view: ViewDetachRequest['view'], workspaceId = 'ws-1') {
  const win = makeWindow(nextWindowId++, nextContentsId++);
  const deps: DetachedWindowDeps = {
    devServerUrl: 'http://localhost:5173',
    builtIndexHtml: 'index.html',
    theme: 'dark',
    trustedContents: new Set(),
    setConstructingDetached: () => {},
    getMainWindow: () => null,
    createWindow: () => win as unknown as Electron.BrowserWindow,
    installSpellcheckContextMenu: () => {},
    plansRevealIpc: ipc,
    plansRevealTimeoutMs: 50,
    plansRevealTimer: timer,
  };
  const request: ViewDetachRequest = { view, workspaceId, label: view, x: 0, y: 0 };
  createDetachedViewWindow(request, deps);
  return win;
}

function revealRequest(requestId: string): PlanDetachedRevealRequest {
  return { workspaceId: 'ws-1', planId: 'plan-1', tab: 'proposal', requestId };
}

function reset(): void {
  __resetDetachedRegistryForTest();
  timer.reset();
}

test('production factory registers a targeted reveal and rejects a foreign-sender acknowledgement', async () => {
  reset();
  const dashboard = createView('dashboard');
  const plans = createView('plans');
  const request = revealRequest('opaque-ack');
  const result = ipc.invoke(request);

  assert.equal(dashboard.webContents.sent.length, 0, 'must not broadcast to another detached view');
  assert.deepEqual(plans.webContents.sent, [{
    channel: PLAN_DETACHED_REVEAL_CHANNELS.reveal,
    payload: request,
  }]);
  assert.equal(plans.focusCount, 1);
  assert.equal(__pendingPlansRevealCountForTest(), 1);

  let settled = false;
  void result.then(() => { settled = true; });
  ipc.acknowledge(plans.webContents.id + 1, { requestId: request.requestId, ok: true });
  await Promise.resolve();
  assert.equal(settled, false, 'wrong webContents sender cannot satisfy the request');
  assert.equal(__pendingPlansRevealCountForTest(), 1);
  ipc.acknowledge(plans.webContents.id, { requestId: 'different-request', ok: true });
  await Promise.resolve();
  assert.equal(settled, false, 'wrong requestId cannot satisfy the request');
  assert.equal(__pendingPlansRevealCountForTest(), 1);

  ipc.acknowledge(plans.webContents.id, { requestId: request.requestId, ok: true });
  assert.deepEqual(await result, { ok: true });
  assert.equal(__pendingPlansRevealCountForTest(), 0);
  assert.equal(timer.callbacks.size, 0, 'ack clears its timer');
  assert.equal(timer.clearCount, 1);
  assert.equal(plans.webContents.listenerCount('destroyed'), 0, 'ack removes destroyed listener');
});

test('timeout deletes the entry and a late acknowledgement is a no-op', async () => {
  reset();
  const plans = createView('plans');
  const request = revealRequest('opaque-timeout');
  const result = ipc.invoke(request);
  assert.equal(__pendingPlansRevealCountForTest(), 1);
  timer.fireAll();
  assert.deepEqual(await result, { ok: false, reason: 'timeout' });
  assert.equal(__pendingPlansRevealCountForTest(), 0);
  assert.equal(plans.webContents.listenerCount('destroyed'), 0, 'timeout removes destroyed listener');

  ipc.acknowledge(plans.webContents.id, { requestId: request.requestId, ok: true });
  assert.equal(__pendingPlansRevealCountForTest(), 0, 'late ack cannot recreate an entry');

  const reuse = ipc.invoke(request);
  ipc.acknowledge(plans.webContents.id, { requestId: request.requestId, ok: true });
  assert.deepEqual(await reuse, { ok: true }, 'the timed-out request id was fully deleted');
  assert.equal(timer.callbacks.size, 0);
});

test('a superseded acknowledgement settles without becoming a timeout recovery', async () => {
  reset();
  const plans = createView('plans');
  const request = revealRequest('opaque-superseded');
  const result = ipc.invoke(request);
  ipc.acknowledge(plans.webContents.id, {
    requestId: request.requestId,
    ok: false,
    reason: 'superseded',
  });
  assert.deepEqual(await result, { ok: false, reason: 'superseded' });
  assert.equal(__pendingPlansRevealCountForTest(), 0);
  assert.equal(timer.callbacks.size, 0);
  assert.equal(plans.webContents.listenerCount('destroyed'), 0);
});

test('window-not-found creates neither a pending entry nor a timer', async () => {
  reset();
  assert.deepEqual(await ipc.invoke(revealRequest('opaque-missing')), {
    ok: false,
    reason: 'window-not-found',
  });
  assert.equal(__pendingPlansRevealCountForTest(), 0);
  assert.equal(timer.callbacks.size, 0);
});

test('target destruction mid-flight clears timer and entry and resolves window-not-found', async () => {
  reset();
  const plans = createView('plans');
  const result = ipc.invoke(revealRequest('opaque-destroyed'));
  assert.equal(__pendingPlansRevealCountForTest(), 1);
  plans.webContents.destroy();
  assert.deepEqual(await result, { ok: false, reason: 'window-not-found' });
  assert.equal(__pendingPlansRevealCountForTest(), 0);
  assert.equal(timer.callbacks.size, 0);
  assert.equal(timer.clearCount, 1);
  assert.equal(plans.webContents.listenerCount('destroyed'), 0, 'destroy event leaves no listener');
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const current of tests) {
    try {
      await current.run();
      console.log(`  ok  ${current.name}`);
      passed++;
    } catch (error) {
      console.error(`  FAIL ${current.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
