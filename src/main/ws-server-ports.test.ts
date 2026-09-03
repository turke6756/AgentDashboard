import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { AgentSupervisor } from './supervisor';
import { WsServer } from './ws-server';

const REACHABILITY = 'REACHABILITY:wp4-ws-awaitable-start';

function makeServer(): WsServer {
  return new WsServer(new EventEmitter() as AgentSupervisor);
}

test('two WebSocket servers coexist on OS-assigned ports', async (t) => {
  const first = makeServer();
  const second = makeServer();
  t.after(() => first.stop());
  t.after(() => second.stop());

  const firstPort = await first.start(0);
  const secondPort = await second.start(0);

  assert.ok(firstPort > 0, `${REACHABILITY}: first start must resolve its bound port`);
  assert.ok(secondPort > 0, `${REACHABILITY}: second start must resolve its bound port`);
  assert.notEqual(firstPort, secondPort, `${REACHABILITY}: ephemeral listeners must coexist`);
});

test('an occupied ephemeral port increments to the next port', async (t) => {
  const occupying = makeServer();
  const retrying = makeServer();
  t.after(() => occupying.stop());
  t.after(() => retrying.stop());

  const occupiedPort = await occupying.start(0);
  const boundPort = await retrying.start(occupiedPort);

  assert.equal(
    boundPort,
    occupiedPort + 1,
    `${REACHABILITY}: EADDRINUSE must increment the requested port`,
  );
});

test('a non-EADDRINUSE listen error rejects start', async () => {
  const server = makeServer();
  await assert.rejects(
    server.start(65_536),
    (error: unknown) => {
      assert.match(String(error), /port|range/i, `${REACHABILITY}: expected invalid-port error`);
      return true;
    },
    `${REACHABILITY}: non-EADDRINUSE errors must reject`,
  );
});
