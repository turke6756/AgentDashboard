export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 2_592_000_000;

type RecurrenceRule =
  | { kind: 'interval'; everyMs: number }        // within [60_000, 2_592_000_000]
  | { kind: 'daily';    atMinuteOfDay: number }; // 0..1439, host-local

type StoppingRule =
  | { kind: 'count';  remaining: number }        // budget of DUE occurrences
  | { kind: 'until';  endAtEpochMs: number }
  | { kind: 'manual' };

type FiringOutcome =
  | 'confirmed' | 'unconfirmed' | 'collapsed' | 'cancelled'
  | { failed: 'delivery-failed' | 'interactive-prompt' | 'provider-no-revive' | 'revive-failed' };

type NotificationRoute = 'ordinary' | 'subscription' | 'unavailable';

interface AgentSchedule {                          // durable DTO — no runtime/hold state
  id: string;                                      // uuid, immutable
  agentId: string;                                 // immutable, 1:1
  message: string;                                 // stored verbatim (original bytes)
  recurrence: RecurrenceRule;
  stopping: StoppingRule;
  enabled: boolean;
  lifecycle: 'active' | 'paused' | 'exhausted';
  revision: number;                                // ++ on each successful set (optimistic concurrency)
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
  nextFireAt: number | null;                       // scheduler is SOLE writer; null when paused/exhausted
  lastFiredAt: number | null;
  fireCount: number;                               // confirmed turns only
  occurrenceCount: number;                         // claimed due slots (incl. collapsed)
  lastOutcome: FiringOutcome | null;
  lastNotificationRoute: NotificationRoute | null; // route chosen for the last firing
}

interface ScheduleSummary {                        // per-card hydration + schedule:changed payload
  agentId: string; scheduleId: string;
  lifecycle: 'active' | 'paused' | 'exhausted';
  badgeState: 'active' | 'held' | 'reviving' | 'warn' | 'paused' | 'exhausted';
  nextFireAt: number | null;
  lastOutcome: FiringOutcome | null;
  revision: number;
}

interface FiringHistoryRow {                        // one finalized row per due occurrence
  scheduleId: string; occurrenceSeq: number;
  dueAt: number;
  heldAt: number | null; revivedAt: number | null; firedAt: number | null;
  collapsedCount: number;
  liveness: 'idle' | 'held' | 'revived' | null;
  outcome: FiringOutcome;
  notificationRoute: NotificationRoute | null;      // the route established for this firing (not a delivery claim)
  cancellationRequestedAt: number | null;
  confirmationSource: 'hook' | 'session-log' | 'status' | null;
  completedAt: number | null;
}

type ScheduleSetDto = {                             // IPC input whitelist — no bookkeeping fields
  message: string; recurrence: RecurrenceRule; stopping: StoppingRule;
  enabled: boolean; revision: number | null;       // null = create, numeric = update
};

export type {
  AgentSchedule,
  FiringHistoryRow,
  FiringOutcome,
  NotificationRoute,
  RecurrenceRule,
  ScheduleSetDto,
  ScheduleSummary,
  StoppingRule,
};
