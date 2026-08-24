import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityDigest, ActivityPage } from '../../shared/types';
import { useDashboardStore } from './dashboard-store';

function page(overrides: Partial<ActivityPage> = {}): ActivityPage {
  return {
    workspaceId: 'ws', items: [],
    cursor: { snapshot: { throughTurnSeq: 8, throughFileActivityId: 13, capturedAt: 100 }, nextOlder: null },
    pageCounts: {
      turnCount: 8, agentCount: 2, fileCount: 4, planCount: 1, commitCount: 1, noCheckpointCount: 0,
      blockedOverlapCount: { value: 0, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' },
    },
    scans: { turns: { scanned: 8, emitted: 8, exhausted: true, limit: 50 }, fileActivities: { scanned: 0, emitted: 0, exhausted: true, limit: 50 } },
    ...overrides,
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
    activityScope: { grouping: 'time' }, activityScopeHistory: [],
    activityTurnWindow: 50, activityFileWindow: 200, activityRequestSeq: 0,
    activityLoading: false, activityError: null,
  });
});

describe('dashboard activity store', () => {
  it('preserves pre-view return counts and marks the exact displayed snapshot viewed', async () => {
    const calls: string[] = [];
    const markViewed = vi.fn(async () => ({ workspaceId: 'ws', turnSeq: 8, fileActivityId: 13, viewedAt: 101 }));
    (globalThis as unknown as { window: unknown }).window = {
      api: { activity: {
        digest: vi.fn(async () => { calls.push('digest'); return { page: page(), sinceCounts: page().pageCounts, heartbeat }; }),
        list: vi.fn(async () => { calls.push('list'); return page(); }),
        markViewed: async (...args: Parameters<typeof markViewed>) => { calls.push('markViewed'); return markViewed(...args); },
      } },
    };
    await useDashboardStore.getState().loadActivity('ws', {}, true);
    expect(useDashboardStore.getState().activityReturnCounts?.turnCount).toBe(8);
    expect(markViewed).toHaveBeenCalledWith({ workspaceId: 'ws', snapshot: page().cursor.snapshot });
    expect(useDashboardStore.getState().activityLastViewed?.viewedAt).toBe(101);
    expect(calls).toEqual(['digest', 'list', 'markViewed']);
  });

  it('passes the previously read watermark into digest before advancing it', async () => {
    useDashboardStore.setState({ activityLastViewed: { workspaceId: 'ws', turnSeq: 8, fileActivityId: 13, viewedAt: 101 } });
    const digest = vi.fn(async () => ({ page: page(), sinceCounts: { ...page().pageCounts, turnCount: 0, fileCount: 0 }, heartbeat }));
    const markViewed = vi.fn(async () => ({ workspaceId: 'ws', turnSeq: 8, fileActivityId: 13, viewedAt: 102 }));
    (globalThis as unknown as { window: unknown }).window = {
      api: { activity: { digest, list: vi.fn(async () => page()), markViewed } },
    };
    await useDashboardStore.getState().loadActivity('ws', {}, true);
    expect(digest).toHaveBeenCalledWith(expect.objectContaining({
      since: { turnSeq: 8, fileActivityId: 13 },
    }));
    expect(useDashboardStore.getState().activityReturnCounts?.turnCount).toBe(0);
  });

  it('reaches older pages with the original snapshot and independent source cursors', async () => {
    const nextOlder = {
      turns: { before: 8, exhausted: false },
      fileActivities: { before: 13, exhausted: false },
    };
    const first = page({
      items: [{ kind: 'tool-unjoined', id: 'tool:a:13:13', agentId: 'a', agentTitle: 'Agent', fileActivityIds: [13], paths: [], startedAt: 1, endedAt: 2 }],
      cursor: { ...page().cursor, nextOlder },
    });
    const older = page({
      items: [{ kind: 'tool-unjoined', id: 'tool:a:3:3', agentId: 'a', agentTitle: 'Agent', fileActivityIds: [3], paths: [], startedAt: 1, endedAt: 2 }],
      cursor: { ...page().cursor, nextOlder: null },
    });
    const list = vi.fn(async () => older);
    useDashboardStore.setState({ activityPage: first, activityScope: { grouping: 'none' } });
    (globalThis as unknown as { window: unknown }).window = { api: { activity: { list } } };
    await useDashboardStore.getState().loadOlderActivity('ws');
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: first.cursor.snapshot,
      before: nextOlder,
      preview: 'none',
    }));
    expect(useDashboardStore.getState().activityPage?.items.map((item) => item.kind === 'turn' ? item.turnId : 'id' in item ? item.id : item.kind))
      .toEqual(['tool:a:13:13', 'tool:a:3:3']);
    expect(useDashboardStore.getState().activityPage?.cursor.nextOlder).toBeNull();
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

  it('REACHABILITY:wp1-time-default-lens sends the default Time lens and renderer IANA zone without painting digest.page', async () => {
    let resolveList!: (value: ActivityPage) => void;
    const listPage = page();
    const list = vi.fn(() => new Promise<ActivityPage>((resolve) => { resolveList = resolve; }));
    (globalThis as unknown as { window: unknown }).window = { api: { activity: {
      digest: vi.fn(async () => ({ page: page({ items: [{ kind: 'tool-unjoined', id: 'digest-only', agentId: 'a', agentTitle: null, fileActivityIds: [], paths: [], startedAt: 1, endedAt: 2 }] }), sinceCounts: page().pageCounts, heartbeat })),
      list,
      markViewed: vi.fn(async () => ({ workspaceId: 'ws', turnSeq: 8, fileActivityId: 13, viewedAt: 101 })),
    } } };
    const pending = useDashboardStore.getState().loadActivity('ws');
    await Promise.resolve();
    await Promise.resolve();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      grouping: 'time',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      preview: 'none',
    }));
    expect(useDashboardStore.getState().activityPage).toBeNull();
    resolveList(listPage);
    await pending;
    expect(useDashboardStore.getState().activityPage).toBe(listPage);
  });

  it('keeps the latest scope when an older lens request resolves last', async () => {
    let resolvePlan!: (value: ActivityPage) => void;
    const planPending = new Promise<ActivityPage>((resolve) => { resolvePlan = resolve; });
    const planPage = page({ scope: { grouping: 'plan', turnCountBasis: 'loaded-turns', filters: { eligibleOnly: true }, completeness: { turns: true, agents: true, plans: true, commits: true, files: true } } });
    const timePage = page({ scope: { grouping: 'time', turnCountBasis: 'loaded-turns', filters: { eligibleOnly: true }, completeness: { turns: true, agents: true, plans: true, commits: true, files: true }, timeZone: 'UTC' } });
    const list = vi.fn((request: { grouping?: string }) => request.grouping === 'plan' ? planPending : Promise.resolve(timePage));
    (globalThis as unknown as { window: unknown }).window = { api: { activity: {
      digest: vi.fn(async () => ({ page: page(), sinceCounts: page().pageCounts, heartbeat })), list,
      markViewed: vi.fn(async () => ({ workspaceId: 'ws', turnSeq: 8, fileActivityId: 13, viewedAt: 101 })),
    } } };
    const older = useDashboardStore.getState().loadActivity('ws', { grouping: 'plan' }, false);
    await Promise.resolve(); await Promise.resolve();
    const newer = useDashboardStore.getState().loadActivity('ws', { grouping: 'time' }, false);
    await newer;
    resolvePlan(planPage);
    await older;
    expect(useDashboardStore.getState().activityScope.grouping).toBe('time');
    expect(useDashboardStore.getState().activityPage).toBe(timePage);
  });

  it('scope actions reset both windows and issue exactly one real digest/list request pair', async () => {
    const digest = vi.fn(async () => ({ page: page(), sinceCounts: page().pageCounts, heartbeat }));
    const list = vi.fn(async () => page());
    const markViewed = vi.fn(async () => ({ workspaceId: 'ws', turnSeq: 8, fileActivityId: 13, viewedAt: 101 }));
    (globalThis as unknown as { window: unknown }).window = { api: { activity: { digest, list, markViewed } } };
    const assertOne = async (invoke: () => void) => {
      useDashboardStore.setState({ activityTurnWindow: 200, activityFileWindow: 10_000 });
      const digestBefore = digest.mock.calls.length;
      const listBefore = list.mock.calls.length;
      invoke();
      await vi.waitFor(() => expect(useDashboardStore.getState().activityLoading).toBe(false));
      expect(digest.mock.calls.length - digestBefore).toBe(1);
      expect(list.mock.calls.length - listBefore).toBe(1);
      expect(useDashboardStore.getState().activityTurnWindow).toBe(50);
      expect(useDashboardStore.getState().activityFileWindow).toBe(200);
    };
    await assertOne(() => useDashboardStore.getState().setLens('plan'));
    await assertOne(() => useDashboardStore.getState().setAgentFilter('a'));
    await assertOne(() => useDashboardStore.getState().setPathFilter('src'));
    await assertOne(() => useDashboardStore.getState().removeFilter('pathPrefix'));
    await assertOne(() => useDashboardStore.getState().clearActivityFilters());
    await assertOne(() => useDashboardStore.getState().pushDrill({ grouping: 'time', pathPrefix: 'src' }));
    await assertOne(() => useDashboardStore.getState().popDrill());
    useDashboardStore.setState({ activityScope: { grouping: 'time', pathPrefix: 'deep' }, activityScopeHistory: [{ grouping: 'plan' }, { grouping: 'time' }], activityTurnWindow: 200, activityFileWindow: 10_000 });
    await assertOne(() => useDashboardStore.getState().popToDepth(0));
  });

  it('showActivity is authoritative and coalesces legacy caller duplicate loads', async () => {
    let resolveDigest!: (value: ActivityDigest) => void;
    const digest = vi.fn(() => new Promise<ActivityDigest>((resolve) => { resolveDigest = resolve; }));
    const list = vi.fn(async () => page());
    const markViewed = vi.fn(async () => ({ workspaceId: 'ws', turnSeq: 8, fileActivityId: 13, viewedAt: 101 }));
    (globalThis as unknown as { window: unknown }).window = { api: { activity: { digest, list, markViewed } } };
    useDashboardStore.getState().showActivity({ agentId: 'a' });
    const duplicate = useDashboardStore.getState().loadActivity('ws', { agentId: 'a' });
    expect(digest).toHaveBeenCalledTimes(1);
    resolveDigest({ page: page(), sinceCounts: page().pageCounts, heartbeat });
    await duplicate;
    await Promise.resolve(); await Promise.resolve();
    expect(list).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().activityScope).toEqual({ grouping: 'time', agentId: 'a' });
  });

  it('grows each non-exhausted grouped source independently and replaces the projection', async () => {
    const nextOlder = { turns: { before: 8, exhausted: false }, fileActivities: { before: 13, exhausted: true } };
    const first = page({ items: [], cursor: { ...page().cursor, nextOlder } });
    const regrouped = page({ items: [{ kind: 'tool-unjoined', id: 'regrouped', agentId: 'a', agentTitle: null, fileActivityIds: [], paths: [], startedAt: 1, endedAt: 2 }] });
    const list = vi.fn(async (_request: unknown) => regrouped);
    useDashboardStore.setState({ activityPage: first, activityScope: { grouping: 'time' }, activityTurnWindow: 50, activityFileWindow: 200 });
    (globalThis as unknown as { window: unknown }).window = { api: { activity: { list } } };
    await useDashboardStore.getState().loadOlderActivity('ws');
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ grouping: 'time', snapshot: first.cursor.snapshot, limit: 100, fileActivityLimit: 200 }));
    expect(list.mock.calls[0][0]).not.toHaveProperty('before');
    expect(useDashboardStore.getState().activityPage).toBe(regrouped);
  });

  it('grows both non-exhausted grouped sources and performs exactly one re-query', async () => {
    const nextOlder = { turns: { before: 8, exhausted: false }, fileActivities: { before: 13, exhausted: false } };
    const first = page({ items: [], cursor: { ...page().cursor, nextOlder } });
    const regrouped = page();
    const list = vi.fn(async (_request: unknown) => regrouped);
    useDashboardStore.setState({ activityPage: first, activityScope: { grouping: 'time' }, activityTurnWindow: 50, activityFileWindow: 200 });
    (globalThis as unknown as { window: unknown }).window = { api: { activity: { list } } };
    await useDashboardStore.getState().loadOlderActivity('ws');
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      grouping: 'time', snapshot: first.cursor.snapshot, limit: 100, fileActivityLimit: 400,
    }));
    expect(useDashboardStore.getState().activityTurnWindow).toBe(100);
    expect(useDashboardStore.getState().activityFileWindow).toBe(400);
  });
});
