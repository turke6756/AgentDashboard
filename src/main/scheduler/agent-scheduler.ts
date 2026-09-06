import type { SendOutcome } from '../../shared/types';
import type {
  AgentSchedule,
  FiringHistoryRow,
  FiringOutcome,
  NotificationRoute,
  ScheduleSetDto,
  ScheduleSummary,
} from '../../shared/schedule-types';
import { AgentScheduleStore } from './agent-schedule-store';
import { computeNextFireAt, evaluateUntilBoundary, firstFutureDailySlot } from './recurrence';

export type ScheduledDeliveryResult =
  | { disposition: 'held' }
  | { disposition: 'sent'; outcome: SendOutcome };

export interface ScheduledFiring {
  agentId: string;
  scheduleId: string;
  text: string;
  dueAt: number;
  generation: number;
  markReviving: () => void;
  markDelivering: (notificationRoute?: NotificationRoute | null) => void;
  finalizeFailure: (failure: Extract<FiringOutcome, { failed: string }>['failed']) => void;
}

type RuntimeState =
  | { kind: 'idle' }
  | { kind: 'held'; dueAt: number; collapsedCount: number; generation: number }
  | { kind: 'reviving'; dueAt: number; collapsedCount: number; generation: number }
  | { kind: 'delivering'; dueAt: number; collapsedCount: number; generation: number; cancellationRequestedAt: number | null };

interface PendingOccurrence {
  agentId: string;
  scheduleId: string;
  occurrenceSeq: number;
  dueAt: number;
  generation: number;
  text: string;
  heldAt: number | null;
  revivedAt: number | null;
  firedAt: number | null;
  collapsedCount: number;
  liveness: FiringHistoryRow['liveness'];
  notificationRoute: NotificationRoute | null;
  cancellationRequestedAt: number | null;
  dispatching: boolean;
  finalized: boolean;
}

export interface AgentSchedulerOptions {
  store: AgentScheduleStore;
  deliver: (firing: ScheduledFiring) => ScheduledDeliveryResult | Promise<ScheduledDeliveryResult>;
  now?: () => number;
  setInterval?: (callback: () => void, intervalMs: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

function stoppingRuleEqual(a: AgentSchedule['stopping'], b: AgentSchedule['stopping']): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'manual') return true;
  if (a.kind === 'count' && b.kind === 'count') return a.remaining === b.remaining;
  return a.kind === 'until' && b.kind === 'until' && a.endAtEpochMs === b.endAtEpochMs;
}

function initialNextFireAt(schedule: AgentSchedule, now: number): number {
  return schedule.recurrence.kind === 'interval'
    ? now + schedule.recurrence.everyMs
    : firstFutureDailySlot(now, schedule.recurrence.atMinuteOfDay);
}

export class AgentScheduler {
  private readonly now: () => number;
  private readonly setIntervalFn: (callback: () => void, intervalMs: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly runtimeByAgent = new Map<string, RuntimeState>();
  private readonly generationByAgent = new Map<string, number>();
  private readonly pendingByAgent = new Map<string, PendingOccurrence>();
  private readonly inFlightByAgent = new Map<string, Promise<void>>();
  private intervalHandle: unknown = null;

  constructor(private readonly options: AgentSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.setIntervalFn = options.setInterval ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.clearIntervalFn = options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  }

  start(): void {
    if (this.intervalHandle !== null) return;
    this.intervalHandle = this.setIntervalFn(() => this.tick(), 1_000);
  }

  stop(): void {
    if (this.intervalHandle !== null) this.clearIntervalFn(this.intervalHandle);
    this.intervalHandle = null;
    for (const agentId of [...this.pendingByAgent.keys()]) this.cancelPending(agentId);
  }

  setSchedule(agentId: string, dto: ScheduleSetDto): AgentSchedule {
    const before = this.options.store.get(agentId);
    const schedule = this.options.store.set(agentId, dto);
    if (before) this.bumpGenerationAndCancel(agentId);
    else this.generationByAgent.set(agentId, (this.generationByAgent.get(agentId) ?? 0) + 1);
    const stoppingReplaced = before ? !stoppingRuleEqual(before.stopping, schedule.stopping) : true;
    const now = this.now();

    return this.options.store.mutate(agentId, (mutable) => {
      if (!mutable.enabled) {
        mutable.lifecycle = 'paused';
        mutable.nextFireAt = null;
        return;
      }
      const exhausted =
        (mutable.stopping.kind === 'count' && mutable.stopping.remaining === 0) ||
        (mutable.stopping.kind === 'until' && mutable.stopping.endAtEpochMs < now);
      if (exhausted && !stoppingReplaced) {
        mutable.lifecycle = 'exhausted';
        mutable.nextFireAt = null;
        return;
      }
      mutable.lifecycle = 'active';
      mutable.nextFireAt = initialNextFireAt(mutable, now);
      if (mutable.stopping.kind === 'until' && mutable.nextFireAt > mutable.stopping.endAtEpochMs) {
        mutable.lifecycle = 'exhausted';
        mutable.nextFireAt = null;
      }
    })!;
  }

  getSchedule(agentId: string): AgentSchedule | null {
    return this.options.store.get(agentId);
  }

  history(agentId: string): FiringHistoryRow[] {
    return this.options.store.history(agentId);
  }

  summaries(): ScheduleSummary[] {
    return this.options.store.list().map((schedule) => this.summaryFor(schedule));
  }

  clearSchedule(agentId: string): boolean {
    this.bumpGenerationAndCancel(agentId);
    this.pendingByAgent.delete(agentId);
    this.inFlightByAgent.delete(agentId);
    this.runtimeByAgent.delete(agentId);
    return this.options.store.clear(agentId);
  }

  disposeForAgent(agentId: string): void {
    this.clearSchedule(agentId);
  }

  tick(): void {
    const now = this.now();
    for (const schedule of this.options.store.list()) {
      if (!schedule.enabled || schedule.lifecycle !== 'active' || schedule.nextFireAt === null || schedule.nextFireAt > now) continue;
      const runtime = this.runtimeByAgent.get(schedule.agentId) ?? { kind: 'idle' as const };
      if (runtime.kind === 'idle') this.claim(schedule, now);
      else {
        runtime.generation = this.generationByAgent.get(schedule.agentId) ?? runtime.generation;
        this.collapse(schedule, runtime, now);
      }
    }
  }

  releaseHeld(agentId: string): void {
    const runtime = this.runtimeByAgent.get(agentId);
    const pending = this.pendingByAgent.get(agentId);
    if (!pending || (runtime?.kind !== 'held' && runtime?.kind !== 'reviving')) return;
    this.dispatch(pending);
  }

  private claim(schedule: AgentSchedule, now: number): void {
    const dueAt = schedule.nextFireAt!;
    const generation = this.generationByAgent.get(schedule.agentId) ?? 1;
    const occurrenceSeq = schedule.occurrenceCount + 1;
    this.advanceAndConsume(schedule.agentId, dueAt, now);
    const pending: PendingOccurrence = {
      agentId: schedule.agentId,
      scheduleId: schedule.id,
      occurrenceSeq,
      dueAt,
      generation,
      text: schedule.message,
      heldAt: null,
      revivedAt: null,
      firedAt: null,
      collapsedCount: 0,
      liveness: 'idle',
      notificationRoute: null,
      cancellationRequestedAt: null,
      dispatching: false,
      finalized: false,
    };
    this.pendingByAgent.set(schedule.agentId, pending);
    this.runtimeByAgent.set(schedule.agentId, { kind: 'held', dueAt, collapsedCount: 0, generation });
    this.dispatch(pending);
  }

  private collapse(schedule: AgentSchedule, runtime: Exclude<RuntimeState, { kind: 'idle' }>, now: number): void {
    const dueAt = schedule.nextFireAt!;
    const occurrenceSeq = schedule.occurrenceCount + 1;
    this.advanceAndConsume(schedule.agentId, dueAt, now);
    runtime.collapsedCount += 1;
    const pending = this.pendingByAgent.get(schedule.agentId);
    if (pending && pending.generation === runtime.generation) pending.collapsedCount += 1;
    this.options.store.appendHistory(schedule.agentId, {
      scheduleId: schedule.id,
      occurrenceSeq,
      dueAt,
      heldAt: null,
      revivedAt: null,
      firedAt: null,
      collapsedCount: 1,
      liveness: null,
      outcome: 'collapsed',
      notificationRoute: null,
      cancellationRequestedAt: null,
      confirmationSource: null,
      completedAt: now,
    });
    this.options.store.mutate(schedule.agentId, (mutable) => {
      mutable.lastOutcome = 'collapsed';
    });
  }

  private advanceAndConsume(agentId: string, dueAt: number, now: number): void {
    this.options.store.mutate(agentId, (schedule) => {
      schedule.occurrenceCount += 1;
      if (schedule.stopping.kind === 'count') schedule.stopping.remaining -= 1;
      const computed = computeNextFireAt(schedule.recurrence, dueAt, now);
      if (schedule.stopping.kind === 'count' && schedule.stopping.remaining === 0) {
        schedule.nextFireAt = null;
        schedule.lifecycle = 'exhausted';
      } else if (schedule.stopping.kind === 'until') {
        const boundary = evaluateUntilBoundary(dueAt, computed, schedule.stopping.endAtEpochMs);
        schedule.nextFireAt = boundary.nextFireAt;
        if (boundary.exhausted) schedule.lifecycle = 'exhausted';
      } else {
        schedule.nextFireAt = computed;
      }
    });
  }

  private dispatch(pending: PendingOccurrence): void {
    if (pending.finalized || pending.dispatching || this.inFlightByAgent.has(pending.agentId)) return;
    pending.dispatching = true;
    const firing: ScheduledFiring = {
      agentId: pending.agentId,
      scheduleId: pending.scheduleId,
      text: pending.text,
      dueAt: pending.dueAt,
      generation: pending.generation,
      markReviving: () => this.markReviving(pending),
      markDelivering: (route) => this.markDelivering(pending, route),
      finalizeFailure: (failure) => this.finalize(pending, { failed: failure }, this.now()),
    };
    let result: ScheduledDeliveryResult | Promise<ScheduledDeliveryResult>;
    try {
      result = this.options.deliver(firing);
    } catch {
      pending.dispatching = false;
      this.finalize(pending, { failed: 'delivery-failed' }, this.now());
      return;
    }
    if (result instanceof Promise || (typeof result === 'object' && result !== null && 'then' in result)) {
      const inFlight = Promise.resolve(result)
        .then(
          (resolved) => this.handleDeliveryResult(pending, resolved),
          () => this.finalize(pending, { failed: 'delivery-failed' }, this.now()),
        )
        .finally(() => {
          if (this.inFlightByAgent.get(pending.agentId) === inFlight) {
            this.inFlightByAgent.delete(pending.agentId);
          }
        });
      this.inFlightByAgent.set(pending.agentId, inFlight);
      pending.dispatching = false;
      void inFlight;
    } else {
      pending.dispatching = false;
      this.handleDeliveryResult(pending, result);
    }
  }

  private handleDeliveryResult(pending: PendingOccurrence, result: ScheduledDeliveryResult): void {
    if (pending.finalized) return;
    if (result.disposition === 'held') {
      const runtime = this.runtimeByAgent.get(pending.agentId);
      if (this.isCurrentPending(pending) && runtime?.kind !== 'reviving') {
        if (pending.heldAt === null) pending.heldAt = this.now();
        pending.liveness = 'held';
        this.runtimeByAgent.set(pending.agentId, {
          kind: 'held',
          dueAt: pending.dueAt,
          collapsedCount: pending.collapsedCount,
          generation: pending.generation,
        });
      }
      return;
    }
    if (pending.firedAt === null) this.markDelivering(pending);
    const outcome: FiringOutcome = result.outcome.disposition === 'confirmed'
      ? 'confirmed'
      : result.outcome.disposition === 'delivered-unconfirmed'
        ? 'unconfirmed'
        : { failed: result.outcome.reason === 'interactive-prompt' ? 'interactive-prompt' : 'delivery-failed' };
    this.finalize(pending, outcome, result.outcome.completedAt, result.outcome.confirmationSource ?? null);
  }

  private markReviving(pending: PendingOccurrence): void {
    if (pending.finalized) return;
    const now = this.now();
    if (pending.heldAt === null) pending.heldAt = now;
    pending.revivedAt = now;
    pending.liveness = 'revived';
    if (this.isCurrentPending(pending)) {
      this.runtimeByAgent.set(pending.agentId, {
        kind: 'reviving', dueAt: pending.dueAt, collapsedCount: pending.collapsedCount, generation: pending.generation,
      });
    }
  }

  private markDelivering(pending: PendingOccurrence, route: NotificationRoute | null = null): void {
    if (pending.finalized) return;
    if (pending.firedAt === null) pending.firedAt = this.now();
    if (route !== null) pending.notificationRoute = route;
    if (this.isCurrentPending(pending)) {
      this.runtimeByAgent.set(pending.agentId, {
        kind: 'delivering',
        dueAt: pending.dueAt,
        collapsedCount: pending.collapsedCount,
        generation: pending.generation,
        cancellationRequestedAt: pending.cancellationRequestedAt,
      });
    }
  }

  private finalize(
    pending: PendingOccurrence,
    outcome: FiringOutcome,
    completedAt: number,
    confirmationSource: FiringHistoryRow['confirmationSource'] = null,
  ): void {
    if (pending.finalized) return;
    pending.finalized = true;
    this.options.store.appendHistory(pending.agentId, {
      scheduleId: pending.scheduleId,
      occurrenceSeq: pending.occurrenceSeq,
      dueAt: pending.dueAt,
      heldAt: pending.heldAt,
      revivedAt: pending.revivedAt,
      firedAt: pending.firedAt,
      collapsedCount: pending.collapsedCount,
      liveness: pending.liveness,
      outcome,
      notificationRoute: pending.notificationRoute,
      cancellationRequestedAt: pending.cancellationRequestedAt,
      confirmationSource,
      completedAt,
    });

    const currentGeneration = this.generationByAgent.get(pending.agentId);
    const currentPending = this.pendingByAgent.get(pending.agentId);
    const currentSchedule = this.options.store.get(pending.agentId);
    if (
      currentGeneration === pending.generation &&
      currentPending === pending &&
      currentSchedule?.id === pending.scheduleId
    ) {
      this.options.store.mutate(pending.agentId, (schedule) => {
        schedule.lastOutcome = outcome;
        schedule.lastNotificationRoute = pending.notificationRoute;
        if (outcome === 'confirmed') {
          schedule.fireCount += 1;
          schedule.lastFiredAt = pending.firedAt;
        }
      });
      this.runtimeByAgent.set(pending.agentId, { kind: 'idle' });
      this.pendingByAgent.delete(pending.agentId);
    } else if (currentPending === pending) {
      this.pendingByAgent.delete(pending.agentId);
      this.runtimeByAgent.set(pending.agentId, { kind: 'idle' });
    }
  }

  private bumpGenerationAndCancel(agentId: string): void {
    const runtime = this.runtimeByAgent.get(agentId);
    if (runtime?.kind !== 'delivering') this.cancelPending(agentId);
    this.generationByAgent.set(agentId, (this.generationByAgent.get(agentId) ?? 0) + 1);
    if (runtime?.kind === 'delivering') this.cancelPending(agentId);
  }

  private isCurrentPending(pending: PendingOccurrence): boolean {
    return this.pendingByAgent.get(pending.agentId) === pending &&
      this.generationByAgent.get(pending.agentId) === pending.generation &&
      this.options.store.get(pending.agentId)?.id === pending.scheduleId;
  }

  private cancelPending(agentId: string): void {
    const pending = this.pendingByAgent.get(agentId);
    if (!pending || pending.finalized) return;
    const runtime = this.runtimeByAgent.get(agentId);
    if (runtime?.kind === 'delivering') {
      const now = this.now();
      pending.cancellationRequestedAt = now;
      runtime.cancellationRequestedAt = now;
      return;
    }
    this.finalize(pending, 'cancelled', this.now());
  }

  private summaryFor(schedule: AgentSchedule): ScheduleSummary {
    const runtime = this.runtimeByAgent.get(schedule.agentId) ?? { kind: 'idle' as const };
    let badgeState: ScheduleSummary['badgeState'];
    if (runtime.kind === 'held') badgeState = 'held';
    else if (runtime.kind === 'reviving') badgeState = 'reviving';
    else if (schedule.lifecycle === 'paused') badgeState = 'paused';
    else if (schedule.lifecycle === 'exhausted') badgeState = 'exhausted';
    else if (schedule.lastOutcome === 'unconfirmed' || (typeof schedule.lastOutcome === 'object' && schedule.lastOutcome !== null)) badgeState = 'warn';
    else badgeState = 'active';
    return {
      agentId: schedule.agentId,
      scheduleId: schedule.id,
      lifecycle: schedule.lifecycle,
      badgeState,
      nextFireAt: schedule.nextFireAt,
      lastOutcome: structuredClone(schedule.lastOutcome),
      revision: schedule.revision,
    };
  }
}
