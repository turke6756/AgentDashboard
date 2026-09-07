import type { IpcLike } from '../git-checkpoints/checkpoint-ipc';
import type { AgentSchedule } from '../../shared/schedule-types';
import { SCHEDULE_CHANNELS } from '../../shared/types';
import { ScheduleValidationError, type ScheduleValidationCode } from './agent-schedule-store';
import type { AgentScheduler } from './agent-scheduler';

export type ScheduleChangedBroadcast = (channel: string, payload: unknown) => void;

export class ScheduleIpcError extends Error {
  constructor(readonly code: ScheduleValidationCode, readonly statusCode: 400 | 404 | 409) {
    super(code);
    this.name = 'ScheduleIpcError';
  }
}

function mapValidationError(error: unknown): never {
  if (!(error instanceof ScheduleValidationError)) throw error;
  const statusCode = error.code === 'no-agent'
    ? 404
    : error.code === 'schedule-exists' || error.code === 'revision-conflict'
      ? 409
      : 400;
  throw new ScheduleIpcError(error.code, statusCode);
}

function summaryFor(scheduler: AgentScheduler, agentId: string) {
  return scheduler.summaries().find((summary) => summary.agentId === agentId) ?? null;
}

export function registerScheduleIpc(
  ipc: IpcLike,
  scheduler: AgentScheduler,
  broadcast: ScheduleChangedBroadcast = () => {},
): void {
  ipc.handle(SCHEDULE_CHANNELS.hydrate, (_event, _workspaceId: unknown) => scheduler.summaries());
  ipc.handle(SCHEDULE_CHANNELS.set, (_event, agentId: unknown, dto: unknown): AgentSchedule => {
    try {
      const schedule = scheduler.setSchedule(agentId as string, dto as Parameters<AgentScheduler['setSchedule']>[1]);
      broadcast(SCHEDULE_CHANNELS.changed, {
        agentId: schedule.agentId,
        scheduleSummary: summaryFor(scheduler, schedule.agentId),
      });
      return schedule;
    } catch (error) {
      return mapValidationError(error);
    }
  });
  ipc.handle(SCHEDULE_CHANNELS.get, (_event, agentId: unknown) => scheduler.getSchedule(agentId as string));
  ipc.handle(SCHEDULE_CHANNELS.clear, (_event, agentId: unknown) => {
    const cleared = scheduler.clearSchedule(agentId as string);
    if (cleared) {
      broadcast(SCHEDULE_CHANNELS.changed, { agentId, scheduleSummary: null });
    }
    return cleared;
  });
  ipc.handle(SCHEDULE_CHANNELS.history, (_event, agentId: unknown) => scheduler.history(agentId as string));
}
