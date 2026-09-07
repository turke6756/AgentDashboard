import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEDULE_CHANNELS } from '../../shared/types';
import type { ScheduleSetDto } from '../../shared/schedule-types';
import type { IpcLike } from '../git-checkpoints/checkpoint-ipc';
import { AgentScheduleStore } from './agent-schedule-store';
import { AgentScheduler } from './agent-scheduler';
import { registerScheduleIpc } from './schedule-ipc';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fixture() {
  const handlers = new Map<string, Handler>();
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const ipc: IpcLike = {
    handle: (channel, listener) => { handlers.set(channel, listener); },
  };
  const store = new AgentScheduleStore({
    agentExists: (agentId) => agentId === 'agent-1',
    now: () => 1_000,
    createId: () => 'schedule-1',
  });
  const scheduler = new AgentScheduler({ store, deliver: () => ({ disposition: 'held' }), now: () => 1_000 });
  registerScheduleIpc(ipc, scheduler, (channel, payload) => { broadcasts.push({ channel, payload }); });
  return { handlers, broadcasts };
}

const createDto: ScheduleSetDto = {
  message: 'check the dashboard',
  recurrence: { kind: 'interval', everyMs: 60_000 },
  stopping: { kind: 'manual' },
  enabled: true,
  revision: null,
};

test('registers the complete schedule IPC seam', () => {
  const { handlers } = fixture();
  assert.deepEqual(
    [...handlers.keys()].sort(),
    [
      SCHEDULE_CHANNELS.hydrate,
      SCHEDULE_CHANNELS.set,
      SCHEDULE_CHANNELS.get,
      SCHEDULE_CHANNELS.clear,
      SCHEDULE_CHANNELS.history,
    ].sort(),
    'REACHABILITY:cron-schedule-ipc',
  );
});

test('create, hydrate, get, history and clear share one scheduler and broadcast changes', () => {
  const { handlers, broadcasts } = fixture();
  const created = handlers.get(SCHEDULE_CHANNELS.set)!({}, 'agent-1', createDto) as { revision: number };
  assert.equal(created.revision, 1);
  assert.equal((handlers.get(SCHEDULE_CHANNELS.get)!({}, 'agent-1') as { id: string }).id, 'schedule-1');
  assert.equal((handlers.get(SCHEDULE_CHANNELS.hydrate)!({}, 'workspace-1') as unknown[]).length, 1);
  assert.deepEqual(handlers.get(SCHEDULE_CHANNELS.history)!({}, 'agent-1'), []);
  assert.equal(handlers.get(SCHEDULE_CHANNELS.clear)!({}, 'agent-1'), true);
  assert.deepEqual(broadcasts, [
    {
      channel: SCHEDULE_CHANNELS.changed,
      payload: {
        agentId: 'agent-1',
        scheduleSummary: {
          agentId: 'agent-1',
          scheduleId: 'schedule-1',
          lifecycle: 'active',
          badgeState: 'active',
          nextFireAt: 61_000,
          lastOutcome: null,
          revision: 1,
        },
      },
    },
    { channel: SCHEDULE_CHANNELS.changed, payload: { agentId: 'agent-1', scheduleSummary: null } },
  ]);
});

test('maps every store validation family to the IPC contract status', () => {
  const { handlers } = fixture();
  const set = handlers.get(SCHEDULE_CHANNELS.set)!;
  const expectCode = (agentId: string, dto: ScheduleSetDto, statusCode: number, code: string) => {
    assert.throws(
      () => set({}, agentId, dto),
      (error: unknown) => {
        const mapped = error as { statusCode?: number; code?: string };
        return mapped.statusCode === statusCode && mapped.code === code;
      },
    );
  };

  expectCode('missing', createDto, 404, 'no-agent');
  expectCode('agent-1', { ...createDto, message: ' ' }, 400, 'message-invalid');
  expectCode('agent-1', { ...createDto, recurrence: { kind: 'interval', everyMs: 1 } }, 400, 'interval-out-of-range');
  expectCode('agent-1', { ...createDto, recurrence: { kind: 'daily', atMinuteOfDay: 1440 } }, 400, 'minute-invalid');
  expectCode('agent-1', { ...createDto, stopping: { kind: 'count', remaining: 0 } }, 400, 'count-invalid');
  expectCode('agent-1', { ...createDto, stopping: { kind: 'until', endAtEpochMs: 999 } }, 400, 'end-in-past');
  set({}, 'agent-1', createDto);
  expectCode('agent-1', createDto, 409, 'schedule-exists');
  expectCode('agent-1', { ...createDto, revision: 99 }, 409, 'revision-conflict');
});
