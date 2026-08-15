import assert from 'node:assert/strict';

import type { GitCapability } from '../../shared/types';
import type { CaptureAttempt, TurnRecord } from '../database';
import {
  CAPABILITY_PROBE_TTL_MS,
  CAPTURE_ATTEMPT_OVERDUE_MS,
  ENGINE_BOOTSTRAP_STALE_MS,
  SNAPSHOT_VERIFICATION_TTL_MS,
  SUBSYSTEM_BEAT_MS,
  SUBSYSTEM_HEARTBEAT_STALE_MS,
  CaptureHealthManager,
  beginCaptureAttemptForSubmittedSend,
  classifyServerState,
  type ActiveTurnProtection,
  type AttemptRollup,
  type CaptureHealthStore,
  type ClosedAfterVerification,
  type ServerHeartbeatState,
} from './capture-health';
import type { TurnClosedEvent } from '../git-checkpoints/turn-coordinator';
import { TurnCoordinator } from '../git-checkpoints/turn-coordinator';
import type { EdgeCaptureResult } from '../git-checkpoints/checkpoint-service';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const CAP: GitCapability = {
  resolution: { agentShell: { source: null, note: 'test' }, internal: null },
  repoState: 'repo',
  commonDir: 'C:/repo/.git',
  repoRoot: 'C:/repo',
  workspacePrefix: '',
  commonDirQueueKey: 'C:/repo/.git',
  protectedRoot: false,
  reason: 'ok',
  detail: null,
};

function turn(id: string, overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id,
    workspaceId: 'ws',
    turnSeq: Number(id.replace(/\D/g, '')) || 1,
    agentId: 'agent',
    agentTitle: null,
    ownerAgentId: null,
    ownerBrickGeneration: null,
    planId: null,
    planItemId: null,
    planStampSource: 'legacy-unstamped',
    intentId: null,
    intentStampSource: null,
    sessionId: null,
    taskLabel: null,
    startedAt: 1_000,
    endedAt: null,
    status: 'open',
    beforeOid: 'before-oid',
    afterOid: null,
    beforeRef: 'refs/lares/before',
    afterRef: null,
    beforeReady: true,
    afterReady: false,
    beforeQuality: 'guaranteed',
    afterQuality: null,
    beforeRawFilterBypassed: false,
    beforeFilteredPaths: null,
    beforePrunedAt: null,
    afterPrunedAt: null,
    touched: null,
    diffStats: null,
    compactDiff: null,
    compactDiffProvenance: null,
    failureReason: null,
    ...overrides,
  };
}

class MemoryStore implements CaptureHealthStore {
  attempts: CaptureAttempt[] = [];
  turns = new Map<string, TurnRecord>();
  serial = 0;

  getAttempt(id: string): CaptureAttempt | null { return this.attempts.find((row) => row.id === id) ?? null; }
  insertAttempt(input: { workspaceId: string; agentId: string; createdAt?: number }): CaptureAttempt {
    const createdAt = input.createdAt ?? 0;
    const row: CaptureAttempt = {
      id: `attempt-${++this.serial}`,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      turnId: null,
      status: 'pending',
      reason: null,
      createdAt,
      updatedAt: createdAt,
      openedAt: null,
      beforeResult: 'unknown',
    };
    this.attempts.push(row);
    return row;
  }
  listAttempts(workspaceId: string): CaptureAttempt[] { return this.attempts.filter((row) => row.workspaceId === workspaceId); }
  updateAttempt(id: string, updates: Partial<CaptureAttempt>): CaptureAttempt | null {
    const row = this.getAttempt(id);
    if (!row) return null;
    if (updates.openedAt != null && row.openedAt != null) delete updates.openedAt;
    Object.assign(row, updates);
    return row;
  }
  getTurn(id: string): TurnRecord | null { return this.turns.get(id) ?? null; }
  listOpenTurns(workspaceId: string): TurnRecord[] {
    return [...this.turns.values()].filter((row) => row.workspaceId === workspaceId && row.status === 'open');
  }
  listTurns(workspaceId: string): TurnRecord[] { return [...this.turns.values()].filter((row) => row.workspaceId === workspaceId); }
  listWorkspaceIds(): string[] { return ['ws']; }
}

class CoordinatorObserver {
  listener: ((event: TurnClosedEvent) => void) | null = null;
  onTurnClosed(listener: (event: TurnClosedEvent) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }
  close(event: TurnClosedEvent): void { this.listener?.(event); }
}

function managerFixture(now = 10_000, verify: (row: TurnRecord, edge: 'before' | 'after') => Promise<boolean> = async () => true) {
  let clock = now;
  const store = new MemoryStore();
  const coordinator = new CoordinatorObserver();
  let timerCallback: (() => void) | null = null;
  let timerMs = 0;
  const manager = new CaptureHealthManager({
    store,
    now: () => clock,
    setInterval: (callback, ms) => {
      timerCallback = callback;
      timerMs = ms;
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => undefined,
  });
  manager.markBootstrapping();
  manager.attachEngine({ coordinator: coordinator as never, verifyEdge: (row, edge) => verify(row, edge) });
  manager.noteCapability('ws', CAP, clock);
  return {
    manager,
    store,
    coordinator,
    get now() { return clock; },
    set now(value: number) { clock = value; },
    get timerCallback() { return timerCallback; },
    get timerMs() { return timerMs; },
  };
}

test('T17 production send observer inserts pending before checkpoint work', () => {
  let calls = 0;
  const id = beginCaptureAttemptForSubmittedSend(true, { id: 'agent', workspaceId: 'ws' }, {
    beginAttempt(workspaceId, agentId) {
      calls += 1;
      assert.equal(workspaceId, 'ws');
      assert.equal(agentId, 'agent');
      return 'attempt-real-seam';
    },
  });
  assert.equal(id, 'attempt-real-seam', 'REACHABILITY:capture-attempt-observer');
  assert.equal(calls, 1, 'REACHABILITY:capture-attempt-observer');
});

test('T10b/T10c pending-only overdue and orphaned opened semantics', async () => {
  const f = managerFixture();
  const open = turn('turn-1');
  f.store.turns.set(open.id, open);
  const id = f.manager.beginAttempt('ws', 'agent')!;
  f.manager.observeBeforeResult(id, { turnId: open.id, ready: true, quality: 'guaranteed', failureReason: null });
  f.now += 60_000;
  await f.manager.beat();
  let snapshot = f.manager.snapshot('ws');
  assert.equal(snapshot.attempts.openedCount, 1);
  assert.equal(snapshot.attempts.overduePendingCount, 0);
  assert.notEqual(snapshot.serverState, 'silently-wedged');
  open.status = 'accepted';
  snapshot = f.manager.snapshot('ws');
  assert.equal(snapshot.attempts.orphanedOpenedCount, 1);
  assert.equal(snapshot.serverState, 'degraded-visible');
});

test('T10d/T10g a newer completion does not hide an older overdue pending', () => {
  const f = managerFixture();
  f.manager.beginAttempt('ws', 'agent');
  f.now += 1_000;
  const newer = f.manager.beginAttempt('ws', 'agent')!;
  f.manager.markAttemptSkipped(newer, 'capability-none');
  f.now += CAPTURE_ATTEMPT_OVERDUE_MS;
  const snapshot = f.manager.snapshot('ws');
  assert.equal(snapshot.attempts.overduePendingCount, 1);
  assert.equal(snapshot.serverState, 'silently-wedged');
});

test('T10m/T10n all open turns must have fresh live before verification', async () => {
  const f = managerFixture();
  for (const seq of [1, 2]) {
    const row = turn(`turn-${seq}`, { agentId: `agent-${seq}`, turnSeq: seq });
    f.store.turns.set(row.id, row);
    const id = f.manager.beginAttempt('ws', `agent-${seq}`)!;
    f.manager.observeBeforeResult(id, { turnId: row.id, ready: true, quality: 'guaranteed', failureReason: null });
  }
  await Promise.resolve();
  await f.manager.beat();
  let snapshot = f.manager.snapshot('ws');
  assert.equal(snapshot.activeTurns.verifiedBeforeCount, 2);
  assert.equal(snapshot.serverState, 'protected');
  f.store.attempts.find((attempt) => attempt.turnId === 'turn-2')!.status = 'pending';
  snapshot = f.manager.snapshot('ws');
  assert.equal(snapshot.activeTurns.verifiedBeforeCount, 1);
  assert.equal(snapshot.serverState, 'capture-in-progress');
});

test('T17 ready before triggers verifyEdgeUsable immediately before any beat', async () => {
  let verifyCalls = 0;
  const f = managerFixture(10_000, async (_row, edge) => {
    if (edge === 'before') verifyCalls += 1;
    return true;
  });
  const row = turn('turn-1');
  f.store.turns.set(row.id, row);
  const id = f.manager.beginAttempt('ws', 'agent')!;
  f.manager.observeBeforeResult(id, { turnId: row.id, ready: true, quality: 'guaranteed', failureReason: null });
  await Promise.resolve();
  assert.equal(verifyCalls, 1);
  assert.equal(f.manager.snapshot('ws').lastSubsystemBeatAt, null);
});

test('T10o non-ready open before dominates an older live closed-after', async () => {
  const f = managerFixture();
  const closed = turn('turn-1', { status: 'accepted', endedAt: f.now, afterReady: true, afterOid: 'after', afterRef: 'refs/lares/after' });
  f.store.turns.set(closed.id, closed);
  const closedAttempt = f.manager.beginAttempt('ws', 'agent')!;
  f.manager.observeBeforeResult(closedAttempt, { turnId: closed.id, ready: true, quality: 'guaranteed', failureReason: null });
  await f.manager.onTurnClosed({ agentId: 'agent', turnId: closed.id, status: 'accepted', afterQuality: 'hook' });
  const open = turn('turn-2', { turnSeq: 2 });
  f.store.turns.set(open.id, open);
  const openAttempt = f.manager.beginAttempt('ws', 'agent')!;
  f.manager.observeBeforeResult(openAttempt, { turnId: open.id, ready: false, quality: 'degraded', failureReason: 'capture-failed' });
  await f.manager.beat();
  const snapshot = f.manager.snapshot('ws');
  assert.equal(snapshot.activeTurns.failedBeforeCount, 1);
  assert.equal(snapshot.latestClosedAfterVerification, null);
  assert.equal(snapshot.serverState, 'degraded-visible');
});

test('T10p idle protection expires to idle-but-healthy', async () => {
  const f = managerFixture();
  const row = turn('turn-1', { status: 'accepted', endedAt: f.now, afterReady: true, afterOid: 'after', afterRef: 'refs/lares/after' });
  f.store.turns.set(row.id, row);
  const id = f.manager.beginAttempt('ws', 'agent')!;
  f.manager.observeBeforeResult(id, { turnId: row.id, ready: true, quality: 'guaranteed', failureReason: null });
  await f.manager.beat();
  await f.manager.onTurnClosed({ agentId: 'agent', turnId: row.id, status: 'accepted', afterQuality: 'hook' });
  assert.equal(f.manager.snapshot('ws').serverState, 'protected');
  f.now += SNAPSHOT_VERIFICATION_TTL_MS + 1;
  await f.manager.beat();
  assert.equal(f.manager.snapshot('ws').serverState, 'idle-but-healthy');
});

test('T10q pending before beforeCheckpoint resolution is awaiting, never failed', async () => {
  const f = managerFixture();
  let resolveCapture!: (result: EdgeCaptureResult) => void;
  const capture = new Promise<EdgeCaptureResult>((resolve) => { resolveCapture = resolve; });
  const coordinatorStore = {
    allocateAndInsertTurn(workspaceId: string, fields: Record<string, unknown>) {
      const row = turn('turn-1', {
        workspaceId,
        agentId: fields.agentId as string,
        startedAt: fields.startedAt as number,
        beforeReady: false,
        beforeOid: null,
        beforeRef: null,
      });
      f.store.turns.set(row.id, row);
      return row;
    },
    updateTurnRecord(id: string, updates: Record<string, unknown>) {
      const row = f.store.turns.get(id) ?? null;
      if (row) Object.assign(row, updates);
      return row;
    },
    closeTurn(id: string, status: TurnRecord['status']) {
      const row = f.store.turns.get(id) ?? null;
      if (row) row.status = status;
      return row;
    },
    getTurnRecord: (id: string) => f.store.getTurn(id),
    listTurnRecords: (workspaceId: string) => f.store.listTurns(workspaceId),
    listOpenTurnRecords: (workspaceId: string) => f.store.listOpenTurns(workspaceId),
  };
  const coordinator = new TurnCoordinator({
    capture: async () => capture,
    completion: { onTurnComplete: () => () => undefined, beginTurn: () => undefined, reset: () => undefined },
    store: coordinatorStore as never,
    now: () => f.now,
  });
  f.manager.beginAttempt('ws', 'agent');
  const before = coordinator.beforeCheckpoint('agent', { workspaceId: 'ws', agentId: 'agent', capability: CAP });
  await Promise.resolve();
  const snapshot = f.manager.snapshot('ws');
  assert.equal(snapshot.attempts.latestOutcome?.beforeResult, 'unknown');
  assert.equal(snapshot.activeTurns.awaitingVerificationCount, 1);
  assert.equal(snapshot.activeTurns.failedBeforeCount, 0);
  assert.equal(snapshot.serverState, 'capture-in-progress');
  resolveCapture({
    status: 'skipped', edge: 'before', turnId: 'turn-1', oid: null, ref: null,
    ready: false, quality: null, failureReason: null, skipReason: 'test-window-complete',
  });
  await before;
});

test('T10r late before verification cannot reinsert after close generation invalidation', async () => {
  let resolveVerify!: (live: boolean) => void;
  const pendingVerify = new Promise<boolean>((resolve) => { resolveVerify = resolve; });
  const f = managerFixture(10_000, async (_row, edge) => edge === 'before' ? pendingVerify : true);
  const row = turn('turn-1');
  f.store.turns.set(row.id, row);
  const id = f.manager.beginAttempt('ws', 'agent')!;
  f.manager.observeBeforeResult(id, { turnId: row.id, ready: true, quality: 'guaranteed', failureReason: null });
  row.status = 'delivery_failed';
  await f.manager.onTurnClosed({ agentId: 'agent', turnId: row.id, status: 'delivery_failed', afterQuality: 'none' });
  resolveVerify(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.manager.beforeVerification(row.id), null);
});

test('T10s newest closed-after is selected by turnSeq, not promise completion', async () => {
  const resolvers = new Map<number, (live: boolean) => void>();
  const f = managerFixture(10_000, (row, edge) => edge === 'before'
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => resolvers.set(row.turnSeq, resolve)));
  for (const seq of [1, 2]) {
    const row = turn(`turn-${seq}`, { turnSeq: seq, status: 'accepted', afterReady: true, afterOid: `after-${seq}`, afterRef: `refs/after-${seq}` });
    f.store.turns.set(row.id, row);
    const id = f.manager.beginAttempt('ws', 'agent')!;
    f.manager.observeBeforeResult(id, { turnId: row.id, ready: true, quality: 'guaranteed', failureReason: null });
  }
  const closeA = f.manager.onTurnClosed({ agentId: 'agent', turnId: 'turn-1', status: 'accepted', afterQuality: 'hook' });
  const closeB = f.manager.onTurnClosed({ agentId: 'agent', turnId: 'turn-2', status: 'accepted', afterQuality: 'hook' });
  resolvers.get(2)!(true);
  await closeB;
  resolvers.get(1)!(true);
  await closeA;
  assert.equal(f.manager.snapshot('ws').latestClosedAfterVerification?.turnSeq, 2);
});

test('T17 manager-owned timer advances subsystem beat at the named period', async () => {
  const f = managerFixture();
  assert.equal(f.timerMs, SUBSYSTEM_BEAT_MS);
  assert.equal(f.manager.snapshot('ws').lastSubsystemBeatAt, null);
  f.now += SUBSYSTEM_BEAT_MS;
  f.timerCallback!();
  await Promise.resolve();
  assert.equal(f.manager.snapshot('ws').lastSubsystemBeatAt, f.now);
});

const EMPTY_ATTEMPTS: AttemptRollup = {
  oldestPendingAt: null,
  pendingCount: 0,
  overduePendingCount: 0,
  openedCount: 0,
  orphanedOpenedCount: 0,
  latestOutcome: null,
};
const EMPTY_ACTIVE: ActiveTurnProtection = {
  openTurnCount: 0,
  verifiedBeforeCount: 0,
  awaitingVerificationCount: 0,
  failedBeforeCount: 0,
  oldestAwaitingSince: null,
};

test('T10t total engine-by-capability table maps every cell exactly once', () => {
  const now = 100_000;
  const engines = ['absent', 'bootstrapping-in-grace', 'bootstrapping-stale', 'present', 'failed'] as const;
  const capabilities = ['unprobed-in-grace', 'ok-fresh', 'non-ok', 'stale'] as const;
  const expected: Record<typeof engines[number], Record<typeof capabilities[number], ServerHeartbeatState>> = {
    absent: { 'unprobed-in-grace': 'degraded-visible', 'ok-fresh': 'degraded-visible', 'non-ok': 'degraded-visible', stale: 'degraded-visible' },
    'bootstrapping-in-grace': { 'unprobed-in-grace': 'starting', 'ok-fresh': 'starting', 'non-ok': 'degraded-visible', stale: 'degraded-visible' },
    'bootstrapping-stale': { 'unprobed-in-grace': 'degraded-visible', 'ok-fresh': 'degraded-visible', 'non-ok': 'degraded-visible', stale: 'degraded-visible' },
    present: { 'unprobed-in-grace': 'starting', 'ok-fresh': 'idle-but-healthy', 'non-ok': 'degraded-visible', stale: 'degraded-visible' },
    failed: { 'unprobed-in-grace': 'degraded-visible', 'ok-fresh': 'degraded-visible', 'non-ok': 'degraded-visible', stale: 'degraded-visible' },
  };
  for (const engineCase of engines) {
    for (const capabilityCase of capabilities) {
      const engine: 'absent' | 'bootstrapping' | 'present' | 'failed' = engineCase.startsWith('bootstrapping')
        ? 'bootstrapping'
        : engineCase as 'absent' | 'present' | 'failed';
      const engineChangedAt = engineCase === 'bootstrapping-stale' ? now - ENGINE_BOOTSTRAP_STALE_MS - 1 : now;
      const capability = capabilityCase === 'unprobed-in-grace'
        ? { ok: false, probedAt: null, phase: 'unprobed' as const }
        : capabilityCase === 'ok-fresh'
          ? { ok: true, probedAt: now, phase: 'fresh' as const }
          : capabilityCase === 'non-ok'
            ? { ok: false, probedAt: now, phase: 'non-ok' as const }
            : { ok: false, probedAt: now - CAPABILITY_PROBE_TTL_MS - 1, phase: 'stale' as const };
      const actual = classifyServerState({
        now,
        engine,
        engineChangedAt,
        capability,
        lastSubsystemBeatAt: now,
        attempts: EMPTY_ATTEMPTS,
        activeTurns: EMPTY_ACTIVE,
        latestClosedAfterVerification: null,
        latestTerminalFailure: null,
      });
      assert.equal(actual.serverState, expected[engineCase][capabilityCase], `${engineCase}/${capabilityCase}`);
      if (engineCase === 'present' && capabilityCase === 'stale') assert.equal(actual.reason, 'capability-stale');
    }
  }
});

test('H2 silently-wedged beat staleness wins and zero-turn fresh capability is limited server state', () => {
  const now = 100_000;
  const base = {
    now,
    engine: 'present' as const,
    engineChangedAt: now - 50_000,
    capability: { ok: true, probedAt: now, phase: 'fresh' as const },
    attempts: EMPTY_ATTEMPTS,
    activeTurns: EMPTY_ACTIVE,
    latestClosedAfterVerification: null as ClosedAfterVerification | null,
    latestTerminalFailure: null,
  };
  assert.equal(classifyServerState({ ...base, lastSubsystemBeatAt: now - SUBSYSTEM_HEARTBEAT_STALE_MS - 1 }).serverState, 'silently-wedged');
  assert.equal(classifyServerState({ ...base, lastSubsystemBeatAt: now }).serverState, 'idle-but-healthy');
});

void (async () => {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      console.log(`ok - ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${entry.name}`);
      console.error(error);
    }
  }
  if (failed > 0) process.exitCode = 1;
  else console.log(`capture-health: ${tests.length} tests passed`);
})();
