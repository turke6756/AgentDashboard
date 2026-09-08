import assert from 'node:assert/strict';
import test from 'node:test';
import type { LibraryProgressEvent } from '../../shared/library';
import {
  LIBRARY_RETRY_DELAYS_MS,
  LibraryRescanCoordinator,
  type LibraryRescanCoordinatorScheduler,
} from './library-rescan-coordinator';
import type { LibraryRescanExecutionResult } from './library-rescan';
import type { LibraryStore } from './library-store';

class FakeScheduler implements LibraryRescanCoordinatorScheduler {
  now = 0;
  private nextId = 1;
  private timers = new Map<number, { due: number; callback: () => void }>();
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { due: this.now + delayMs, callback });
    return id;
  }
  clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  advance(delayMs: number): void {
    const target = this.now + delayMs;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.due <= target)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = next[1].due;
      next[1].callback();
    }
    this.now = target;
  }
  delays(): number[] { return [...this.timers.values()].map(({ due }) => due - this.now).sort((a, b) => a - b); }
}

const store = {} as LibraryStore;
const result = (attempts: number[]): LibraryRescanExecutionResult => ({
  scanned: attempts.length,
  ingested: 0,
  skipped: 0,
  failed: attempts.length,
  retryable_failures: attempts.map((attempt_count, index) => ({
    document_id: `doc-${index}`,
    source_rel_path: `.lares/library/inbox/${index}.md`,
    attempt_count,
  })),
});
const flush = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); };

test('automatic retries run at now, +1s and +4s, then stop at attempt three across restart', async () => {
  const scheduler = new FakeScheduler();
  const runs: Array<{ at: number; initiator: string }> = [];
  let attempt = 0;
  const coordinator = new LibraryRescanCoordinator({
    resolveWorkspace: (id) => ({ id, path: 'C:\\repo' }), scheduler, now: () => scheduler.now,
    openStore: () => store, closeStore: () => undefined,
    rescan: async ({ initiator }) => { attempt += 1; runs.push({ at: scheduler.now, initiator }); return result([attempt]); },
  });
  coordinator.onAutomaticFailure('already-capped', 3);
  assert.deepEqual(scheduler.delays(), [], 'watcher handoff at count three must schedule nothing');
  await coordinator.run('workspace-1', 'automatic');
  assert.deepEqual(scheduler.delays(), [LIBRARY_RETRY_DELAYS_MS[0]]);
  scheduler.advance(1_000); await flush();
  assert.deepEqual(scheduler.delays(), [LIBRARY_RETRY_DELAYS_MS[1]]);
  scheduler.advance(4_000); await flush();
  assert.deepEqual(runs, [
    { at: 0, initiator: 'automatic' },
    { at: 1_000, initiator: 'automatic' },
    { at: 5_000, initiator: 'automatic' },
  ]);
  assert.deepEqual(scheduler.delays(), [], 'attempt three must not create a fourth timer');
  await coordinator.stop();

  const restartedScheduler = new FakeScheduler();
  const restarted = new LibraryRescanCoordinator({
    resolveWorkspace: (id) => ({ id, path: 'C:\\repo' }), scheduler: restartedScheduler,
    openStore: () => store, closeStore: () => undefined, rescan: async () => result([3]),
  });
  await restarted.run('workspace-1', 'automatic');
  assert.deepEqual(restartedScheduler.delays(), [], 'persisted count three must remain capped after restart');
  await restarted.stop();
});

test('coalesces retryable rows to one earliest workspace timer and publishes the resolved workspace id', async () => {
  const scheduler = new FakeScheduler();
  const published: Array<LibraryProgressEvent & { workspace_id: string }> = [];
  const coordinator = new LibraryRescanCoordinator({
    resolveWorkspace: (id) => ({ id: `${id}-resolved`, path: 'C:\\repo' }), scheduler, now: () => scheduler.now,
    openStore: () => store, closeStore: () => undefined, publish: (event) => published.push(event),
    rescan: async ({ initiator, publish }) => {
      publish({ document_id: 'doc', status: 'queued', attempt_count: 1 });
      return initiator === 'manual' ? result([]) : result([2, 1, 2]);
    },
  });
  await coordinator.run('workspace-1', 'automatic');
  assert.deepEqual(scheduler.delays(), [1_000]);
  coordinator.onAutomaticFailure('workspace-1', 2);
  coordinator.onAutomaticFailure('workspace-1', 1);
  assert.deepEqual(scheduler.delays(), [1_000], 'watcher failures must coalesce into the existing earliest timer');
  assert.equal(published[0].workspace_id, 'workspace-1-resolved');
  await coordinator.run('workspace-1', 'manual');
  assert.deepEqual(scheduler.delays(), [], 'manual work must cancel the pending automatic retry');
  await coordinator.stop();
});

test('manual queued during an automatic failure suppresses its retry and schedules only from the manual result', async () => {
  const scheduler = new FakeScheduler();
  let releaseAutomatic!: () => void;
  let releaseManual!: () => void;
  let manualEntered!: () => void;
  const automaticGate = new Promise<void>((resolve) => { releaseAutomatic = resolve; });
  const manualGate = new Promise<void>((resolve) => { releaseManual = resolve; });
  const enteredManual = new Promise<void>((resolve) => { manualEntered = resolve; });
  let manualRetryable = false;
  const coordinator = new LibraryRescanCoordinator({
    resolveWorkspace: (id) => ({ id, path: 'C:\\repo' }), scheduler, now: () => scheduler.now,
    openStore: () => store, closeStore: () => undefined,
    rescan: async ({ initiator }) => {
      if (initiator === 'automatic') {
        await automaticGate;
        return result([1]);
      }
      manualEntered();
      await manualGate;
      return result(manualRetryable ? [1] : []);
    },
  });

  const automatic = coordinator.run('workspace-1', 'automatic');
  const manual = coordinator.run('workspace-1', 'manual');
  releaseAutomatic();
  await enteredManual;
  assert.deepEqual(scheduler.delays(), [], 'the completed automatic run must not arm a retry ahead of queued manual work');
  releaseManual();
  await Promise.all([automatic, manual]);
  assert.deepEqual(scheduler.delays(), [], 'a successful manual run must leave no automatic retry behind');

  manualRetryable = true;
  await coordinator.run('workspace-1', 'manual');
  assert.deepEqual(scheduler.delays(), [LIBRARY_RETRY_DELAYS_MS[0]], 'a failed manual run must schedule from its post-clear attempt one');
  await coordinator.stop();
});

test('manual queued behind an automatic run has priority and every executed run pairs one store open and close', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  let opens = 0;
  let closes = 0;
  let calls = 0;
  const coordinator = new LibraryRescanCoordinator({
    resolveWorkspace: (id) => id === 'missing' ? null : ({ id, path: 'C:\\repo' }),
    openStore: () => { opens += 1; return store; }, closeStore: () => { closes += 1; },
    rescan: async ({ initiator }) => { calls += 1; order.push(initiator); if (calls === 1) await gate; return result([]); },
  });
  const active = coordinator.run('workspace-1', 'automatic');
  const queuedAutomatic = coordinator.run('workspace-1', 'automatic');
  const queuedManual = coordinator.run('workspace-1', 'manual');
  release();
  await Promise.all([active, queuedAutomatic, queuedManual]);
  assert.deepEqual(order, ['automatic', 'manual', 'automatic']);
  assert.equal(opens, 3, 'REACHABILITY:rescanCoordinator every execution must open one store');
  assert.equal(closes, 3, 'REACHABILITY:rescanCoordinator every execution must close its store');
  await assert.rejects(coordinator.run('missing', 'automatic'), /workspace not found/);
  assert.deepEqual({ opens, closes }, { opens: 3, closes: 3 }, 'an unresolved workspace has no path to open and must not affect paired store runs');
  await coordinator.stop();
});

test('failure closes the store; stop cancels timers, rejects future work, and drains the active run', async () => {
  const scheduler = new FakeScheduler();
  let opens = 0;
  let closes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let mode: 'throw' | 'wait' = 'throw';
  const coordinator = new LibraryRescanCoordinator({
    resolveWorkspace: (id) => ({ id, path: 'C:\\repo' }), scheduler,
    openStore: () => { opens += 1; return store; }, closeStore: () => { closes += 1; },
    rescan: async () => { if (mode === 'throw') throw new Error('boom'); await gate; return result([1]); },
  });
  await assert.rejects(coordinator.run('workspace-1', 'automatic'), /boom/);
  assert.equal(opens, closes);
  mode = 'wait';
  const active = coordinator.run('workspace-1', 'automatic');
  const stopping = coordinator.stop();
  let stopped = false;
  stopping.then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false);
  release();
  await Promise.all([active, stopping]);
  assert.equal(opens, closes, 'REACHABILITY:rescanCoordinator finally must close during stop drain');
  assert.deepEqual(scheduler.delays(), []);
  await assert.rejects(coordinator.run('workspace-1', 'manual'), /stopped/);
});
