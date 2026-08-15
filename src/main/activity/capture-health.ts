import {
  getCaptureAttempt,
  getTurnRecord,
  getWorkspaces,
  insertCaptureAttempt,
  listCaptureAttempts,
  listOpenTurnRecords,
  listTurnRecords,
  updateCaptureAttempt,
  type CaptureAttempt,
  type TurnRecord,
} from '../database';
import type { GitCapability } from '../../shared/types';
import type { BeforeCheckpointResult, TurnClosedEvent, TurnCoordinator } from '../git-checkpoints/turn-coordinator';

export const ENGINE_BOOTSTRAP_STALE_MS = 30_000;
export const CAPABILITY_PROBE_TTL_MS = 60_000;
export const CAPABILITY_FIRST_PROBE_GRACE_MS = 10_000;
export const CAPABILITY_REFRESH_GRACE_MS = 60_000;
export const CAPTURE_ATTEMPT_OVERDUE_MS = 15_000;
export const SUBSYSTEM_BEAT_MS = 5_000;
export const SUBSYSTEM_FIRST_BEAT_GRACE_MS = 10_000;
export const SUBSYSTEM_HEARTBEAT_STALE_MS = 20_000;
export const SNAPSHOT_VERIFICATION_TTL_MS = 10_000;
export const RENDERER_HEARTBEAT_STALE_MS = 20_000;
export const HEARTBEAT_POLL_MS = 15_000;

export type ServerHeartbeatState =
  | 'starting'
  | 'capture-in-progress'
  | 'protected'
  | 'idle-but-healthy'
  | 'silently-wedged'
  | 'degraded-visible';

export interface AttemptRollup {
  oldestPendingAt: number | null;
  pendingCount: number;
  overduePendingCount: number;
  openedCount: number;
  orphanedOpenedCount: number;
  latestOutcome: CaptureAttempt | null;
}

export interface ActiveTurnProtection {
  openTurnCount: number;
  verifiedBeforeCount: number;
  awaitingVerificationCount: number;
  failedBeforeCount: number;
  oldestAwaitingSince: number | null;
}

export interface ClosedAfterVerification {
  turnId: string;
  turnSeq: number;
  verifiedAt: number;
  live: boolean;
}

export interface HeartbeatSnapshot {
  serverState: ServerHeartbeatState;
  serverNow: number;
  engine: 'absent' | 'bootstrapping' | 'present' | 'failed';
  engineChangedAt: number;
  capabilityOk: boolean;
  capabilityProbedAt: number | null;
  lastSubsystemBeatAt: number | null;
  attempts: AttemptRollup;
  activeTurns: ActiveTurnProtection;
  latestClosedAfterVerification: ClosedAfterVerification | null;
  reason: string | null;
}

export type ShieldState = 'protected' | 'limited' | 'not-protected';

interface CapabilityObservation {
  cap: GitCapability | null;
  probedAt: number | null;
  refreshingSince: number | null;
}

interface Verification {
  turnSeq: number;
  generation: number;
  verifiedAt: number;
  live: boolean;
}

export interface CaptureHealthStore {
  getAttempt(id: string): CaptureAttempt | null;
  insertAttempt(input: { workspaceId: string; agentId: string; createdAt?: number }): CaptureAttempt;
  listAttempts(workspaceId: string): CaptureAttempt[];
  updateAttempt(id: string, updates: Parameters<typeof updateCaptureAttempt>[1]): CaptureAttempt | null;
  getTurn(id: string): TurnRecord | null;
  listOpenTurns(workspaceId: string): TurnRecord[];
  listTurns(workspaceId: string): TurnRecord[];
  listWorkspaceIds(): string[];
}

const DEFAULT_STORE: CaptureHealthStore = {
  getAttempt: getCaptureAttempt,
  insertAttempt: insertCaptureAttempt,
  listAttempts: listCaptureAttempts,
  updateAttempt: updateCaptureAttempt,
  getTurn: getTurnRecord,
  listOpenTurns: listOpenTurnRecords,
  listTurns: (workspaceId) => listTurnRecords(workspaceId),
  listWorkspaceIds: () => getWorkspaces().map((workspace) => workspace.id),
};

export interface CaptureHealthManagerOptions {
  store?: CaptureHealthStore;
  now?: () => number;
  setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

export class CaptureHealthManager {
  private readonly store: CaptureHealthStore;
  private readonly now: () => number;
  private readonly setIntervalFn: NonNullable<CaptureHealthManagerOptions['setInterval']>;
  private readonly clearIntervalFn: NonNullable<CaptureHealthManagerOptions['clearInterval']>;
  private engine: HeartbeatSnapshot['engine'] = 'absent';
  private engineChangedAt: number;
  private lastSubsystemBeatAt: number | null = null;
  private capabilities = new Map<string, CapabilityObservation>();
  private generations = new Map<string, number>();
  private beforeVerifications = new Map<string, Verification>();
  private latestClosedAfterVerification = new Map<string, ClosedAfterVerification>();
  private verifyEdge: ((row: TurnRecord, edge: 'before' | 'after', capability: GitCapability) => Promise<boolean>) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeTurnClosed: (() => void) | null = null;

  constructor(options: CaptureHealthManagerOptions = {}) {
    this.store = options.store ?? DEFAULT_STORE;
    this.now = options.now ?? Date.now;
    this.setIntervalFn = options.setInterval ?? setInterval;
    this.clearIntervalFn = options.clearInterval ?? clearInterval;
    this.engineChangedAt = this.now();
  }

  markBootstrapping(): void {
    this.setEngine('bootstrapping');
  }

  markEngineAbsent(): void {
    this.setEngine('absent');
  }

  markEngineFailed(): void {
    this.setEngine('failed');
  }

  attachEngine(input: {
    coordinator: TurnCoordinator;
    verifyEdge: (row: TurnRecord, edge: 'before' | 'after', capability: GitCapability) => Promise<boolean>;
  }): void {
    this.verifyEdge = input.verifyEdge;
    this.setEngine('present');
    this.unsubscribeTurnClosed?.();
    this.unsubscribeTurnClosed = input.coordinator.onTurnClosed((event) => {
      void this.onTurnClosed(event).catch(() => { /* health is fail-open */ });
    });
    if (!this.timer) {
      this.timer = this.setIntervalFn(() => {
        void this.beat().catch(() => { /* a failed beat becomes visible by staleness */ });
      }, SUBSYSTEM_BEAT_MS);
    }
  }

  dispose(): void {
    this.unsubscribeTurnClosed?.();
    this.unsubscribeTurnClosed = null;
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  noteCapabilityProbeStarted(workspaceId: string): void {
    const current = this.capabilities.get(workspaceId) ?? { cap: null, probedAt: null, refreshingSince: null };
    this.capabilities.set(workspaceId, { ...current, refreshingSince: this.now() });
  }

  noteCapability(workspaceId: string, cap: GitCapability | null, probedAt = this.now()): void {
    this.capabilities.set(workspaceId, { cap, probedAt, refreshingSince: null });
  }

  capabilityObservation(workspaceId: string): Readonly<CapabilityObservation> | null {
    return this.capabilities.get(workspaceId) ?? null;
  }

  beforeVerification(turnId: string): Readonly<Verification> | null {
    return this.beforeVerifications.get(turnId) ?? null;
  }

  beginAttempt(workspaceId: string, agentId: string): string | null {
    try {
      return this.store.insertAttempt({ workspaceId, agentId, createdAt: this.now() }).id;
    } catch {
      return null;
    }
  }

  markAttemptSkipped(attemptId: string | null, reason: 'engine-absent' | 'capability-none'): void {
    if (!attemptId) return;
    try {
      this.store.updateAttempt(attemptId, { status: 'skipped', reason, updatedAt: this.now() });
    } catch { /* capture health never blocks delivery */ }
  }

  markAttemptFailed(attemptId: string | null, reason: string): void {
    if (!attemptId) return;
    try {
      this.store.updateAttempt(attemptId, { status: 'failed', reason, updatedAt: this.now() });
    } catch { /* capture health never blocks delivery */ }
  }

  observeBeforeResult(attemptId: string | null, result: BeforeCheckpointResult): void {
    if (!attemptId) return;
    try {
      this.store.updateAttempt(attemptId, {
        turnId: result.turnId,
        status: 'opened',
        reason: result.failureReason,
        openedAt: this.now(),
        beforeResult: result.ready ? 'ready' : 'non-ready',
        updatedAt: this.now(),
      });
      if (result.ready) void this.verifyOpenBefore(result.turnId);
    } catch { /* capture health never blocks delivery */ }
  }

  async beat(): Promise<void> {
    const beatAt = this.now();
    this.lastSubsystemBeatAt = beatAt;
    const rows = this.store.listWorkspaceIds().flatMap((workspaceId) => this.store.listOpenTurns(workspaceId));
    await Promise.all(rows.map((row) => this.verifyOpenBefore(row.id)));
  }

  async onTurnClosed(event: TurnClosedEvent): Promise<void> {
    const generation = (this.generations.get(event.turnId) ?? 0) + 1;
    this.generations.set(event.turnId, generation);
    this.beforeVerifications.delete(event.turnId);

    const row = this.store.getTurn(event.turnId);
    if (!row) return;
    const attempt = this.store.listAttempts(row.workspaceId)
      .filter((candidate) => candidate.turnId === event.turnId && candidate.status === 'opened')
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
    const successPair = row.beforeReady && row.afterReady;
    if (attempt) {
      this.store.updateAttempt(attempt.id, {
        status: successPair ? 'completed' : 'failed',
        reason: successPair ? null : (row.failureReason ?? (!row.beforeReady ? 'before-not-ready' : 'after-not-ready')),
        updatedAt: this.now(),
      });
    }
    if (!successPair) return;
    const capability = this.capabilities.get(row.workspaceId)?.cap;
    if (!capability || !this.verifyEdge) return;
    const live = await this.verifyEdge(row, 'after', capability);
    const candidate: ClosedAfterVerification = {
      turnId: row.id,
      turnSeq: row.turnSeq,
      verifiedAt: this.now(),
      live,
    };
    const stored = this.latestClosedAfterVerification.get(row.workspaceId);
    if (!stored || candidate.turnSeq > stored.turnSeq) {
      this.latestClosedAfterVerification.set(row.workspaceId, candidate);
    }
  }

  snapshot(workspaceId: string): HeartbeatSnapshot {
    const serverNow = this.now();
    const attempts = this.rollupAttempts(workspaceId, serverNow);
    const openTurns = this.store.listOpenTurns(workspaceId);
    const activeTurns = this.rollupActiveTurns(workspaceId, openTurns, serverNow);
    const capability = this.capabilityStatus(workspaceId, serverNow);
    const latestClosed = this.latestClosedAfterVerification.get(workspaceId) ?? null;
    const closed = openTurns.length === 0 && latestClosed
      && serverNow - latestClosed.verifiedAt <= SNAPSHOT_VERIFICATION_TTL_MS
      ? latestClosed
      : null;
    const latestTerminal = [...this.store.listTurns(workspaceId)]
      .filter((turn) => turn.status !== 'open')
      .sort((a, b) => b.turnSeq - a.turnSeq)[0] ?? null;
    const classified = classifyServerState({
      now: serverNow,
      engine: this.engine,
      engineChangedAt: this.engineChangedAt,
      capability,
      lastSubsystemBeatAt: this.lastSubsystemBeatAt,
      attempts,
      activeTurns,
      latestClosedAfterVerification: closed,
      latestTerminalFailure: latestTerminal?.failureReason ?? null,
    });
    return {
      serverState: classified.serverState,
      serverNow,
      engine: this.engine,
      engineChangedAt: this.engineChangedAt,
      capabilityOk: capability.ok,
      capabilityProbedAt: capability.probedAt,
      lastSubsystemBeatAt: this.lastSubsystemBeatAt,
      attempts,
      activeTurns,
      latestClosedAfterVerification: closed,
      reason: classified.reason,
    };
  }

  private setEngine(next: HeartbeatSnapshot['engine']): void {
    if (this.engine === next) return;
    this.engine = next;
    this.engineChangedAt = this.now();
    if (next !== 'present') this.lastSubsystemBeatAt = null;
  }

  private async verifyOpenBefore(turnId: string): Promise<void> {
    const row = this.store.getTurn(turnId);
    if (!row || row.status !== 'open' || !row.beforeReady || !this.verifyEdge) return;
    const capability = this.capabilities.get(row.workspaceId)?.cap;
    if (!capability) return;
    const generation = this.generations.get(turnId) ?? 0;
    const live = await this.verifyEdge(row, 'before', capability);
    const reread = this.store.getTurn(turnId);
    if (!reread || reread.status !== 'open' || (this.generations.get(turnId) ?? 0) !== generation) return;
    this.beforeVerifications.set(turnId, {
      turnSeq: reread.turnSeq,
      generation,
      verifiedAt: this.now(),
      live,
    });
  }

  private rollupAttempts(workspaceId: string, now: number): AttemptRollup {
    const all = this.store.listAttempts(workspaceId);
    const pending = all.filter((attempt) => attempt.status === 'pending');
    const opened = all.filter((attempt) => attempt.status === 'opened');
    let openedCount = 0;
    let orphanedOpenedCount = 0;
    for (const attempt of opened) {
      const turn = attempt.turnId ? this.store.getTurn(attempt.turnId) : null;
      if (turn?.status === 'open') openedCount += 1;
      else orphanedOpenedCount += 1;
    }
    const latestOutcome = [...all].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0] ?? null;
    return {
      oldestPendingAt: pending.length ? Math.min(...pending.map((attempt) => attempt.createdAt)) : null,
      pendingCount: pending.length,
      overduePendingCount: pending.filter((attempt) => now - attempt.createdAt > CAPTURE_ATTEMPT_OVERDUE_MS).length,
      openedCount,
      orphanedOpenedCount,
      latestOutcome,
    };
  }

  private rollupActiveTurns(workspaceId: string, openTurns: TurnRecord[], now: number): ActiveTurnProtection {
    const attempts = this.store.listAttempts(workspaceId);
    let verifiedBeforeCount = 0;
    let awaitingVerificationCount = 0;
    let failedBeforeCount = 0;
    const awaitingSince: number[] = [];
    for (const turn of openTurns) {
      const attempt = [...attempts]
        .filter((candidate) => candidate.turnId === turn.id || (candidate.turnId === null && candidate.agentId === turn.agentId))
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
      if (attempt?.status === 'opened' && attempt.beforeResult === 'non-ready') {
        failedBeforeCount += 1;
        continue;
      }
      const verification = this.beforeVerifications.get(turn.id);
      const freshLive = attempt?.status === 'opened'
        && attempt.beforeResult === 'ready'
        && verification?.live === true
        && verification.generation === (this.generations.get(turn.id) ?? 0)
        && now - verification.verifiedAt <= SNAPSHOT_VERIFICATION_TTL_MS;
      if (freshLive) verifiedBeforeCount += 1;
      else {
        awaitingVerificationCount += 1;
        awaitingSince.push(attempt?.createdAt ?? turn.startedAt ?? now);
      }
    }
    return {
      openTurnCount: openTurns.length,
      verifiedBeforeCount,
      awaitingVerificationCount,
      failedBeforeCount,
      oldestAwaitingSince: awaitingSince.length ? Math.min(...awaitingSince) : null,
    };
  }

  private capabilityStatus(workspaceId: string, now: number): CapabilityState {
    const observation = this.capabilities.get(workspaceId);
    if (!observation || observation.probedAt === null) {
      return { ok: false, probedAt: null, phase: 'unprobed' };
    }
    const age = now - observation.probedAt;
    if (observation.cap && age <= CAPABILITY_PROBE_TTL_MS) {
      return { ok: true, probedAt: observation.probedAt, phase: 'fresh' };
    }
    if (observation.cap && observation.refreshingSince !== null
      && now - observation.refreshingSince <= CAPABILITY_REFRESH_GRACE_MS) {
      return { ok: true, probedAt: observation.probedAt, phase: 'refresh-grace' };
    }
    if (!observation.cap) return { ok: false, probedAt: observation.probedAt, phase: 'non-ok' };
    return { ok: false, probedAt: observation.probedAt, phase: 'stale' };
  }
}

type CapabilityState = {
  ok: boolean;
  probedAt: number | null;
  phase: 'unprobed' | 'fresh' | 'refresh-grace' | 'non-ok' | 'stale';
};

export function classifyServerState(input: {
  now: number;
  engine: HeartbeatSnapshot['engine'];
  engineChangedAt: number;
  capability: CapabilityState;
  lastSubsystemBeatAt: number | null;
  attempts: AttemptRollup;
  activeTurns: ActiveTurnProtection;
  latestClosedAfterVerification: ClosedAfterVerification | null;
  latestTerminalFailure: string | null;
}): { serverState: ServerHeartbeatState; reason: string | null } {
  const engineAge = input.now - input.engineChangedAt;
  const firstBeatGrace = input.engine === 'present'
    && input.lastSubsystemBeatAt === null
    && engineAge <= SUBSYSTEM_FIRST_BEAT_GRACE_MS;
  const freshBeat = input.lastSubsystemBeatAt !== null
    && input.now - input.lastSubsystemBeatAt <= SUBSYSTEM_HEARTBEAT_STALE_MS;
  const latestExplicitFailure = input.attempts.latestOutcome
    && (input.attempts.latestOutcome.status === 'failed' || input.attempts.latestOutcome.status === 'skipped')
    ? input.attempts.latestOutcome
    : null;

  if (input.attempts.overduePendingCount > 0) return { serverState: 'silently-wedged', reason: 'capture-attempt-overdue' };
  if (input.engine === 'present' && !freshBeat && !firstBeatGrace) return { serverState: 'silently-wedged', reason: 'subsystem-beat-stale' };
  if (input.engine === 'absent') return { serverState: 'degraded-visible', reason: 'engine-absent' };
  if (input.engine === 'failed') return { serverState: 'degraded-visible', reason: 'engine-failed' };
  if (input.engine === 'bootstrapping' && engineAge > ENGINE_BOOTSTRAP_STALE_MS) return { serverState: 'degraded-visible', reason: 'engine-bootstrap-stale' };
  if (input.capability.phase === 'stale') return { serverState: 'degraded-visible', reason: 'capability-stale' };
  if (input.capability.phase === 'non-ok') return { serverState: 'degraded-visible', reason: 'capability-none' };
  if (latestExplicitFailure) return { serverState: 'degraded-visible', reason: latestExplicitFailure.reason ?? 'capture-attempt-failed' };
  if (input.latestTerminalFailure) return { serverState: 'degraded-visible', reason: input.latestTerminalFailure };
  if (input.attempts.orphanedOpenedCount > 0) return { serverState: 'degraded-visible', reason: 'orphaned-opened-attempt' };
  if (input.activeTurns.failedBeforeCount > 0) return { serverState: 'degraded-visible', reason: 'before-not-ready' };
  if (input.engine === 'present' && input.capability.ok && freshBeat
    && input.attempts.overduePendingCount === 0
    && (input.activeTurns.openTurnCount > 0
      ? input.activeTurns.verifiedBeforeCount === input.activeTurns.openTurnCount
      : input.latestClosedAfterVerification?.live === true)) {
    return { serverState: 'protected', reason: null };
  }
  if ((freshBeat || firstBeatGrace)
    && ((input.attempts.pendingCount > 0 && input.attempts.overduePendingCount === 0)
      || input.activeTurns.awaitingVerificationCount > 0)) {
    return { serverState: 'capture-in-progress', reason: null };
  }
  if (input.engine === 'bootstrapping' && engineAge <= ENGINE_BOOTSTRAP_STALE_MS) return { serverState: 'starting', reason: null };
  if (input.engine === 'present' && (firstBeatGrace
    || (input.capability.phase === 'unprobed' && engineAge <= CAPABILITY_FIRST_PROBE_GRACE_MS))) {
    return { serverState: 'starting', reason: null };
  }
  if (input.activeTurns.openTurnCount === 0
    && input.attempts.pendingCount === 0
    && input.attempts.openedCount === 0
    && input.capability.ok
    && freshBeat
    && !input.latestClosedAfterVerification?.live) {
    return { serverState: 'idle-but-healthy', reason: null };
  }
  return { serverState: 'degraded-visible', reason: 'health-state-incomplete' };
}

export const captureHealthManager = new CaptureHealthManager();

/** Runtime send-path observer. Kept small and injectable so the production job
 * seam can be entered without constructing Electron's entire supervisor. */
export function beginCaptureAttemptForSubmittedSend(
  submit: boolean,
  agent: { id: string; workspaceId: string } | null,
  observer: Pick<CaptureHealthManager, 'beginAttempt'> = captureHealthManager,
): string | null {
  if (!submit || !agent) return null;
  return observer.beginAttempt(agent.workspaceId, agent.id);
}
