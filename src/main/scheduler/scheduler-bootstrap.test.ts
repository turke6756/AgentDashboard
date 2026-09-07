import assert from 'node:assert/strict';
import test from 'node:test';
import type { ScheduleSetDto } from '../../shared/schedule-types';
import type { ScheduledFiring } from './agent-scheduler';
import { bootstrapAgentScheduler, type SchedulerBootstrapDeps } from './scheduler-bootstrap';

type Listener = (event: { agentId: string }) => void;

test('bootstrap starts one scheduler and owns status, deletion and quit lifecycle', () => {
  const listeners = new Map<string, Set<Listener>>();
  const appListeners = new Map<string, () => void>();
  let timerCallback: (() => void) | null = null;
  let clearedHandle: unknown = null;
  let deliveryCalls = 0;
  let nowMs = 1_000;
  const supervisor: SchedulerBootstrapDeps['supervisor'] = {
    deliverScheduledFiring: (_firing: ScheduledFiring) => {
      deliveryCalls += 1;
      return { disposition: 'held' };
    },
    on: (event, listener) => {
      const bucket = listeners.get(event) ?? new Set<Listener>();
      bucket.add(listener);
      listeners.set(event, bucket);
    },
    off: (event, listener) => { listeners.get(event)?.delete(listener); },
  };

  const scheduler = bootstrapAgentScheduler({
    supervisor,
    app: { on: (event, listener) => { appListeners.set(event, listener); } },
    getAgent: (agentId) => agentId === 'agent-1' ? {} : null,
    now: () => nowMs,
    setInterval: (callback, intervalMs) => {
      assert.equal(intervalMs, 1_000);
      timerCallback = callback;
      return 'cron-timer';
    },
    clearInterval: (handle) => { clearedHandle = handle; },
  });

  assert.equal(typeof timerCallback, 'function', 'REACHABILITY:cron-bootstrap');
  assert.equal(listeners.get('statusChanged')?.size, 1);
  assert.equal(listeners.get('agentDeleted')?.size, 1);
  assert.equal(typeof appListeners.get('before-quit'), 'function');

  const dto: ScheduleSetDto = {
    message: 'hello', recurrence: { kind: 'interval', everyMs: 60_000 },
    stopping: { kind: 'manual' }, enabled: true, revision: null,
  };
  scheduler.setSchedule('agent-1', dto);
  nowMs = 61_000;
  timerCallback!();
  assert.equal(deliveryCalls, 1);
  // Make the interval schedule due, then prove the status subscription releases
  // the held occurrence through the same production scheduler.
  listeners.get('statusChanged')?.forEach((listener) => listener({ agentId: 'agent-1' }));
  assert.equal(deliveryCalls, 2);
  listeners.get('agentDeleted')?.forEach((listener) => listener({ agentId: 'agent-1' }));
  assert.equal(scheduler.getSchedule('agent-1'), null);

  appListeners.get('before-quit')!();
  assert.equal(clearedHandle, 'cron-timer');
  assert.equal(listeners.get('statusChanged')?.size, 0);
  assert.equal(listeners.get('agentDeleted')?.size, 0);
});
