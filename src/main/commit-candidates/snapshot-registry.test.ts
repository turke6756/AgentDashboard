// WP-G — CommitCandidateSnapshotRegistry single-flight + settled-cache unit tests.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/snapshot-registry.test.js
//
// Proves the deliberation §7 ruling as a pure state machine, independent of the
// route wiring: exactly one active computation per repositoryKey; differing
// policyGeneration is sequential, never concurrent; failed/cancelled flights are
// never cached; one waiter cancelling does not cancel shared work while others
// remain; the settled cache is an 8-repository LRU with a 500 ms TTL; invalidate
// drops the cache and prevents an in-flight result from repopulating it.

import assert from 'node:assert/strict';

import { CommitCandidateSnapshotRegistry, type SnapshotFlightKey } from './snapshot-registry';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

/** A promise whose resolution/rejection is controlled from the test. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let the microtask queue drain so chained `.then` continuations run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const key = (repositoryKey: string, policyGeneration = 0): SnapshotFlightKey =>
  ({ repositoryKey, policyGeneration });

// ── single-flight ──────────────────────────────────────────────────────────────

test('concurrent same-generation requests coalesce to exactly one computation', async () => {
  const registry = new CommitCandidateSnapshotRegistry<string>();
  let computations = 0;
  const gate = deferred<void>();
  const compute = async () => { computations += 1; await gate.promise; return 'snap'; };

  const a = registry.acquire(key('repo'), compute);
  const b = registry.acquire(key('repo'), compute);
  await flush();
  assert.equal(computations, 1, 'only one canonical computation runs for two waiters');

  gate.resolve();
  assert.equal(await a, 'snap');
  assert.equal(await b, 'snap');
  assert.equal(computations, 1);
});

test('differing policyGeneration runs sequentially, never concurrently', async () => {
  const registry = new CommitCandidateSnapshotRegistry<string>();
  const events: string[] = [];
  const gate0 = deferred<void>();
  const gate1 = deferred<void>();

  const first = registry.acquire(key('repo', 0), async () => {
    events.push('start-0');
    await gate0.promise;
    events.push('end-0');
    return 'gen0';
  });
  const second = registry.acquire(key('repo', 1), async () => {
    events.push('start-1');
    await gate1.promise;
    events.push('end-1');
    return 'gen1';
  });

  await flush();
  assert.deepEqual(events, ['start-0'], 'the gen-1 flight does not start while gen-0 is active');

  gate0.resolve();
  assert.equal(await first, 'gen0');
  await flush();
  assert.deepEqual(events, ['start-0', 'end-0', 'start-1'], 'gen-1 starts only after gen-0 fully settles');

  gate1.resolve();
  assert.equal(await second, 'gen1');
  assert.deepEqual(events, ['start-0', 'end-0', 'start-1', 'end-1']);
});

test('a scoped rescan at the same generation joins the canonical flight (no overlap)', async () => {
  const registry = new CommitCandidateSnapshotRegistry<string>();
  let computations = 0;
  const gate = deferred<void>();
  const canonical = registry.acquire(key('repo'), async () => { computations += 1; await gate.promise; return 'snap'; });
  const rescan = registry.acquire(key('repo'), async () => { computations += 1; await gate.promise; return 'other'; });
  await flush();
  assert.equal(computations, 1, 'the rescan shares the admission queue rather than overlapping');
  gate.resolve();
  assert.equal(await canonical, 'snap');
  assert.equal(await rescan, 'snap', 'the rescan projects from the one canonical result');
});

// ── failure / cancellation are never cached ─────────────────────────────────────

test('a failed flight is cleared and never cached; the next request recomputes', async () => {
  const registry = new CommitCandidateSnapshotRegistry<string>();
  let computations = 0;
  await assert.rejects(
    registry.acquire(key('repo'), async () => { computations += 1; throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(registry.hasCached(key('repo')), false, 'a failed result is never cached');
  const value = await registry.acquire(key('repo'), async () => { computations += 1; return 'ok'; });
  assert.equal(value, 'ok');
  assert.equal(computations, 2, 'the cleared in-flight slot forces a fresh computation');
});

test('the last waiter cancelling aborts the shared work and does not cache it', async () => {
  const registry = new CommitCandidateSnapshotRegistry<string>();
  const gate = deferred<void>();
  let observed: AbortSignal | null = null;
  const controller = new AbortController();
  const acquired = registry.acquire(key('repo'), async (signal) => {
    observed = signal;
    await gate.promise;
    return 'snap';
  }, { signal: controller.signal });

  await flush();
  controller.abort();
  await assert.rejects(acquired, (error: Error) => error.name === 'AbortError');
  assert.equal(observed!.aborted, true, 'the shared computation is aborted once no waiters remain');
  assert.equal(registry.hasCached(key('repo')), false);
  gate.resolve();
  await flush();
  assert.equal(registry.hasCached(key('repo')), false, 'a computation abandoned by all waiters is never cached');
});

test('one waiter cancelling leaves shared work running for the remaining waiter', async () => {
  const registry = new CommitCandidateSnapshotRegistry<string>();
  const gate = deferred<void>();
  let observed: AbortSignal | null = null;
  const canceller = new AbortController();
  const cancelled = registry.acquire(key('repo'), async (signal) => {
    observed = signal;
    await gate.promise;
    return 'snap';
  }, { signal: canceller.signal });
  const survivor = registry.acquire(key('repo'), async () => 'unused-second-thunk');

  await flush();
  canceller.abort();
  await assert.rejects(cancelled, (error: Error) => error.name === 'AbortError');
  assert.equal(observed!.aborted, false, 'shared work is not cancelled while a waiter remains');

  gate.resolve();
  assert.equal(await survivor, 'snap', 'the remaining waiter still receives the shared result');
  assert.equal(registry.hasCached(key('repo')), true);
});

// ── settled cache: TTL + LRU + invalidation ─────────────────────────────────────

test('the settled cache serves within the 500 ms TTL and recomputes after it', async () => {
  let clock = 1_000;
  const registry = new CommitCandidateSnapshotRegistry<string>({ now: () => clock, ttlMs: 500 });
  let computations = 0;
  const compute = async () => { computations += 1; return `snap-${computations}`; };

  assert.equal(await registry.acquire(key('repo'), compute), 'snap-1');
  clock = 1_499; // 499 ms later — still fresh
  assert.equal(await registry.acquire(key('repo'), compute), 'snap-1');
  assert.equal(computations, 1, 'a cache hit within the TTL does not recompute');

  clock = 1_500; // exactly 500 ms — expired
  assert.equal(await registry.acquire(key('repo'), compute), 'snap-2');
  assert.equal(computations, 2, 'an expired entry recomputes');
});

test('a differing generation is a cache miss even within the TTL', async () => {
  let clock = 0;
  const registry = new CommitCandidateSnapshotRegistry<string>({ now: () => clock, ttlMs: 500 });
  let computations = 0;
  const compute = async () => { computations += 1; return `snap-${computations}`; };
  await registry.acquire(key('repo', 0), compute);
  clock = 100;
  await registry.acquire(key('repo', 1), compute);
  assert.equal(computations, 2, 'a new policyGeneration never reuses the prior generation cache');
});

test('the settled cache is bounded to an 8-repository LRU', async () => {
  const registry = new CommitCandidateSnapshotRegistry<string>({ now: () => 0, ttlMs: 500, maxRepositories: 8 });
  for (let i = 0; i < 9; i += 1) {
    await registry.acquire(key(`repo-${i}`), async () => `snap-${i}`);
  }
  assert.equal(registry.hasCached(key('repo-0')), false, 'the least-recently-used repository is evicted at cap+1');
  for (let i = 1; i < 9; i += 1) {
    assert.equal(registry.hasCached(key(`repo-${i}`)), true, `repo-${i} is retained`);
  }
});

test('invalidate drops the cache and prevents an in-flight result from repopulating it', async () => {
  const registry = new CommitCandidateSnapshotRegistry<string>({ now: () => 0, ttlMs: 500 });
  await registry.acquire(key('repo'), async () => 'first');
  assert.equal(registry.hasCached(key('repo')), true);
  registry.invalidate('repo');
  assert.equal(registry.hasCached(key('repo')), false, 'invalidate drops the settled entry');

  // A checkpoint/finalization/policy write mid-flight must not leave a stale entry.
  const gate = deferred<void>();
  const inflight = registry.acquire(key('repo'), async () => { await gate.promise; return 'second'; });
  await flush();
  registry.invalidate('repo');
  gate.resolve();
  assert.equal(await inflight, 'second', 'the waiter still receives the freshly computed result');
  assert.equal(registry.hasCached(key('repo')), false, 'an invalidated in-flight result is not cached');
});

// ── runner ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let failed = 0;
  for (const current of tests) {
    try { await current.run(); console.log(`ok - ${current.name}`); }
    catch (error) { failed += 1; console.error(`not ok - ${current.name}`); console.error(error); }
  }
  if (failed > 0) process.exitCode = 1;
}

void main();
