import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  ensureJupyterServer,
  getJupyterServerInfo,
  onJupyterServerExit,
  registerJupyterServerExitDisposal,
  shutdownJupyterServer,
} from './jupyter-server';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    return true;
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for fake Jupyter child');
}

function emitReady(child: FakeChild, port: number): void {
  child.stdout.emit('data', Buffer.from(`http://127.0.0.1:${port}/lab`));
}

async function withFakeChildren(run: (children: FakeChild[]) => Promise<void>): Promise<void> {
  const bridge = require('./wsl-bridge') as {
    wslSpawn: (command: string) => ChildProcess;
    wslExec: (command: string) => Promise<unknown>;
  };
  const originalSpawn = bridge.wslSpawn;
  const originalExec = bridge.wslExec;
  const children: FakeChild[] = [];
  await shutdownJupyterServer();
  bridge.wslExec = async () => ({ stdout: '', stderr: '', exitCode: 0 });
  bridge.wslSpawn = () => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  };
  try {
    await run(children);
  } finally {
    await shutdownJupyterServer();
    bridge.wslSpawn = originalSpawn;
    bridge.wslExec = originalExec;
  }
}

test('current-child exit clears state and notifies a snapshot exactly once', async () => {
  await withFakeChildren(async (children) => {
    let firstCalls = 0;
    let snapshotCalls = 0;
    let unsubscribedCalls = 0;
    let unsubscribeSnapshot = () => {};
    const unsubscribeFirst = onJupyterServerExit(() => {
      firstCalls += 1;
      unsubscribeSnapshot();
    });
    unsubscribeSnapshot = onJupyterServerExit(() => { snapshotCalls += 1; });
    const unsubscribeBeforeExit = onJupyterServerExit(() => { unsubscribedCalls += 1; });
    unsubscribeBeforeExit();
    try {
      const ready = ensureJupyterServer();
      await waitUntil(() => children.length === 1);
      emitReady(children[0], 18888);
      await ready;
      assert.ok(getJupyterServerInfo()?.ready);

      children[0].emit('exit', 1, null);
      assert.equal(firstCalls, 1, 'REACHABILITY:wp3-exit-coupling');
      assert.equal(snapshotCalls, 1, 'listener snapshot must survive in-notification unsubscribe');
      assert.equal(unsubscribedCalls, 0, 'an earlier unsubscribe must suppress notification');
      assert.equal(getJupyterServerInfo(), null);

      children[0].emit('exit', 1, null);
      assert.equal(firstCalls, 1, 'a repeated stale exit must not notify twice');
    } finally {
      unsubscribeFirst();
      unsubscribeSnapshot();
    }
  });
});

test('stale-child exit preserves replacement state and does not notify', async () => {
  await withFakeChildren(async (children) => {
    let calls = 0;
    const unsubscribe = onJupyterServerExit(() => { calls += 1; });
    try {
      const oldReady = ensureJupyterServer();
      await waitUntil(() => children.length === 1);
      emitReady(children[0], 18888);
      await oldReady;

      await shutdownJupyterServer();
      const replacementReady = ensureJupyterServer();
      await waitUntil(() => children.length === 2);
      emitReady(children[1], 18889);
      await replacementReady;

      children[0].emit('exit', 1, null);
      assert.equal(calls, 0);
      assert.equal(getJupyterServerInfo()?.baseUrl, 'http://127.0.0.1:18889/');
    } finally {
      unsubscribe();
    }
  });
});

test('throwing listener cannot suppress later listeners or pre-URL rejection', async () => {
  await withFakeChildren(async (children) => {
    let laterCalls = 0;
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
    const unsubscribeThrowing = onJupyterServerExit(() => { throw new Error('listener boom'); });
    const unsubscribeLater = onJupyterServerExit(() => { laterCalls += 1; });
    try {
      const starting = ensureJupyterServer();
      await waitUntil(() => children.length === 1);
      children[0].emit('exit', 7, null);
      await assert.rejects(starting, /exited before emitting URL \(code=7\)/);
      assert.equal(laterCalls, 1);
      assert.equal(logged.length, 1);
      assert.match(String(logged[0][0]), /exit listener failed/);
    } finally {
      unsubscribeThrowing();
      unsubscribeLater();
      console.error = originalError;
    }
  });
});

test('production registration seam couples child exit to kernel-client disposal', async () => {
  await withFakeChildren(async (children) => {
    let disposalCalls = 0;
    const unsubscribe = registerJupyterServerExitDisposal(() => { disposalCalls += 1; });
    try {
      const ready = ensureJupyterServer();
      await waitUntil(() => children.length === 1);
      emitReady(children[0], 18888);
      await ready;
      children[0].emit('exit', 1, null);
      assert.equal(disposalCalls, 1, 'REACHABILITY:wp3-exit-wiring');
    } finally {
      unsubscribe();
    }
  });
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const current of tests) {
    try {
      await current.run();
      console.log(`  ok  ${current.name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${current.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
