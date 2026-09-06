import assert from 'node:assert/strict';
import type { SendOutcome } from '../../shared/types';
import type { ScheduleSetDto } from '../../shared/schedule-types';
import {
  AgentScheduleStore,
  ScheduleValidationError,
  type ScheduleValidationCode,
} from './agent-schedule-store';
import {
  AgentScheduler,
  type ScheduledDeliveryResult,
  type ScheduledFiring,
} from './agent-scheduler';

type TestCase = { name: string; run: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, run: TestCase['run']): void => { tests.push({ name, run }); };

class FakeClock {
  now = 1_000_000;
  callback: (() => void) | null = null;
  intervalMs: number | null = null;
  cleared = false;
  readonly setInterval = (callback: () => void, intervalMs: number): object => {
    this.callback = callback;
    this.intervalMs = intervalMs;
    return { fake: true };
  };
  readonly clearInterval = (): void => { this.cleared = true; };
  advance(ms: number): void { this.now += ms; }
}

function manualDto(overrides: Partial<ScheduleSetDto> = {}): ScheduleSetDto {
  return {
    message: 'scheduled text',
    recurrence: { kind: 'interval', everyMs: 60_000 },
    stopping: { kind: 'manual' },
    enabled: true,
    revision: null,
    ...overrides,
  };
}

function confirmed(agentId: string, completedAt: number): ScheduledDeliveryResult {
  const outcome: SendOutcome = {
    disposition: 'confirmed',
    agentId,
    delivered: true,
    confirmationSource: 'hook',
    completedAt,
  };
  return { disposition: 'sent', outcome };
}

function unconfirmed(agentId: string, completedAt: number): ScheduledDeliveryResult {
  const outcome: SendOutcome = {
    disposition: 'delivered-unconfirmed',
    agentId,
    delivered: true,
    completedAt,
  };
  return { disposition: 'sent', outcome };
}

function harness(deliver: (firing: ScheduledFiring) => ScheduledDeliveryResult | Promise<ScheduledDeliveryResult>) {
  const clock = new FakeClock();
  let scheduleId = 0;
  const store = new AgentScheduleStore({
    agentExists: (agentId) => agentId === 'agent-1',
    now: () => clock.now,
    createId: () => `schedule-${++scheduleId}`,
  });
  const scheduler = new AgentScheduler({
    store,
    deliver,
    now: () => clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  });
  return { clock, store, scheduler };
}

function expectCode(run: () => unknown, code: ScheduleValidationCode): void {
  assert.throws(run, (error) => error instanceof ScheduleValidationError && error.code === code);
}

test('store enforces validation codes, one schedule per agent, revisions, and disposal', () => {
  const clock = new FakeClock();
  const store = new AgentScheduleStore({ agentExists: (id) => id === 'agent-1', now: () => clock.now, createId: () => 's' });
  expectCode(() => store.set('missing', manualDto()), 'no-agent');
  expectCode(() => store.set('agent-1', manualDto({ message: '  ' })), 'message-invalid');
  expectCode(() => store.set('agent-1', manualDto({ recurrence: { kind: 'interval', everyMs: 59_999 } })), 'interval-out-of-range');
  expectCode(() => store.set('agent-1', manualDto({ recurrence: { kind: 'daily', atMinuteOfDay: 1440 } })), 'minute-invalid');
  expectCode(() => store.set('agent-1', manualDto({ stopping: { kind: 'count', remaining: 0 } })), 'count-invalid');
  expectCode(() => store.set('agent-1', manualDto({ stopping: { kind: 'until', endAtEpochMs: clock.now - 1 } })), 'end-in-past');
  expectCode(() => store.set('agent-1', manualDto({ stopping: { kind: 'until', endAtEpochMs: Number.NaN } })), 'end-in-past');
  expectCode(() => store.set('agent-1', manualDto({ stopping: { kind: 'until', endAtEpochMs: Number.POSITIVE_INFINITY } })), 'end-in-past');
  const created = store.set('agent-1', manualDto());
  assert.equal(created.revision, 1);
  expectCode(() => store.set('agent-1', manualDto()), 'schedule-exists');
  expectCode(() => store.set('agent-1', manualDto({ revision: 99 })), 'revision-conflict');
  const updated = store.set('agent-1', manualDto({ message: 'edited', revision: 1 }));
  assert.equal(updated.revision, 2);
  assert.equal(updated.id, created.id);
  store.disposeForAgent('agent-1');
  assert.equal(store.get('agent-1'), null);
});

test('claim is synchronous, starts the injected one-second tick, and finalizes honest history', () => {
  let delivery: ScheduledFiring | null = null;
  const h = harness((firing) => {
    delivery = firing;
    firing.markDelivering('ordinary');
    return confirmed(firing.agentId, h.clock.now);
  });
  h.scheduler.start();
  assert.equal(h.clock.intervalMs, 1_000);
  h.scheduler.setSchedule('agent-1', manualDto());
  h.clock.advance(60_000);
  h.clock.callback!();
  assert.ok(delivery);
  assert.equal((delivery as ScheduledFiring).dueAt, h.clock.now);
  assert.equal(h.scheduler.getSchedule('agent-1')?.occurrenceCount, 1);
  assert.equal(h.scheduler.getSchedule('agent-1')?.fireCount, 1);
  assert.equal(h.scheduler.history('agent-1')[0]?.liveness, 'idle');
  assert.equal(h.scheduler.history('agent-1')[0]?.notificationRoute, 'ordinary');
  assert.equal(h.scheduler.history('agent-1')[0]?.confirmationSource, 'hook');
  h.scheduler.stop();
  assert.equal(h.clock.cleared, true);
});

test('REACHABILITY:cron-scheduler collapse advances nextFireAt and does not re-collapse the same slot', () => {
  const h = harness(() => ({ disposition: 'held' }));
  h.scheduler.setSchedule('agent-1', manualDto());
  h.clock.advance(60_000);
  h.scheduler.tick();
  assert.equal(h.scheduler.getSchedule('agent-1')?.nextFireAt, h.clock.now + 60_000);
  h.clock.advance(60_000);
  h.scheduler.tick();
  assert.equal(h.scheduler.getSchedule('agent-1')?.nextFireAt, h.clock.now + 60_000);
  assert.equal(h.scheduler.history('agent-1').filter((row) => row.outcome === 'collapsed').length, 1);
  h.scheduler.tick();
  assert.equal(h.scheduler.history('agent-1').filter((row) => row.outcome === 'collapsed').length, 1);
});

test('late held backlog collapses once and advances to the first future anchored interval slot', () => {
  const h = harness(() => ({ disposition: 'held' }));
  h.scheduler.setSchedule('agent-1', manualDto());
  h.clock.advance(60_000);
  h.scheduler.tick();
  h.clock.advance(5 * 60_000 + 17_000);
  h.scheduler.tick();
  assert.equal(h.scheduler.history('agent-1').filter((row) => row.outcome === 'collapsed').length, 1);
  assert.equal(h.scheduler.getSchedule('agent-1')?.nextFireAt, 1_420_000);
});

test('count is a due-occurrence budget including collapse, while the held final occurrence still delivers', () => {
  let calls = 0;
  const h = harness((firing) => (++calls === 1 ? { disposition: 'held' } : confirmed(firing.agentId, h.clock.now)));
  h.scheduler.setSchedule('agent-1', manualDto({ stopping: { kind: 'count', remaining: 2 } }));
  h.clock.advance(60_000);
  h.scheduler.tick();
  assert.equal((h.scheduler.getSchedule('agent-1')?.stopping as { remaining: number }).remaining, 1);
  h.clock.advance(60_000);
  h.scheduler.tick();
  const exhausted = h.scheduler.getSchedule('agent-1')!;
  assert.equal((exhausted.stopping as { remaining: number }).remaining, 0);
  assert.equal(exhausted.occurrenceCount, 2);
  assert.equal(exhausted.lifecycle, 'exhausted');
  assert.equal(exhausted.nextFireAt, null);
  h.scheduler.releaseHeld('agent-1');
  assert.equal(h.scheduler.getSchedule('agent-1')?.fireCount, 1);
  assert.deepEqual(h.scheduler.history('agent-1').map((row) => row.outcome), ['collapsed', 'confirmed']);
});

test('until boundary is inclusive, exhausts after its final slot, and re-enable stays exhausted', () => {
  const h = harness((firing) => confirmed(firing.agentId, h.clock.now));
  const end = h.clock.now + 120_000;
  h.scheduler.setSchedule('agent-1', manualDto({ stopping: { kind: 'until', endAtEpochMs: end } }));
  h.clock.advance(60_000);
  h.scheduler.tick();
  assert.equal(h.scheduler.getSchedule('agent-1')?.nextFireAt, end);
  h.clock.advance(60_000);
  h.scheduler.tick();
  assert.equal(h.scheduler.getSchedule('agent-1')?.lifecycle, 'exhausted');
  const revision = h.scheduler.getSchedule('agent-1')!.revision;
  h.scheduler.setSchedule('agent-1', manualDto({ enabled: false, revision, stopping: { kind: 'until', endAtEpochMs: end } }));
  const pausedRevision = h.scheduler.getSchedule('agent-1')!.revision;
  h.clock.advance(1);
  h.scheduler.setSchedule('agent-1', manualDto({ revision: pausedRevision, stopping: { kind: 'until', endAtEpochMs: end } }));
  assert.equal(h.scheduler.getSchedule('agent-1')?.lifecycle, 'exhausted');
  assert.equal(h.scheduler.getSchedule('agent-1')?.nextFireAt, null);
});

test('until exhausts immediately when its first recurrence would cross the boundary', () => {
  const h = harness((firing) => confirmed(firing.agentId, h.clock.now));
  h.scheduler.setSchedule('agent-1', manualDto({ stopping: { kind: 'until', endAtEpochMs: h.clock.now + 30_000 } }));
  assert.equal(h.scheduler.getSchedule('agent-1')?.lifecycle, 'exhausted');
  assert.equal(h.scheduler.getSchedule('agent-1')?.nextFireAt, null);
});

test('count schedule cannot re-enable after its remaining budget reaches zero', () => {
  const h = harness((firing) => confirmed(firing.agentId, h.clock.now));
  h.scheduler.setSchedule('agent-1', manualDto({ stopping: { kind: 'count', remaining: 1 } }));
  h.clock.advance(60_000);
  h.scheduler.tick();
  let schedule = h.scheduler.getSchedule('agent-1')!;
  assert.equal(schedule.lifecycle, 'exhausted');
  h.scheduler.setSchedule('agent-1', manualDto({ enabled: false, revision: schedule.revision, stopping: { kind: 'count', remaining: 0 } }));
  schedule = h.scheduler.getSchedule('agent-1')!;
  h.scheduler.setSchedule('agent-1', manualDto({ revision: schedule.revision, stopping: { kind: 'count', remaining: 0 } }));
  assert.equal(h.scheduler.getSchedule('agent-1')?.lifecycle, 'exhausted');
  assert.equal(h.scheduler.getSchedule('agent-1')?.nextFireAt, null);
});

test('daily arming chooses the next requested local clock slot, not the next later minute today', () => {
  const h = harness((firing) => confirmed(firing.agentId, h.clock.now));
  h.clock.now = new Date(2026, 0, 15, 15, 0, 0, 0).getTime();
  h.scheduler.setSchedule('agent-1', manualDto({ recurrence: { kind: 'daily', atMinuteOfDay: 9 * 60 } }));
  const next = new Date(h.scheduler.getSchedule('agent-1')!.nextFireAt!);
  assert.deepEqual(
    [next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()],
    [2026, 0, 16, 9, 0],
  );
});

test('pause, re-enable, and edit invalidate held generations and recompute recurrence', () => {
  const seenGenerations: number[] = [];
  const h = harness((firing) => { seenGenerations.push(firing.generation); return { disposition: 'held' }; });
  h.scheduler.setSchedule('agent-1', manualDto());
  h.clock.advance(60_000);
  h.scheduler.tick();
  let schedule = h.scheduler.getSchedule('agent-1')!;
  h.scheduler.setSchedule('agent-1', manualDto({ enabled: false, revision: schedule.revision }));
  assert.equal(h.scheduler.history('agent-1')[0]?.outcome, 'cancelled');
  assert.equal(h.scheduler.getSchedule('agent-1')?.lifecycle, 'paused');
  schedule = h.scheduler.getSchedule('agent-1')!;
  h.scheduler.setSchedule('agent-1', manualDto({ revision: schedule.revision }));
  assert.equal(h.scheduler.getSchedule('agent-1')?.nextFireAt, h.clock.now + 60_000);
  h.clock.advance(60_000);
  h.scheduler.tick();
  assert.deepEqual(seenGenerations, [1, 3]);
  schedule = h.scheduler.getSchedule('agent-1')!;
  h.scheduler.setSchedule('agent-1', manualDto({ message: 'new bytes', revision: schedule.revision }));
  assert.equal(h.scheduler.history('agent-1').at(-1)?.outcome, 'cancelled');
  assert.equal(h.scheduler.getSchedule('agent-1')?.nextFireAt, h.clock.now + 60_000);
});

test('editing a held occurrence records cancelled as the current last outcome', () => {
  let calls = 0;
  const h = harness((firing) => (++calls === 1 ? unconfirmed(firing.agentId, h.clock.now) : { disposition: 'held' }));
  h.scheduler.setSchedule('agent-1', manualDto());
  h.clock.advance(60_000);
  h.scheduler.tick();
  assert.equal(h.scheduler.summaries()[0]?.badgeState, 'warn');
  h.clock.advance(60_000);
  h.scheduler.tick();
  const schedule = h.scheduler.getSchedule('agent-1')!;
  h.scheduler.setSchedule('agent-1', manualDto({ message: 'edited', revision: schedule.revision }));
  assert.equal(h.scheduler.getSchedule('agent-1')?.lastOutcome, 'cancelled');
  assert.equal(h.scheduler.summaries()[0]?.badgeState, 'active');
});

test('held and reviving cancel immediately; delivering records cancellation and stale completion only finalizes its row', async () => {
  let mode: 'held' | 'reviving' | 'delivering' = 'held';
  let resolveDelivery!: (result: ScheduledDeliveryResult) => void;
  const h = harness((firing) => {
    if (mode === 'reviving') { firing.markReviving(); return { disposition: 'held' }; }
    if (mode === 'delivering') {
      firing.markDelivering('subscription');
      return new Promise((resolve) => { resolveDelivery = resolve; });
    }
    return { disposition: 'held' };
  });

  h.scheduler.setSchedule('agent-1', manualDto());
  h.clock.advance(60_000);
  h.scheduler.tick();
  let schedule = h.scheduler.getSchedule('agent-1')!;
  h.scheduler.setSchedule('agent-1', manualDto({ enabled: false, revision: schedule.revision }));
  assert.equal(h.scheduler.history('agent-1').at(-1)?.outcome, 'cancelled');

  schedule = h.scheduler.getSchedule('agent-1')!;
  h.scheduler.setSchedule('agent-1', manualDto({ revision: schedule.revision }));
  mode = 'reviving';
  h.clock.advance(60_000);
  h.scheduler.tick();
  schedule = h.scheduler.getSchedule('agent-1')!;
  h.scheduler.setSchedule('agent-1', manualDto({ message: 'after revive', revision: schedule.revision }));
  assert.equal(h.scheduler.history('agent-1').at(-1)?.liveness, 'revived');
  assert.equal(h.scheduler.history('agent-1').at(-1)?.outcome, 'cancelled');

  mode = 'delivering';
  h.clock.advance(60_000);
  h.scheduler.tick();
  schedule = h.scheduler.getSchedule('agent-1')!;
  const fireCountBeforeEdit = schedule.fireCount;
  h.scheduler.setSchedule('agent-1', manualDto({ message: 'current generation', revision: schedule.revision }));
  const requestAt = h.clock.now;
  resolveDelivery(confirmed('agent-1', h.clock.now + 5));
  await Promise.resolve();
  const row = h.scheduler.history('agent-1').at(-1)!;
  assert.equal(row.outcome, 'confirmed');
  assert.equal(row.cancellationRequestedAt, requestAt);
  assert.equal(row.notificationRoute, 'subscription');
  assert.equal(h.scheduler.getSchedule('agent-1')?.message, 'current generation');
  assert.equal(h.scheduler.getSchedule('agent-1')?.fireCount, fireCountBeforeEdit);
  assert.notEqual(h.scheduler.getSchedule('agent-1')?.lastOutcome, 'confirmed');
});

test('clear and recreate keeps generation monotonic and stale completion cannot mutate the replacement schedule', async () => {
  const generations: number[] = [];
  let resolveOld!: (result: ScheduledDeliveryResult) => void;
  const h = harness((firing) => {
    generations.push(firing.generation);
    firing.markDelivering('ordinary');
    if (generations.length === 1) return new Promise((resolve) => { resolveOld = resolve; });
    return { disposition: 'held' };
  });

  h.scheduler.setSchedule('agent-1', manualDto());
  h.clock.advance(60_000);
  h.scheduler.tick();
  assert.equal(h.scheduler.clearSchedule('agent-1'), true);
  h.scheduler.setSchedule('agent-1', manualDto({ message: 'replacement' }));

  resolveOld(confirmed('agent-1', h.clock.now + 1));
  await Promise.resolve();
  assert.equal(h.scheduler.getSchedule('agent-1')?.fireCount, 0);
  assert.equal(h.scheduler.getSchedule('agent-1')?.lastOutcome, null);

  h.clock.advance(60_000);
  h.scheduler.tick();
  assert.deepEqual(generations, [1, 3]);
  assert.equal(h.scheduler.summaries()[0]?.badgeState, 'held');
});

test('post-edit collapse does not rewrite the old delivering occurrence collapse count', async () => {
  let resolveDelivery!: (result: ScheduledDeliveryResult) => void;
  const h = harness((firing) => {
    firing.markDelivering('ordinary');
    return new Promise((resolve) => { resolveDelivery = resolve; });
  });
  h.scheduler.setSchedule('agent-1', manualDto());
  h.clock.advance(60_000);
  h.scheduler.tick();
  let schedule = h.scheduler.getSchedule('agent-1')!;
  h.scheduler.setSchedule('agent-1', manualDto({ message: 'new generation', revision: schedule.revision }));
  h.clock.advance(60_000);
  h.scheduler.tick();
  resolveDelivery(confirmed('agent-1', h.clock.now));
  await Promise.resolve();
  const oldRow = h.scheduler.history('agent-1').find((row) => row.occurrenceSeq === 1)!;
  assert.equal(oldRow.collapsedCount, 0);
});

test('releaseHeld does not dispatch the same pending occurrence while delivery is in flight', async () => {
  let calls = 0;
  let resolveRelease!: (result: ScheduledDeliveryResult) => void;
  const h = harness(() => {
    calls += 1;
    if (calls === 1) return { disposition: 'held' };
    return new Promise((resolve) => { resolveRelease = resolve; });
  });
  h.scheduler.setSchedule('agent-1', manualDto());
  h.clock.advance(60_000);
  h.scheduler.tick();
  h.scheduler.releaseHeld('agent-1');
  h.scheduler.releaseHeld('agent-1');
  assert.equal(calls, 2);
  resolveRelease(confirmed('agent-1', h.clock.now));
  await Promise.resolve();
  assert.equal(h.scheduler.getSchedule('agent-1')?.fireCount, 1);
});

test('dispose orphans a delivering occurrence and its completion cannot affect a recycled agent id', async () => {
  const generations: number[] = [];
  let oldFiring!: ScheduledFiring;
  let resolveOld!: (result: ScheduledDeliveryResult) => void;
  const h = harness((firing) => {
    generations.push(firing.generation);
    firing.markDelivering('ordinary');
    if (generations.length === 1) {
      oldFiring = firing;
      return new Promise((resolve) => { resolveOld = resolve; });
    }
    return { disposition: 'held' };
  });
  h.scheduler.setSchedule('agent-1', manualDto());
  h.clock.advance(60_000);
  h.scheduler.tick();
  h.scheduler.disposeForAgent('agent-1');
  h.scheduler.setSchedule('agent-1', manualDto({ message: 'recycled agent' }));
  oldFiring.markReviving();
  resolveOld(confirmed('agent-1', h.clock.now));
  await Promise.resolve();
  h.clock.advance(60_000);
  h.scheduler.tick();
  assert.deepEqual(generations, [1, 3]);
  assert.equal(h.scheduler.getSchedule('agent-1')?.fireCount, 0);
  assert.equal(h.scheduler.summaries()[0]?.badgeState, 'held');
});

test('history is a 50-row ring and collapsed rows are compact finalized occurrences', () => {
  const h = harness(() => ({ disposition: 'held' }));
  h.scheduler.setSchedule('agent-1', manualDto());
  h.clock.advance(60_000);
  h.scheduler.tick();
  for (let index = 0; index < 55; index += 1) {
    h.clock.advance(60_000);
    h.scheduler.tick();
  }
  const rows = h.scheduler.history('agent-1');
  assert.equal(rows.length, 50);
  assert.equal(rows[0]?.outcome, 'collapsed');
  assert.equal(rows[0]?.collapsedCount, 1);
  assert.equal(rows[0]?.heldAt, null);
  assert.equal(rows.at(-1)?.occurrenceSeq, 56);
});

async function main(): Promise<void> {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      console.log(`  ok  ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${entry.name}`);
      console.error(error);
    }
  }
  if (failed > 0) {
    console.error(`agent-scheduler.test: ${tests.length - failed} passed, ${failed} failed`);
    process.exit(1);
  }
  console.log(`agent-scheduler.test: ${tests.length} passed`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
