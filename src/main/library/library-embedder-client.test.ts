import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  createLibraryEmbedderClient,
  LIBRARY_EMBEDDING_DIMENSIONS,
  type LibraryEmbedderChild,
  type LibraryEmbedderClientDeps,
} from './library-embedder';

interface SentRequest { id: number; modelRoot: string; texts: string[] }

class FakeChild extends EventEmitter implements LibraryEmbedderChild {
  readonly sent: SentRequest[] = [];
  readonly channel = { unrefCalls: 0, unref: () => { this.channel.unrefCalls += 1; } };
  unrefCalls = 0;
  killCalls = 0;
  send(message: unknown): boolean {
    this.sent.push(message as SentRequest);
    return true;
  }
  postMessage(message: unknown): void {
    this.sent.push(message as SentRequest);
  }
  unref(): void { this.unrefCalls += 1; }
  kill(): boolean {
    this.killCalls += 1;
    this.emit('exit', 0);
    return true;
  }
}

function vector(value: number): number[] {
  return Array.from({ length: LIBRARY_EMBEDDING_DIMENSIONS }, () => value);
}

function harness(kind: 'node' | 'utility' = 'node') {
  const children: FakeChild[] = [];
  const timers = new Map<object, () => void>();
  const deps: LibraryEmbedderClientDeps = {
    spawnChild: () => {
      const child = new FakeChild();
      children.push(child);
      return { child, kind };
    },
    setTimer: (callback) => {
      const handle = {};
      timers.set(handle, callback);
      return handle as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => { timers.delete(timer as unknown as object); },
    killFallbackMs: 10,
  };
  return {
    children,
    timers,
    client: createLibraryEmbedderClient(deps),
    expireFirst: () => timers.values().next().value?.(),
  };
}

test('one helper serves sequential and concurrent requests while request errors stay isolated', async () => {
  const h = harness('utility');
  for (let index = 0; index < 10; index += 1) {
    const pending = h.client.embedTexts([`text-${index}`], 'model');
    const request = h.children[0].sent.at(-1)!;
    h.children[0].emit('message', { id: request.id, vectors: [vector(index)], load_ms: index === 0 ? 12 : 0 });
    assert.equal((await pending).vectors[0][0], index);
  }
  assert.equal(h.children.length, 1, 'REACHABILITY:embedderGeneration ten calls use one helper/model generation');

  const a = h.client.embedTexts(['a'], 'model');
  const b = h.client.embedTexts(['b'], 'model');
  const [requestA, requestB] = h.children[0].sent.slice(-2);
  h.children[0].emit('message', { id: requestB.id, vectors: [vector(2)] });
  h.children[0].emit('message', { id: requestA.id, vectors: [vector(1)] });
  assert.deepEqual([(await a).vectors[0][0], (await b).vectors[0][0]], [1, 2]);

  const failed = h.client.embedTexts(['bad'], 'model');
  const bad = h.children[0].sent.at(-1)!;
  h.children[0].emit('message', { id: bad.id, error: 'model rejected request' });
  await assert.rejects(failed, /model rejected request/);
  const healthy = h.client.embedTexts(['healthy'], 'model');
  const good = h.children[0].sent.at(-1)!;
  h.children[0].emit('message', { id: good.id, vectors: [vector(3)] });
  assert.equal((await healthy).vectors[0][0], 3);
  assert.equal(h.children.length, 1);
  await h.client.shutdown();
});

test('timeout retires the whole generation and late messages cannot settle its successor', async () => {
  const h = harness();
  const a = h.client.embedTexts(['held'], 'model');
  const b = h.client.embedTexts(['queued'], 'model');
  const old = h.children[0];
  const [requestA, requestB] = old.sent;
  h.expireFirst();
  await assert.rejects(a, /timed out/);
  await assert.rejects(b, /generation 1 was recycled/);
  assert.equal(old.killCalls, 1, 'REACHABILITY:embedderGeneration timeout kills the owning helper');
  assert.equal(h.timers.size, 0);

  const c = h.client.embedTexts(['successor'], 'model');
  assert.equal(h.children.length, 2);
  const successor = h.children[1];
  const requestC = successor.sent[0];
  old.emit('message', { id: requestC.id, vectors: [vector(7)] });
  successor.emit('message', { id: requestC.id, vectors: [vector(9)] });
  assert.equal((await c).vectors[0][0], 9);
  assert.notEqual(requestA.id, requestB.id);
  await h.client.shutdown();
});

test('node handles unref, unexpected exit respawns, and shutdown is idempotent', async () => {
  const h = harness('node');
  const pending = h.client.embedTexts(['pending'], 'model');
  assert.equal(h.children[0].unrefCalls, 1);
  assert.equal(h.children[0].channel.unrefCalls, 1);
  h.children[0].emit('exit', 1);
  await assert.rejects(pending, /exited 1|recycled/);
  const next = h.client.embedTexts(['next'], 'model');
  assert.equal(h.children.length, 2);
  await h.client.shutdown();
  await assert.rejects(next, /shut down|recycled/);
  await h.client.shutdown();
  assert.equal(h.timers.size, 0);
});
