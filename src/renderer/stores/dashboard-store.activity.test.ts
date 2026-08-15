import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityDigest, ActivityPage } from '../../shared/types';
import { useDashboardStore } from './dashboard-store';

function page(): ActivityPage {
  return {
    workspaceId: 'ws', items: [],
    cursor: { snapshot: { throughTurnSeq: 8, throughFileActivityId: 13, capturedAt: 100 }, nextOlder: null },
    pageCounts: {
      turnCount: 8, agentCount: 2, fileCount: 4, planCount: 1, commitCount: 1, noCheckpointCount: 0,
      blockedOverlapCount: { value: 0, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' },
    },
    scans: { turns: { scanned: 8, emitted: 8, exhausted: true, limit: 50 }, fileActivities: { scanned: 0, emitted: 0, exhausted: true, limit: 50 } },
  };
}

const heartbeat: ActivityDigest['heartbeat'] = {
  serverState: 'idle-but-healthy', serverNow: 100, engine: 'present', engineChangedAt: 1,
  capabilityOk: true, capabilityProbedAt: 99, lastSubsystemBeatAt: 99,
  attempts: { oldestPendingAt: null, pendingCount: 0, overduePendingCount: 0, openedCount: 0, orphanedOpenedCount: 0, latestOutcome: null },
  activeTurns: { openTurnCount: 0, verifiedBeforeCount: 0, awaitingVerificationCount: 0, failedBeforeCount: 0, oldestAwaitingSince: null },
  latestClosedAfterVerification: null, reason: null,
};

beforeEach(() => {
  useDashboardStore.setState({
    selectedWorkspaceId: 'ws', activityPage: null, activityReturnCounts: null,
    activityLastViewed: null, lastHeartbeatOkAt: null, activityDegradedStreak: 0,
  });
});

describe('dashboard activity store', () => {
  it('preserves pre-view return counts and marks the exact displayed snapshot viewed', async () => {
    const markViewed = vi.fn(async () => ({ workspaceId: 'ws', turnSeq: 8, fileActivityId: 13, viewedAt: 101 }));
    (globalThis as unknown as { window: unknown }).window = {
      api: { activity: {
        digest: vi.fn(async () => ({ page: page(), sinceCounts: page().pageCounts, heartbeat })),
        list: vi.fn(async () => page()), markViewed,
      } },
    };
    await useDashboardStore.getState().loadActivity('ws', {}, true);
    expect(useDashboardStore.getState().activityReturnCounts?.turnCount).toBe(8);
    expect(markViewed).toHaveBeenCalledWith({ workspaceId: 'ws', snapshot: page().cursor.snapshot });
    expect(useDashboardStore.getState().activityLastViewed?.viewedAt).toBe(101);
  });

  it('primes cards and shield without advancing last-viewed', async () => {
    const markViewed = vi.fn();
    (globalThis as unknown as { window: unknown }).window = {
      api: { activity: {
        digest: vi.fn(async () => ({ page: page(), sinceCounts: page().pageCounts, heartbeat })),
        list: vi.fn(async () => page()), markViewed,
      } },
    };
    await useDashboardStore.getState().loadActivity('ws', {}, false);
    expect(markViewed).not.toHaveBeenCalled();
  });
});
