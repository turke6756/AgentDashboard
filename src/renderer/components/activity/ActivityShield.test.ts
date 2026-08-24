import { describe, expect, it } from 'vitest';
import type { ActivityHeartbeatSnapshot, ActivityPage } from '../../../shared/types';
import { deriveShieldView } from './ActivityShield';

function heartbeat(overrides: Partial<ActivityHeartbeatSnapshot> = {}): ActivityHeartbeatSnapshot {
  return {
    serverState: 'protected',
    serverNow: 100_000,
    engine: 'present',
    engineChangedAt: 1_000,
    capabilityOk: true,
    capabilityProbedAt: 99_000,
    lastSubsystemBeatAt: 99_000,
    attempts: { oldestPendingAt: null, pendingCount: 0, overduePendingCount: 0, openedCount: 0, orphanedOpenedCount: 0, latestOutcome: null },
    activeTurns: { openTurnCount: 0, verifiedBeforeCount: 0, awaitingVerificationCount: 0, failedBeforeCount: 0, oldestAwaitingSince: null },
    latestClosedAfterVerification: { turnId: 'turn-1', turnSeq: 1, verifiedAt: 99_000, live: true },
    reason: null,
    ...overrides,
  };
}

function page(turnCount: number): ActivityPage {
  return {
    workspaceId: 'ws', items: [],
    cursor: { snapshot: { throughTurnSeq: turnCount, throughFileActivityId: 0, capturedAt: 100_000 }, nextOlder: null },
    pageCounts: {
      turnCount, agentCount: turnCount ? 1 : 0, fileCount: 0, planCount: 0, commitCount: 0,
      noCheckpointCount: 0,
      blockedOverlapCount: { value: 0, status: 'complete' },
      unavailableCount: { value: 0, status: 'complete' },
      checkingCount: { value: 0, status: 'complete' },
    },
    scope: {
      grouping: 'time', turnCountBasis: 'loaded-turns', filters: { eligibleOnly: true },
      completeness: { turns: true, agents: true, files: true, plans: true, commits: true },
    },
    scans: {
      turns: { scanned: 0, emitted: 0, exhausted: true, limit: 50 },
      fileActivities: { scanned: 0, emitted: 0, exhausted: true, limit: 50 },
    },
  };
}

describe('ActivityShield H3 derivation', () => {
  it('T10f locally overrides a cached green server snapshot when responses go stale', () => {
    const server = heartbeat();
    const view = deriveShieldView({ heartbeat: server, page: page(1), lastHeartbeatOkAt: 70_000, degradedStreak: 0, now: 100_001 });
    expect(view).toEqual({ state: 'not-protected', copy: 'Dashboard cannot confirm protection — the checkpoint service did not respond.' });
    expect(server.serverState).toBe('protected');
  });

  it('T10k uses the did-not-start red copy when the engine failed before any activity', () => {
    const view = deriveShieldView({
      heartbeat: heartbeat({ serverState: 'degraded-visible', engine: 'failed', reason: 'engine-failed', latestClosedAfterVerification: null }),
      page: page(0), lastHeartbeatOkAt: 100_000, degradedStreak: 1, now: 100_001,
    });
    expect(view).toEqual({ state: 'not-protected', copy: 'Restore snapshots are unavailable — checkpoint engine did not start.' });
  });

  it('T10a keeps a fresh zero-turn workspace limited rather than Protected', () => {
    const view = deriveShieldView({
      heartbeat: heartbeat({ serverState: 'idle-but-healthy', latestClosedAfterVerification: null }),
      page: page(0), lastHeartbeatOkAt: 100_000, degradedStreak: 0, now: 100_001,
    });
    expect(view).toEqual({ state: 'limited', copy: 'Protection limited — ready; no restore snapshots yet.' });
  });
});
