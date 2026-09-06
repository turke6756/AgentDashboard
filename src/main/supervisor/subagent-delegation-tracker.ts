export type SubagentPhase = 'running' | 'stopped';

export interface SubagentChildState {
  phase: SubagentPhase;
  hookTs: number;
  startedAt: number;
  stoppedAt?: number;
}

export interface DeferredParentStop {
  hookTs: number;
  receivedAt: number;
  source: string;
}

export interface SubagentDelegationState {
  parentSessionId: string;
  children: Map<string, SubagentChildState>;
  deferredParentStop?: DeferredParentStop;
  zeroInFlightAt?: number;
}

export interface TrackerMutation {
  disposition: 'applied' | 'duplicate' | 'stale';
  inFlightCount: number;
}

export interface DelegationSweepResult {
  expiredChildIds: string[];
  oldestExpiredAgeMs?: number;
  parentSessionId?: string;
  drain?: DeferredParentStop;
}

const phaseRank: Record<SubagentPhase, number> = { running: 0, stopped: 1 };

/** Pure, process-local correlation for Claude subagent hook records. */
export class SubagentDelegationTracker {
  private readonly states = new Map<string, SubagentDelegationState>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly orphanMs = 20 * 60 * 1000,
  ) {}

  get trackedAgentIds(): string[] {
    return Array.from(this.states.keys());
  }

  getState(agentId: string): SubagentDelegationState | undefined {
    return this.states.get(agentId);
  }

  inFlightCount(agentId: string): number {
    const state = this.states.get(agentId);
    if (!state) return 0;
    let count = 0;
    for (const child of state.children.values()) {
      if (child.phase === 'running') count++;
    }
    return count;
  }

  notePrompt(agentId: string, sessionId: string): { rotated: boolean } {
    const state = this.states.get(agentId);
    if (!state) {
      this.states.set(agentId, this.newState(sessionId));
      return { rotated: false };
    }
    if (state.parentSessionId !== sessionId) {
      this.states.set(agentId, this.newState(sessionId));
      return { rotated: true };
    }
    return { rotated: false };
  }

  start(agentId: string, sessionId: string, subagentId: string, hookTs: number): TrackerMutation {
    const state = this.ensureState(agentId, sessionId);
    const key = this.childKey(sessionId, subagentId);
    const existing = state.children.get(key);
    const disposition = this.compare(existing, hookTs, 'running');
    if (disposition !== 'applied') return { disposition, inFlightCount: this.inFlightCount(agentId) };

    state.children.set(key, {
      phase: 'running',
      hookTs,
      startedAt: this.now(),
    });
    // New delegation is authoritative evidence that an inferred turn-end must
    // not drain. This also clears the restart-reconciliation fallback.
    state.deferredParentStop = undefined;
    state.zeroInFlightAt = undefined;
    return { disposition, inFlightCount: this.inFlightCount(agentId) };
  }

  stop(
    agentId: string,
    sessionId: string,
    subagentId: string,
    hookTs: number,
    waiting: boolean,
  ): TrackerMutation {
    const state = this.ensureState(agentId, sessionId);
    const key = this.childKey(sessionId, subagentId);
    const existing = state.children.get(key);
    const disposition = this.compare(existing, hookTs, 'stopped');
    if (disposition !== 'applied') return { disposition, inFlightCount: this.inFlightCount(agentId) };

    const before = this.inFlightCount(agentId);
    const receivedAt = this.now();
    state.children.set(key, {
      phase: 'stopped',
      hookTs,
      startedAt: existing?.startedAt ?? receivedAt,
      stoppedAt: receivedAt,
    });
    this.afterCountReduction(state, before, waiting, receivedAt);
    return { disposition, inFlightCount: this.inFlightCount(agentId) };
  }

  deferParentStop(agentId: string, stop: DeferredParentStop): void {
    const state = this.states.get(agentId);
    if (!state) return;
    const current = state.deferredParentStop;
    if (!current || stop.hookTs > current.hookTs || (stop.hookTs === current.hookTs && stop.receivedAt >= current.receivedAt)) {
      state.deferredParentStop = stop;
    }
  }

  authoritativeParentStop(agentId: string): void {
    this.states.delete(agentId);
  }

  noteWaiting(agentId: string): void {
    const state = this.states.get(agentId);
    if (!state) return;
    state.deferredParentStop = undefined;
    state.zeroInFlightAt = undefined;
  }

  /** Arm a bounded fallback for a persisted working row whose pre-restart
   * in-memory child correlation cannot be reconstructed. */
  reconcileRestart(agentId: string): void {
    const now = this.now();
    const state = this.newState('');
    state.deferredParentStop = { hookTs: 0, receivedAt: now, source: 'subagent-restart-reconciliation' };
    state.zeroInFlightAt = now;
    this.states.set(agentId, state);
  }

  clear(agentId: string): void {
    this.states.delete(agentId);
  }

  sweep(agentId: string, waiting: boolean): DelegationSweepResult {
    const state = this.states.get(agentId);
    if (!state) return { expiredChildIds: [] };
    if (waiting) {
      this.noteWaiting(agentId);
      return { expiredChildIds: [], parentSessionId: state.parentSessionId };
    }

    const now = this.now();
    const before = this.inFlightCount(agentId);
    const expiredChildIds: string[] = [];
    let oldestExpiredAgeMs: number | undefined;
    for (const [key, child] of state.children) {
      if (child.phase !== 'running') continue;
      const age = now - child.startedAt;
      if (age < this.orphanMs) continue;
      child.phase = 'stopped';
      child.stoppedAt = now;
      expiredChildIds.push(key.slice(key.indexOf(':') + 1));
      oldestExpiredAgeMs = Math.max(oldestExpiredAgeMs ?? 0, age);
    }
    if (expiredChildIds.length > 0) this.afterCountReduction(state, before, false, now);

    let drain: DeferredParentStop | undefined;
    if (
      this.inFlightCount(agentId) === 0
      && state.deferredParentStop
      && state.zeroInFlightAt !== undefined
      && now - state.zeroInFlightAt >= this.orphanMs
    ) {
      drain = state.deferredParentStop;
      state.deferredParentStop = undefined;
      state.zeroInFlightAt = undefined;
    }
    return { expiredChildIds, oldestExpiredAgeMs, parentSessionId: state.parentSessionId, drain };
  }

  private newState(parentSessionId: string): SubagentDelegationState {
    return { parentSessionId, children: new Map() };
  }

  private ensureState(agentId: string, sessionId: string): SubagentDelegationState {
    let state = this.states.get(agentId);
    if (!state) {
      state = this.newState(sessionId);
      this.states.set(agentId, state);
    } else if (state.parentSessionId.length === 0) {
      // First post-restart correlated activity replaces the synthetic fallback.
      state = this.newState(sessionId);
      this.states.set(agentId, state);
    }
    return state;
  }

  private childKey(sessionId: string, subagentId: string): string {
    return `${sessionId}:${subagentId}`;
  }

  private compare(
    existing: SubagentChildState | undefined,
    hookTs: number,
    phase: SubagentPhase,
  ): TrackerMutation['disposition'] {
    if (!existing) return 'applied';
    if (hookTs < existing.hookTs) return 'stale';
    if (hookTs > existing.hookTs) return 'applied';
    const incomingRank = phaseRank[phase];
    const existingRank = phaseRank[existing.phase];
    if (incomingRank < existingRank) return 'stale';
    if (incomingRank === existingRank) return 'duplicate';
    return 'applied';
  }

  private afterCountReduction(
    state: SubagentDelegationState,
    before: number,
    waiting: boolean,
    now: number,
  ): void {
    if (before <= 0 || this.countState(state) !== 0 || !state.deferredParentStop) return;
    if (waiting) {
      state.deferredParentStop = undefined;
      state.zeroInFlightAt = undefined;
      return;
    }
    state.zeroInFlightAt = now;
  }

  private countState(state: SubagentDelegationState): number {
    let count = 0;
    for (const child of state.children.values()) if (child.phase === 'running') count++;
    return count;
  }
}
