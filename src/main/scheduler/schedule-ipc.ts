import type { IpcLike } from '../git-checkpoints/checkpoint-ipc';
import type { AgentSchedule } from '../../shared/schedule-types';
import type { ScheduleSetDto } from '../../shared/schedule-types';
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

function rejectBoundary(code: ScheduleValidationCode, statusCode: 400 | 404 | 409): never {
  throw new ScheduleIpcError(code, statusCode);
}

function guardScheduleSet(agentId: unknown, dto: unknown): { agentId: string; dto: ScheduleSetDto } {
  if (typeof agentId !== 'string') rejectBoundary('no-agent', 404);
  if (typeof dto !== 'object' || dto === null) rejectBoundary('message-invalid', 400);
  const value = dto as Record<string, unknown>;
  if (typeof value.message !== 'string' || typeof value.enabled !== 'boolean') {
    rejectBoundary('message-invalid', 400);
  }
  if (typeof value.recurrence !== 'object' || value.recurrence === null) {
    rejectBoundary('interval-out-of-range', 400);
  }
  const recurrenceKind = (value.recurrence as { kind?: unknown }).kind;
  if (recurrenceKind !== 'interval' && recurrenceKind !== 'daily') {
    rejectBoundary('interval-out-of-range', 400);
  }
  if (typeof value.stopping !== 'object' || value.stopping === null) {
    rejectBoundary('count-invalid', 400);
  }
  const stoppingKind = (value.stopping as { kind?: unknown }).kind;
  if (stoppingKind !== 'count' && stoppingKind !== 'until' && stoppingKind !== 'manual') {
    rejectBoundary('count-invalid', 400);
  }
  if (value.revision !== null && typeof value.revision !== 'number') {
    rejectBoundary('revision-conflict', 409);
  }
  return { agentId, dto: value as unknown as ScheduleSetDto };
}

export function registerScheduleIpc(
  ipc: IpcLike,
  scheduler: AgentScheduler,
  broadcast: ScheduleChangedBroadcast = () => {},
  getAgent: (agentId: string) => { workspaceId: string } | null = () => null,
): void {
  ipc.handle(SCHEDULE_CHANNELS.hydrate, (_event, workspaceId: unknown) =>
    scheduler.summaries().filter((summary) => getAgent(summary.agentId)?.workspaceId === workspaceId));
  ipc.handle(SCHEDULE_CHANNELS.set, (_event, agentId: unknown, dto: unknown): AgentSchedule => {
    try {
      const guarded = guardScheduleSet(agentId, dto);
      const schedule = scheduler.setSchedule(guarded.agentId, guarded.dto);
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
