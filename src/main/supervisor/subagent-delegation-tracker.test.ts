import assert from 'node:assert/strict';
import { SubagentDelegationTracker } from './subagent-delegation-tracker';
import { SUBAGENT_ORPHAN_MS } from '../../shared/constants';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
const test = (name: string, run: () => void): void => { tests.push({ name, run }); };

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

test('keys children by session and id, derives count, and makes duplicate start/stop idempotent', () => {
  const c = clock();
  const tracker = new SubagentDelegationTracker(c.now, SUBAGENT_ORPHAN_MS);
  assert.equal(tracker.start('a', 's1', 'child', 10).disposition, 'applied');
  assert.equal(tracker.start('a', 's1', 'child', 10).disposition, 'duplicate');
  assert.equal(tracker.start('a', 's2', 'child', 10).disposition, 'applied');
  assert.equal(tracker.inFlightCount('a'), 2);
  assert.equal(tracker.stop('a', 's1', 'child', 11, false).disposition, 'applied');
  assert.equal(tracker.stop('a', 's1', 'child', 11, false).disposition, 'duplicate');
  assert.equal(tracker.inFlightCount('a'), 1);
});

test('stop-before-start tombstone blocks delayed resurrection and stop wins an equal-ts tie', () => {
  const tracker = new SubagentDelegationTracker(() => 5_000, SUBAGENT_ORPHAN_MS);
  assert.equal(tracker.stop('a', 's', 'c', 20, false).disposition, 'applied');
  assert.equal(tracker.start('a', 's', 'c', 19).disposition, 'stale');
  assert.equal(tracker.start('a', 's', 'c', 20).disposition, 'stale');
  assert.equal(tracker.inFlightCount('a'), 0);

  assert.equal(tracker.start('a', 's', 'other', 30).disposition, 'applied');
  assert.equal(tracker.stop('a', 's', 'other', 30, false).disposition, 'applied');
  assert.equal(tracker.inFlightCount('a'), 0);
});

test('same-session prompt keeps children; different-session prompt rotates the epoch', () => {
  const tracker = new SubagentDelegationTracker(() => 1, SUBAGENT_ORPHAN_MS);
  tracker.notePrompt('a', 's1');
  tracker.start('a', 's1', 'c1', 1);
  assert.equal(tracker.notePrompt('a', 's1').rotated, false);
  assert.equal(tracker.inFlightCount('a'), 1);
  assert.equal(tracker.notePrompt('a', 's2').rotated, true);
  assert.equal(tracker.inFlightCount('a'), 0);
  assert.equal(tracker.getState('a')?.parentSessionId, 's2');
  assert.equal(tracker.getState('a')?.children.size, 0);
});

test('final stop holds the deferred parent Stop until the zero-in-flight watchdog', () => {
  const c = clock();
  const tracker = new SubagentDelegationTracker(c.now, SUBAGENT_ORPHAN_MS);
  tracker.start('a', 's', 'c', 1);
  tracker.deferParentStop('a', { hookTs: 2, receivedAt: c.now(), source: 'hook-stop' });
  tracker.stop('a', 's', 'c', 3, false);
  assert.equal(tracker.inFlightCount('a'), 0);
  assert.equal(tracker.getState('a')?.zeroInFlightAt, c.now());
  assert.equal(tracker.sweep('a', false).drain, undefined);
  c.advance(SUBAGENT_ORPHAN_MS);
  assert.equal(tracker.sweep('a', false).drain?.source, 'hook-stop');
  assert.equal(tracker.getState('a')?.zeroInFlightAt, undefined);
});

test('new start, session rotation, and authoritative Stop clear zero-in-flight state without draining', () => {
  const c = clock();
  const tracker = new SubagentDelegationTracker(c.now, SUBAGENT_ORPHAN_MS);
  const arm = (): void => {
    tracker.start('a', 's', 'c', c.now());
    tracker.deferParentStop('a', { hookTs: c.now() + 1, receivedAt: c.now(), source: 'hook-stop' });
    tracker.stop('a', 's', 'c', c.now() + 2, false);
    assert.notEqual(tracker.getState('a')?.zeroInFlightAt, undefined);
  };

  arm();
  tracker.start('a', 's', 'c2', c.now() + 3);
  assert.equal(tracker.getState('a')?.zeroInFlightAt, undefined);
  assert.equal(tracker.getState('a')?.deferredParentStop, undefined);

  tracker.clear('a');
  arm();
  tracker.notePrompt('a', 's2');
  assert.equal(tracker.getState('a')?.zeroInFlightAt, undefined);
  assert.equal(tracker.sweep('a', false).drain, undefined);

  tracker.clear('a');
  arm();
  tracker.authoritativeParentStop('a');
  assert.equal(tracker.getState('a'), undefined);
  assert.equal(tracker.sweep('a', false).drain, undefined);
});

test('waiting outranks inferred idle and discards a deferred Stop', () => {
  const c = clock();
  const tracker = new SubagentDelegationTracker(c.now, SUBAGENT_ORPHAN_MS);
  tracker.start('a', 's', 'c', 1);
  tracker.deferParentStop('a', { hookTs: 2, receivedAt: c.now(), source: 'hook-stop' });
  tracker.stop('a', 's', 'c', 3, true);
  assert.equal(tracker.getState('a')?.deferredParentStop, undefined);
  assert.equal(tracker.getState('a')?.zeroInFlightAt, undefined);
  c.advance(SUBAGENT_ORPHAN_MS * 2);
  assert.equal(tracker.sweep('a', true).drain, undefined);
});

test('running child expiry enters the same zero-in-flight drain', () => {
  const c = clock();
  const tracker = new SubagentDelegationTracker(c.now, SUBAGENT_ORPHAN_MS);
  tracker.start('a', 's', 'orphan', 1);
  tracker.deferParentStop('a', { hookTs: 2, receivedAt: c.now(), source: 'hook-stop' });
  c.advance(SUBAGENT_ORPHAN_MS);
  const expired = tracker.sweep('a', false);
  assert.deepEqual(expired.expiredChildIds, ['orphan']);
  assert.equal(tracker.inFlightCount('a'), 0);
  assert.equal(expired.drain, undefined);
  c.advance(SUBAGENT_ORPHAN_MS);
  assert.equal(tracker.sweep('a', false).drain?.source, 'hook-stop');
});

let passed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok  ${t.name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${t.name}`);
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  }
}
console.log(`\n${passed} passed, ${tests.length - passed} failed`);
