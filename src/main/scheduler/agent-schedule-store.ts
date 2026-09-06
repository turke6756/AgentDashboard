import { randomUUID } from 'node:crypto';
import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  type AgentSchedule,
  type FiringHistoryRow,
  type ScheduleSetDto,
} from '../../shared/schedule-types';

export type ScheduleValidationCode =
  | 'no-agent'
  | 'message-invalid'
  | 'interval-out-of-range'
  | 'minute-invalid'
  | 'count-invalid'
  | 'end-in-past'
  | 'schedule-exists'
  | 'revision-conflict';

export class ScheduleValidationError extends Error {
  constructor(readonly code: ScheduleValidationCode) {
    super(code);
    this.name = 'ScheduleValidationError';
  }
}

export interface AgentScheduleStoreOptions {
  agentExists: (agentId: string) => boolean;
  now?: () => number;
  createId?: () => string;
  maxMessageLength?: number;
}

const HISTORY_LIMIT = 50;
const DEFAULT_MAX_MESSAGE_LENGTH = 100_000;

function cloneSchedule(schedule: AgentSchedule): AgentSchedule {
  return structuredClone(schedule);
}

function sameStoppingRule(a: AgentSchedule['stopping'], b: AgentSchedule['stopping']): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'manual') return true;
  if (a.kind === 'count' && b.kind === 'count') return a.remaining === b.remaining;
  return a.kind === 'until' && b.kind === 'until' && a.endAtEpochMs === b.endAtEpochMs;
}

export class AgentScheduleStore {
  private readonly schedules = new Map<string, AgentSchedule>();
  private readonly historyRows = new Map<string, FiringHistoryRow[]>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxMessageLength: number;

  constructor(private readonly options: AgentScheduleStoreOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.maxMessageLength = options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
  }

  set(agentId: string, dto: ScheduleSetDto): AgentSchedule {
    const existing = this.schedules.get(agentId);
    this.validate(agentId, dto, existing);
    const now = this.now();

    if (!existing) {
      const created: AgentSchedule = {
        id: this.createId(),
        agentId,
        message: dto.message,
        recurrence: structuredClone(dto.recurrence),
        stopping: structuredClone(dto.stopping),
        enabled: dto.enabled,
        lifecycle: dto.enabled ? 'active' : 'paused',
        revision: 1,
        createdAtEpochMs: now,
        updatedAtEpochMs: now,
        nextFireAt: null,
        lastFiredAt: null,
        fireCount: 0,
        occurrenceCount: 0,
        lastOutcome: null,
        lastNotificationRoute: null,
      };
      this.schedules.set(agentId, created);
      this.historyRows.set(created.id, []);
      return cloneSchedule(created);
    }

    existing.message = dto.message;
    existing.recurrence = structuredClone(dto.recurrence);
    existing.stopping = structuredClone(dto.stopping);
    existing.enabled = dto.enabled;
    existing.revision += 1;
    existing.updatedAtEpochMs = now;
    return cloneSchedule(existing);
  }

  get(agentId: string): AgentSchedule | null {
    const schedule = this.schedules.get(agentId);
    return schedule ? cloneSchedule(schedule) : null;
  }

  list(): AgentSchedule[] {
    return [...this.schedules.values()].map(cloneSchedule);
  }

  mutate(agentId: string, update: (schedule: AgentSchedule) => void): AgentSchedule | null {
    const schedule = this.schedules.get(agentId);
    if (!schedule) return null;
    update(schedule);
    return cloneSchedule(schedule);
  }

  appendHistory(agentId: string, row: FiringHistoryRow): void {
    const schedule = this.schedules.get(agentId);
    if (!schedule || schedule.id !== row.scheduleId) return;
    const rows = this.historyRows.get(schedule.id) ?? [];
    rows.push(structuredClone(row));
    if (rows.length > HISTORY_LIMIT) rows.splice(0, rows.length - HISTORY_LIMIT);
    this.historyRows.set(schedule.id, rows);
  }

  history(agentId: string): FiringHistoryRow[] {
    const schedule = this.schedules.get(agentId);
    if (!schedule) return [];
    return (this.historyRows.get(schedule.id) ?? []).map((row) => structuredClone(row));
  }

  clear(agentId: string): boolean {
    const schedule = this.schedules.get(agentId);
    if (!schedule) return false;
    this.schedules.delete(agentId);
    this.historyRows.delete(schedule.id);
    return true;
  }

  disposeForAgent(agentId: string): void {
    this.clear(agentId);
  }

  private validate(agentId: string, dto: ScheduleSetDto, existing?: AgentSchedule): void {
    if (!this.options.agentExists(agentId)) throw new ScheduleValidationError('no-agent');
    if (dto.message.trim().length === 0 || dto.message.length > this.maxMessageLength) {
      throw new ScheduleValidationError('message-invalid');
    }
    if (dto.recurrence.kind === 'interval') {
      if (
        !Number.isFinite(dto.recurrence.everyMs) ||
        dto.recurrence.everyMs < MIN_INTERVAL_MS ||
        dto.recurrence.everyMs > MAX_INTERVAL_MS
      ) {
        throw new ScheduleValidationError('interval-out-of-range');
      }
    } else if (!Number.isInteger(dto.recurrence.atMinuteOfDay) || dto.recurrence.atMinuteOfDay < 0 || dto.recurrence.atMinuteOfDay > 1439) {
      throw new ScheduleValidationError('minute-invalid');
    }

    const sameStopping = existing ? sameStoppingRule(existing.stopping, dto.stopping) : false;
    if (dto.stopping.kind === 'count' && (!Number.isInteger(dto.stopping.remaining) || dto.stopping.remaining <= 0)) {
      if (!(sameStopping && existing?.stopping.kind === 'count' && existing.stopping.remaining === 0)) {
        throw new ScheduleValidationError('count-invalid');
      }
    }
    if (dto.stopping.kind === 'until' && dto.stopping.endAtEpochMs < this.now() && !sameStopping) {
      throw new ScheduleValidationError('end-in-past');
    }
    if (!existing && dto.revision !== null) throw new ScheduleValidationError('revision-conflict');
    if (existing && dto.revision === null) throw new ScheduleValidationError('schedule-exists');
    if (existing && dto.revision !== existing.revision) throw new ScheduleValidationError('revision-conflict');
  }
}

