import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { SafeWebSocket } from './jupyter-kernel-client';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
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

    class FakeServiceManager {
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
    } finally {
      serverExports.ensureJupyterServer = originalEnsure;
      servicesModule.exports = servicesExports;
      delete require.cache[clientPath];
      if (originalClient) require.cache[clientPath] = originalClient;
    }
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
