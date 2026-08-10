import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { ServiceManager as IServiceManager } from '@jupyterlab/services';
import {
  SafeWebSocket,
  disposeKernelClient,
  executeNotebook,
  resetCreateServiceManagerForTest,
  setCreateServiceManagerForTest,
} from './jupyter-kernel-client';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeManagerControl {
  manager: IServiceManager.IManager;
  contentsCalls: number;
}

function fakeManager(name: string, ready: Promise<unknown>, disposal: string[]): FakeManagerControl {
  const control: FakeManagerControl = {
    contentsCalls: 0,
    manager: undefined as unknown as IServiceManager.IManager,
  };
  control.manager = {
    ready,
    kernels: { dispose: () => disposal.push(`${name}:kernels`) },
    kernelspecs: { dispose: () => disposal.push(`${name}:kernelspecs`) },
    user: { dispose: () => disposal.push(`${name}:user`) },
    dispose: () => disposal.push(`${name}:manager`),
    contents: {
      get: async () => {
        control.contentsCalls += 1;
        return { content: {} };
      },
    },
  } as unknown as IServiceManager.IManager;
  return control;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for lifecycle test state');
}

async function withFakeJupyterServer(run: () => Promise<void>): Promise<void> {
  const server = require('./jupyter-server') as { ensureJupyterServer: unknown };
  const originalEnsure = server.ensureJupyterServer;
  disposeKernelClient();
  resetCreateServiceManagerForTest();
  server.ensureJupyterServer = async () => ({
    baseUrl: 'http://127.0.0.1:9999/',
    token: 'test-token',
  });
  try {
    await run();
  } finally {
    disposeKernelClient();
    resetCreateServiceManagerForTest();
    server.ensureJupyterServer = originalEnsure;
  }
}

async function refusedWebSocketUrl(): Promise<string> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return `ws://127.0.0.1:${port}`;
}

async function waitForClose(socket: SafeWebSocket): Promise<void> {
  if (socket.readyState === SafeWebSocket.CLOSED) return;
  await new Promise<void>((resolve) => socket.once('close', () => resolve()));
}

async function runEventManagerOracle(): Promise<void> {
  const socket = new SafeWebSocket(await refusedWebSocketUrl());
  // Deliberately mirror @jupyterlab/services EventManager: attributes for close
  // and message, but no consumer-owned error handler.
  socket.onclose = () => {
    console.log('event-manager-close-reached');
  };
  socket.onmessage = () => {};
  await waitForClose(socket);
}

if (process.argv.includes('--event-manager-oracle')) {
  runEventManagerOracle().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(2);
    },
  );
} else {
  test('SafeWebSocket installs an error listener for both constructor arities', async () => {
    const url = await refusedWebSocketUrl();
    const oneArgument = new SafeWebSocket(url);
    const twoArguments = new SafeWebSocket(url, ['jupyter']);
    assert.ok(oneArgument.listenerCount('error') >= 1);
    assert.ok(twoArguments.listenerCount('error') >= 1);
    await Promise.all([waitForClose(oneArgument), waitForClose(twoArguments)]);
  });

  test('EventManager-shaped refused connection reaches close without an uncaught error', () => {
    const child = spawnSync(process.execPath, [__filename, '--event-manager-oracle'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(
      child.status,
      0,
      `REACHABILITY:wp1-safe-websocket-guard\nstdout=${child.stdout}\nstderr=${child.stderr}`,
    );
    assert.match(child.stdout, /event-manager-close-reached/);
  });

  test('onerror remains additive and can be cleared without removing the guard', async () => {
    const socket = new SafeWebSocket(await refusedWebSocketUrl());
    let consumerCalls = 0;
    socket.onerror = () => { consumerCalls += 1; };
    socket.emit('error', new Error('consumer-probe'));
    assert.equal(consumerCalls, 1);

    socket.onerror = null;
    assert.equal(socket.onerror, null);
    assert.ok(socket.listenerCount('error') >= 1);
    await waitForClose(socket);
  });

  test('the production makeSettings call receives SafeWebSocket', async () => {
    // Reload the production module with only its external construction seams
    // replaced, then enter through executeNotebook -> ensureManager.
    const clientPath = require.resolve('./jupyter-kernel-client');
    const serverPath = require.resolve('./jupyter-server');
    const servicesPath = require.resolve('@jupyterlab/services');
    const originalClient = require.cache[clientPath];
    const serverExports = require(serverPath) as { ensureJupyterServer: unknown };
    const servicesModule = require.cache[servicesPath];
    assert.ok(servicesModule);
    const servicesExports = servicesModule.exports as Record<string, unknown>;
    const originalEnsure = serverExports.ensureJupyterServer;
    let received: Record<string, unknown> | undefined;
    let serviceManagerConstructions = 0;

    class FakeServiceManager {
      constructor() { serviceManagerConstructions += 1; }
      ready = Promise.resolve();
      contents = { get: async () => ({ content: {} }) };
    }

    try {
      serverExports.ensureJupyterServer = async () => ({
        baseUrl: 'http://127.0.0.1:9999/',
        token: 'test-token',
      });
      servicesModule.exports = {
        ...servicesExports,
        ServerConnection: {
          makeSettings: (options: Record<string, unknown>) => {
            received = options;
            return options;
          },
        },
        ServiceManager: FakeServiceManager,
      };
      delete require.cache[clientPath];
      const reloaded = require(clientPath) as {
        SafeWebSocket: typeof SafeWebSocket;
        executeNotebook(path: string): Promise<unknown>;
      };
      await assert.rejects(reloaded.executeNotebook('probe.ipynb'), /Not a notebook/);
      assert.equal(received?.WebSocket, reloaded.SafeWebSocket);
      assert.equal(serviceManagerConstructions, 1, 'the default factory must construct ServiceManager');
    } finally {
      serverExports.ensureJupyterServer = originalEnsure;
      servicesModule.exports = servicesExports;
      delete require.cache[clientPath];
      if (originalClient) require.cache[clientPath] = originalClient;
    }
  });

  test('failed initialization completely disposes the manager and never publishes it', async () => {
    await withFakeJupyterServer(async () => {
      const failedReady = deferred<void>();
      const disposal: string[] = [];
      const failed = fakeManager('failed', failedReady.promise, disposal);
      const replacement = fakeManager('replacement', Promise.resolve(), disposal);
      const managers = [failed.manager, replacement.manager];
      let factoryCalls = 0;
      setCreateServiceManagerForTest(() => managers[factoryCalls++]);

      const first = executeNotebook('failed.ipynb');
      await waitUntil(() => factoryCalls === 1);
      failedReady.reject(new Error('ready failed'));
      await assert.rejects(first, /ready failed/);
      assert.deepEqual(disposal, [
        'failed:kernels',
        'failed:kernelspecs',
        'failed:user',
        'failed:manager',
      ]);

      await assert.rejects(executeNotebook('replacement.ipynb'), /Not a notebook/);
      assert.equal(factoryCalls, 2, 'a failed manager must not remain published');
      assert.equal(failed.contentsCalls, 0);
      assert.equal(replacement.contentsCalls, 1);
    });
  });

  test('dispose during deferred initialization prevents stale publication', async () => {
    await withFakeJupyterServer(async () => {
      const ready = deferred<void>();
      const disposal: string[] = [];
      const stale = fakeManager('stale', ready.promise, disposal);
      let factoryCalls = 0;
      setCreateServiceManagerForTest(() => {
        factoryCalls += 1;
        return stale.manager;
      });

      const initialization = executeNotebook('stale.ipynb');
      await waitUntil(() => factoryCalls === 1);
      disposeKernelClient();
      ready.resolve();
      await assert.rejects(initialization, /kernel client disposed during initialization/);
      assert.equal(stale.contentsCalls, 0);
      assert.deepEqual(disposal, [
        'stale:kernels',
        'stale:kernelspecs',
        'stale:user',
        'stale:manager',
      ]);
    });
  });

  test('overlapping generations publish only the post-disposal replacement', async () => {
    await withFakeJupyterServer(async () => {
      const oldReady = deferred<void>();
      const replacementReady = deferred<void>();
      const disposal: string[] = [];
      const old = fakeManager('old', oldReady.promise, disposal);
      const replacement = fakeManager('replacement', replacementReady.promise, disposal);
      const managers = [old.manager, replacement.manager];
      let factoryCalls = 0;
      setCreateServiceManagerForTest(() => managers[factoryCalls++]);

      const oldInitialization = executeNotebook('old.ipynb');
      await waitUntil(() => factoryCalls === 1);
      disposeKernelClient();
      const replacementInitialization = executeNotebook('replacement.ipynb');
      await waitUntil(() => factoryCalls === 2);

      oldReady.resolve();
      await assert.rejects(
        oldInitialization,
        /kernel client disposed during initialization/,
        'REACHABILITY:wp2-generation-guard',
      );
      assert.equal(old.contentsCalls, 0, 'REACHABILITY:wp2-generation-guard');

      replacementReady.resolve();
      await assert.rejects(replacementInitialization, /Not a notebook/);
      assert.equal(replacement.contentsCalls, 1);
      await assert.rejects(executeNotebook('published.ipynb'), /Not a notebook/);
      assert.equal(factoryCalls, 2, 'the replacement must remain the published manager');
      assert.equal(replacement.contentsCalls, 2);
      assert.deepEqual(disposal, [
        'old:kernels',
        'old:kernelspecs',
        'old:user',
        'old:manager',
      ]);
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
}
