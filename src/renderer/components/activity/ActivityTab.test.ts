// @vitest-environment jsdom
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityCountScope, ActivityCounts, ActivityItem, ActivityPage, TurnActivityRow } from '../../../shared/types';
import ActivityTab, { activityBadge, OtherRow } from './ActivityTab';
import { useDashboardStore } from '../../stores/dashboard-store';

function row(
  state: TurnActivityRow['undo']['state'],
  status: TurnActivityRow['status'] = 'accepted',
  reason: string | null = null,
): TurnActivityRow {
  return {
    kind: 'turn', turnId: 'turn-1', turnSeq: 1, agentId: 'agent-1', agentTitle: 'Worker', taskLabel: 'Build',
    planId: null, planItemId: null, planStampStatus: 'unstamped', status, startedAt: 1, endedAt: 2,
    witnessedPaths: [], writeCount: 0,
    undo: { state, basis: 'stored-hints', reason, contention: [] },
    beforeReady: state === 'restorable', afterReady: state === 'restorable', beforeQuality: null, afterQuality: null,
    failureReason: null, beforePrunedAt: null, afterPrunedAt: null, commitOids: [],
  };
}

function completeCountScope(overrides: Partial<ActivityCountScope> = {}): ActivityCountScope {
  return {
    grouping: 'time',
    turnCountBasis: 'loaded-turns',
    filters: { eligibleOnly: true },
    completeness: { turns: true, agents: true, files: true, plans: true, commits: true },
    ...overrides,
  };
}

function typedActivityPage(page: ActivityPage): ActivityPage {
  return page;
}

function completeCounts(overrides: Partial<ActivityCounts> = {}): ActivityCounts {
  return {
    turnCount: 0, agentCount: 0, fileCount: 0, planCount: 0, commitCount: 0, noCheckpointCount: 0,
    blockedOverlapCount: { value: 0, status: 'complete' },
    unavailableCount: { value: 0, status: 'complete' },
    checkingCount: { value: 0, status: 'complete' },
    ...overrides,
  };
}

describe('Activity row copy', () => {
  it('REACHABILITY:wp4-honest-counts renders every C10 completeness branch and honest turn noun', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const counts: ActivityCounts = {
      turnCount: 7, agentCount: 3, fileCount: 5, planCount: 2, commitCount: 4, noCheckpointCount: 1,
      blockedOverlapCount: { value: null, status: 'pending' as const },
      unavailableCount: { value: null, status: 'pending' as const },
      checkingCount: { value: null, status: 'pending' as const },
    };
    const page = (scope: ActivityCountScope, pageCounts = counts): ActivityPage => ({
      workspaceId: 'counts-ws', items: [],
      cursor: { snapshot: { throughTurnSeq: 7, throughFileActivityId: 5, capturedAt: 1 }, nextOlder: null },
      pageCounts,
      scope,
      scans: { turns: { scanned: 7, emitted: 7, exhausted: true, limit: 50 }, fileActivities: { scanned: 5, emitted: 5, exhausted: true, limit: 200 } },
    });
    const incomplete = page(completeCountScope({
      grouping: 'file', turnCountBasis: 'visible-file-group-members',
      completeness: { turns: false, agents: false, files: false, plans: false, commits: false },
    }));
    useDashboardStore.setState({
      selectedWorkspaceId: 'counts-ws', agents: [], activityPage: incomplete, activityReturnCounts: null,
      activityScope: { grouping: 'file' }, activityScopeHistory: [], activityLoading: false, activityError: null,
      loadActivity: vi.fn(async () => undefined),
    } as any);
    try {
      await act(async () => root.render(React.createElement(ActivityTab)));
      expect(container.querySelector('[data-testid="activity-count-turns"]')?.textContent).toBe('7+ (partial) visible turns in file groups');
      expect(container.querySelector('[data-testid="activity-count-agents"]')?.textContent).toBe('3+');
      expect(container.querySelector('[data-testid="activity-count-files"]')?.textContent).toBe('5+');
      expect(container.querySelector('[data-testid="activity-count-plans"]')?.textContent).toBe('2+');
      expect(container.querySelector('[data-testid="activity-count-commits"]')?.textContent).toBe('4+');
      expect(container.querySelector('[data-testid="activity-count-blocked"]')?.textContent).toBe('…');
      expect(container.querySelector('[data-testid="activity-count-unavailable"]')?.textContent).toBe('…');
      expect(container.querySelector('[data-testid="activity-count-checking"]')?.textContent).toBe('…');
      expect(container.querySelector('[aria-label="Activity counts"]')?.textContent).not.toContain('0 blocked');

      const mixed = page(completeCountScope({
        completeness: { turns: true, agents: false, files: true, plans: false, commits: true },
      }), {
        ...counts,
        blockedOverlapCount: { value: 2, status: 'complete' },
        unavailableCount: { value: 0, status: 'complete' },
        checkingCount: { value: 6, status: 'complete' },
      });
      await act(async () => useDashboardStore.setState({ activityPage: mixed }));
      expect(container.querySelector('[data-testid="activity-count-turns"]')?.textContent).toBe('7 turns');
      expect(container.querySelector('[data-testid="activity-count-agents"]')?.textContent).toBe('3+');
      expect(container.querySelector('[data-testid="activity-count-files"]')?.textContent).toBe('5');
      expect(container.querySelector('[data-testid="activity-count-plans"]')?.textContent).toBe('2+');
      expect(container.querySelector('[data-testid="activity-count-commits"]')?.textContent).toBe('4');
      expect(container.querySelector('[data-testid="activity-count-blocked"]')?.textContent).toBe('2');
      expect(container.querySelector('[data-testid="activity-count-unavailable"]')?.textContent).toBe('0');
      expect(container.querySelector('[data-testid="activity-count-checking"]')?.textContent).toBe('6');

      const filteredComplete = page(completeCountScope({
        grouping: 'file', turnCountBasis: 'visible-file-group-members',
        filters: { eligibleOnly: true, agentId: 'agent-1', pathPrefix: 'src/renderer' },
      }));
      await act(async () => useDashboardStore.setState({ activityPage: filteredComplete }));
      expect(container.querySelector('[data-testid="activity-count-turns"]')?.textContent).toBe('7 visible turns under this path');
      expect(container.querySelector('[data-testid="activity-count-agents"]')?.textContent).toBe('3');
      expect(container.querySelector('[data-testid="activity-count-files"]')?.textContent).toBe('5');
      expect(container.querySelector('[data-testid="activity-count-plans"]')?.textContent).toBe('2');
      expect(container.querySelector('[data-testid="activity-count-commits"]')?.textContent).toBe('4');

      await act(async () => useDashboardStore.setState({ activityPage: page(completeCountScope()) }));
      expect(container.querySelector('[data-testid="activity-count-turns"]')?.textContent).toBe('7 turns');
    } finally {
      act(() => root.unmount());
    }
  });

  it('selects the File lens and issues one real file-grouped list request', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const initial = useDashboardStore.getInitialState();
    const activityPage = typedActivityPage({
      workspaceId: 'file-lens-ws', items: [],
      cursor: { snapshot: { throughTurnSeq: 0, throughFileActivityId: 0, capturedAt: 1 }, nextOlder: null },
      scope: completeCountScope(),
      pageCounts: { turnCount: 0, agentCount: 0, fileCount: 0, planCount: 0, commitCount: 0, noCheckpointCount: 0, blockedOverlapCount: { value: 0, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' } },
      scans: { turns: { scanned: 0, emitted: 0, exhausted: true, limit: 50 }, fileActivities: { scanned: 0, emitted: 0, exhausted: true, limit: 200 } },
    });
    const digest = vi.fn(async () => ({ page: null, sinceCounts: null, heartbeat: { serverState: 'live', observedAt: 1 } }));
    const list = vi.fn(async () => activityPage);
    const markViewed = vi.fn(async () => ({ workspaceId: 'file-lens-ws', turnSeq: 0, fileActivityId: 0, viewedAt: 1 }));
    (window as any).api = { activity: { digest, list, markViewed } };
    useDashboardStore.setState({
      selectedWorkspaceId: 'file-lens-ws', agents: [], activityPage: null,
      activityScope: { grouping: 'time' }, activityScopeHistory: [], activityLoading: true, activityError: null,
      setLens: initial.setLens, loadActivity: initial.loadActivity,
    } as any);
    try {
      await act(async () => root.render(React.createElement(ActivityTab)));
      const lens = container.querySelector('[aria-label="Activity lens"]')!;
      expect(lens.querySelector('[aria-pressed="true"]')?.textContent).toBe('Time');
      await act(async () => {
        (Array.from(lens.querySelectorAll('button')).find((button) => button.textContent === 'File') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      });
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'file-lens-ws', grouping: 'file' }));
      expect(useDashboardStore.getState().activityScope).toEqual({ grouping: 'file' });
    } finally {
      act(() => root.unmount());
    }
  });

  it('REACHABILITY:wp3-file-lens-drill renders file groups, retains filters in the drill query, and restores exact history', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const initial = useDashboardStore.getInitialState();
    const member = row('restorable');
    member.turnId = 'file-turn';
    member.taskLabel = 'Edit activity UI';
    const activityPage = typedActivityPage({
      workspaceId: 'ws',
      items: [{ kind: 'file-group', repoPath: 'src/renderer/ActivityTab.tsx', displayPath: 'src/renderer/ActivityTab.tsx', latestStartedAt: 2, members: [member], pageCounts: completeCounts() }],
      cursor: { snapshot: { throughTurnSeq: 1, throughFileActivityId: 1, capturedAt: 1 }, nextOlder: null },
      scope: completeCountScope({ grouping: 'file' }),
      pageCounts: { turnCount: 1, agentCount: 1, fileCount: 1, planCount: 1, commitCount: 0, noCheckpointCount: 0, blockedOverlapCount: { value: 0, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' } },
      scans: { turns: { scanned: 1, emitted: 1, exhausted: true, limit: 50 }, fileActivities: { scanned: 1, emitted: 1, exhausted: true, limit: 200 } },
    });
    const digest = vi.fn(async () => ({ page: null, sinceCounts: null, heartbeat: { serverState: 'live', observedAt: 1 } }));
    const list = vi.fn(async () => activityPage);
    const markViewed = vi.fn(async () => ({ workspaceId: 'ws', turnSeq: 1, fileActivityId: 1, viewedAt: 1 }));
    (window as any).api = { activity: { digest, list, markViewed } };
    const priorScope = { grouping: 'file' as const, agentId: 'agent-1', planId: 'plan-1', planItemId: 'WP-3' };
    useDashboardStore.setState({
      selectedWorkspaceId: 'ws', agents: [], activityPage, activityReturnCounts: activityPage.pageCounts,
      activityScope: priorScope, activityScopeHistory: [], activityLoading: false, activityError: null,
      loadActivity: initial.loadActivity, pushDrill: initial.pushDrill, popDrill: initial.popDrill, popToDepth: initial.popToDepth,
    } as any);
    try {
      await act(async () => root.render(React.createElement(ActivityTab)));
      expect(container.querySelector('[aria-label="Activity lens"]')?.textContent).toContain('File');
      expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe('File');
      const fileGroup = container.querySelector('[data-testid="activity-file-src/renderer/ActivityTab.tsx"]');
      expect(fileGroup?.textContent).toContain('Edit activity UI');

      await act(async () => {
        (fileGroup?.querySelector('button') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      });
      expect(list).toHaveBeenCalledWith(expect.objectContaining({
        grouping: 'time', pathPrefix: 'src/renderer/ActivityTab.tsx', agentId: 'agent-1', planId: 'plan-1', planItemId: 'WP-3',
      }));
      expect(useDashboardStore.getState().activityScopeHistory).toEqual([priorScope]);
      expect(container.querySelectorAll('[aria-label="Activity drill breadcrumb"] li')).toHaveLength(2);

      await act(async () => (Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Back') as HTMLButtonElement).click());
      expect(useDashboardStore.getState().activityScope).toEqual(priorScope);
      expect(useDashboardStore.getState().activityScopeHistory).toEqual([]);
    } finally {
      act(() => root.unmount());
    }
  });

  it('pops a breadcrumb to its represented history depth', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const initial = useDashboardStore.getInitialState();
    const rootScope = { grouping: 'file' as const, agentId: 'agent-1' };
    const middleScope = { grouping: 'time' as const, agentId: 'agent-1', pathPrefix: 'src' };
    const activityPage = typedActivityPage({
      workspaceId: 'crumb-ws', items: [],
      cursor: { snapshot: { throughTurnSeq: 0, throughFileActivityId: 0, capturedAt: 1 }, nextOlder: null },
      scope: completeCountScope(),
      pageCounts: { turnCount: 0, agentCount: 0, fileCount: 0, planCount: 0, commitCount: 0, noCheckpointCount: 0, blockedOverlapCount: { value: 0, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' } },
      scans: { turns: { scanned: 0, emitted: 0, exhausted: true, limit: 50 }, fileActivities: { scanned: 0, emitted: 0, exhausted: true, limit: 200 } },
    });
    const digest = vi.fn(async () => ({ page: null, sinceCounts: null, heartbeat: { serverState: 'live', observedAt: 1 } }));
    const list = vi.fn(async () => activityPage);
    const markViewed = vi.fn(async () => ({ workspaceId: 'crumb-ws', turnSeq: 0, fileActivityId: 0, viewedAt: 1 }));
    (window as any).api = { activity: { digest, list, markViewed } };
    useDashboardStore.setState({
      selectedWorkspaceId: 'crumb-ws', agents: [], activityPage: null, activityLoading: true, activityError: null,
      activityScope: { grouping: 'time', agentId: 'agent-1', pathPrefix: 'src/renderer' },
      activityScopeHistory: [rootScope, middleScope], popToDepth: initial.popToDepth, loadActivity: initial.loadActivity,
    } as any);
    try {
      await act(async () => root.render(React.createElement(ActivityTab)));
      const breadcrumb = container.querySelector('[aria-label="Activity drill breadcrumb"]')!;
      expect(breadcrumb.querySelectorAll('li')).toHaveLength(3);
      await act(async () => {
        (Array.from(breadcrumb.querySelectorAll('button')).find((button) => button.textContent === 'src') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      });
      expect(digest).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'crumb-ws', grouping: 'time', agentId: 'agent-1', pathPrefix: 'src' }));
      expect(useDashboardStore.getState().activityScope).toEqual(middleScope);
      expect(useDashboardStore.getState().activityScopeHistory).toEqual([rootScope]);
    } finally {
      act(() => root.unmount());
    }
  });

  it('removing the drilled path chip also removes store-derived breadcrumb navigation', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const initial = useDashboardStore.getInitialState();
    const member = row('restorable');
    const activityPage = typedActivityPage({
      workspaceId: 'chip-ws',
      items: [{ kind: 'file-group', repoPath: 'src/renderer', displayPath: 'src/renderer', latestStartedAt: 2, members: [member], pageCounts: completeCounts() }],
      cursor: { snapshot: { throughTurnSeq: 1, throughFileActivityId: 1, capturedAt: 1 }, nextOlder: null },
      scope: completeCountScope({ grouping: 'file' }),
      pageCounts: { turnCount: 1, agentCount: 1, fileCount: 1, planCount: 0, commitCount: 0, noCheckpointCount: 0, blockedOverlapCount: { value: 0, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' } },
      scans: { turns: { scanned: 1, emitted: 1, exhausted: true, limit: 50 }, fileActivities: { scanned: 1, emitted: 1, exhausted: true, limit: 200 } },
    });
    useDashboardStore.setState({
      selectedWorkspaceId: 'chip-ws', agents: [], activityPage, activityReturnCounts: activityPage.pageCounts,
      activityScope: { grouping: 'file', planId: 'plan-1' }, activityScopeHistory: [], activityLoading: false, activityError: null,
      pushDrill: initial.pushDrill, removeFilter: initial.removeFilter, loadActivity: vi.fn(async () => undefined),
    } as any);
    try {
      await act(async () => root.render(React.createElement(ActivityTab)));
      await act(async () => (container.querySelector('[data-testid="activity-file-src/renderer"] button') as HTMLButtonElement).click());
      expect(container.querySelector('[aria-label="Activity drill breadcrumb"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Remove pathPrefix filter"]')).not.toBeNull();
      await act(async () => (container.querySelector('[aria-label="Remove pathPrefix filter"]') as HTMLButtonElement).click());
      expect(useDashboardStore.getState().activityScopeHistory).toEqual([]);
      expect(container.querySelector('[aria-label="Activity drill breadcrumb"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('REACHABILITY:wp2-agent-picker-chips selects an agent and renders its removable chip', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const initial = useDashboardStore.getInitialState();
    const setAgentFilter = vi.fn(initial.setAgentFilter);
    useDashboardStore.setState({
      selectedWorkspaceId: 'ws', agents: [{ id: 'agent-2', workspaceId: 'ws', title: 'Review worker' }] as any,
      activityPage: null, activityScope: { grouping: 'time' }, activityLoading: true, activityError: null,
      setAgentFilter, loadActivity: vi.fn(async () => undefined),
    });
    try {
      await act(async () => root.render(React.createElement(ActivityTab)));
      const picker = container.querySelector('[aria-label="Filter activity by agent"]') as HTMLSelectElement;
      expect(picker).not.toBeNull();
      await act(async () => {
        picker.value = 'agent-2';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(setAgentFilter).toHaveBeenCalledWith('agent-2');
      expect(container.querySelector('[aria-label="Active activity filters"]')?.textContent).toContain('Agent: Review worker');
      expect(container.querySelector('[aria-label="Remove agentId filter"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('renders every incoming default filter as a removable chip and removal clears drill history', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const initial = useDashboardStore.getInitialState();
    const removeFilter = vi.fn(initial.removeFilter);
    useDashboardStore.setState({
      selectedWorkspaceId: 'ws', agents: [], activityPage: null, activityLoading: true, activityError: null,
      activityScope: { grouping: 'time', agentId: 'missing-agent', pathPrefix: 'src/main', planId: 'plan-1', planItemId: 'WP-2' },
      activityScopeHistory: [{ grouping: 'plan' }], removeFilter, loadActivity: vi.fn(async () => undefined),
    });
    await act(async () => root.render(React.createElement(ActivityTab)));
    const chips = container.querySelector('[aria-label="Active activity filters"]')!;
    expect(chips.textContent).toContain('Agent: missing-agent');
    expect(chips.textContent).toContain('Path: src/main');
    expect(chips.textContent).toContain('Plan: plan-1');
    expect(chips.textContent).toContain('Plan item: WP-2');
    await act(async () => (container.querySelector('[aria-label="Remove pathPrefix filter"]') as HTMLButtonElement).click());
    expect(removeFilter).toHaveBeenCalledWith('pathPrefix');
    expect(useDashboardStore.getState().activityScope.pathPrefix).toBeUndefined();
    expect(useDashboardStore.getState().activityScopeHistory).toEqual([]);
    await act(async () => (container.querySelector('[aria-label="Remove planId filter"]') as HTMLButtonElement).click());
    expect(removeFilter).toHaveBeenCalledWith('planId');
    await act(async () => (container.querySelector('[aria-label="Remove planItemId filter"]') as HTMLButtonElement).click());
    expect(removeFilter).toHaveBeenCalledWith('planItemId');
    await act(async () => (container.querySelector('[aria-label="Remove agentId filter"]') as HTMLButtonElement).click());
    expect(removeFilter).toHaveBeenCalledWith('agentId');
    act(() => root.unmount());
  });

  it('does not render Clear all for an unfiltered Time view', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    useDashboardStore.setState({
      selectedWorkspaceId: 'ws', agents: [], activityPage: null,
      activityScope: { grouping: 'time' }, activityLoading: true, activityError: null,
      loadActivity: vi.fn(async () => undefined),
    });
    await act(async () => root.render(React.createElement(ActivityTab)));
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Clear all')).toBe(false);
    act(() => root.unmount());
  });

  it('clears multiple filters atomically through one clear action and one request pair', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const initial = useDashboardStore.getInitialState();
    const digest = vi.fn(async () => ({
      page: null, sinceCounts: null,
      heartbeat: { serverState: 'live', observedAt: 1 },
    }));
    const list = vi.fn(async () => typedActivityPage({
      workspaceId: 'ws', items: [], cursor: { snapshot: { throughTurnSeq: 0, throughFileActivityId: 0, capturedAt: 1 }, nextOlder: null },
      scope: completeCountScope(),
      pageCounts: { turnCount: 0, agentCount: 0, fileCount: 0, planCount: 0, commitCount: 0, noCheckpointCount: 0, blockedOverlapCount: { value: 0, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' } },
      scans: { turns: { scanned: 0, emitted: 0, exhausted: true, limit: 50 }, fileActivities: { scanned: 0, emitted: 0, exhausted: true, limit: 200 } },
    }));
    const markViewed = vi.fn(async () => ({ workspaceId: 'ws', turnSeq: 0, fileActivityId: 0, viewedAt: 1 }));
    (window as any).api = { activity: { digest, list, markViewed } };
    const clearActivityFilters = vi.fn(initial.clearActivityFilters);
    const removeFilter = vi.fn(initial.removeFilter);
    useDashboardStore.setState({
      selectedWorkspaceId: 'ws', agents: [], activityPage: list.mock.results[0]?.value ?? null,
      activityScope: { grouping: 'time', agentId: 'agent-1', planId: 'plan-1', pathPrefix: 'src' },
      activityScopeHistory: [{ grouping: 'plan' }], activityLoading: true, activityError: null,
      clearActivityFilters, removeFilter, loadActivity: initial.loadActivity,
    } as any);
    await act(async () => root.render(React.createElement(ActivityTab)));
    const clearAll = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Clear all') as HTMLButtonElement;
    expect(clearAll).not.toBeNull();
    await act(async () => {
      clearAll.click();
      await vi.waitFor(() => expect(useDashboardStore.getState().activityLoading).toBe(false));
    });
    expect(clearActivityFilters).toHaveBeenCalledTimes(1);
    expect(removeFilter).not.toHaveBeenCalled();
    expect(digest).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().activityScope).toEqual({ grouping: 'time' });
    expect(useDashboardStore.getState().activityScopeHistory).toEqual([]);
    act(() => root.unmount());
  });

  it('uses the settled compact badge vocabulary', () => {
    expect(activityBadge(row('restorable'))).toBe('Restorable');
    expect(activityBadge(row('no-checkpoint'))).toBe('No restore point');
    expect(activityBadge(row('blocked-overlap', 'accepted', 'after-snapshot-overlap'))).toBe('Changed since turn');
    expect(activityBadge(row('blocked-overlap', 'accepted', 'active-turn-witnesses-path'))).toBe('Agent still editing');
    expect(activityBadge(row('blocked-overlap', 'accepted', 'merge-undo-conflict'))).toBe('Undo has conflicts');
    expect(activityBadge(row('checking'))).toBe('In progress');
    expect(activityBadge(row('restorable', 'open'))).toBe('In progress');
  });

  it('offers merged undo for exact drift without claiming a line conflict', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const drift = row('blocked-overlap', 'accepted', 'after-snapshot-overlap');
    drift.witnessedPaths = [{ repoPath: 'src/config.ts', displayPath: 'src/config.ts' }];
    const page = typedActivityPage({
      workspaceId: 'ws', items: [drift],
      cursor: { snapshot: { throughTurnSeq: 1, throughFileActivityId: 1, capturedAt: 1 }, nextOlder: null },
      scope: completeCountScope(),
      pageCounts: { turnCount: 1, agentCount: 1, fileCount: 1, planCount: 0, commitCount: 0, noCheckpointCount: 0, blockedOverlapCount: { value: 1, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' } },
      scans: { turns: { scanned: 1, emitted: 1, exhausted: true, limit: 50 }, fileActivities: { scanned: 0, emitted: 0, exhausted: true, limit: 200 } },
    });
    useDashboardStore.setState({ selectedWorkspaceId: 'ws', activityPage: page, activityReturnCounts: page.pageCounts, activityScope: { grouping: 'time' }, activityLoading: false, activityError: null, loadActivity: vi.fn(async () => undefined) } as any);
    await act(async () => root.render(React.createElement(ActivityTab)));
    expect(container.textContent).toContain('Exact restore would overwrite those changes');
    expect(container.textContent).not.toContain('line conflict');
    const offer = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Preview merged undo')) as HTMLButtonElement;
    act(() => offer.click());
    expect(container.querySelector('[data-testid="restore-dialog"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('tells the user to wait or stop the active agent for live contention', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const live = row('blocked-overlap', 'accepted', 'active-turn-witnesses-path');
    const page = typedActivityPage({ workspaceId: 'ws', items: [live], cursor: { snapshot: { throughTurnSeq: 1, throughFileActivityId: 1, capturedAt: 1 }, nextOlder: null }, scope: completeCountScope(), pageCounts: { turnCount: 1, agentCount: 1, fileCount: 0, planCount: 0, commitCount: 0, noCheckpointCount: 0, blockedOverlapCount: { value: 1, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' } }, scans: { turns: { scanned: 1, emitted: 1, exhausted: true, limit: 50 }, fileActivities: { scanned: 0, emitted: 0, exhausted: true, limit: 200 } } });
    useDashboardStore.setState({ selectedWorkspaceId: 'ws', activityPage: page, activityReturnCounts: page.pageCounts, activityScope: { grouping: 'time' }, activityLoading: false, activityError: null, loadActivity: vi.fn(async () => undefined) } as any);
    await act(async () => root.render(React.createElement(ActivityTab)));
    expect(container.textContent).toContain('Wait for it to finish or stop the agent');
    act(() => root.unmount());
  });

  it('renders tool-unjoined with its own honest source copy', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const item: Extract<ActivityItem, { kind: 'tool-unjoined' }> = {
      kind: 'tool-unjoined', id: 'tool:a:1:1', agentId: 'a', agentTitle: 'Agent',
      fileActivityIds: [1], paths: [], startedAt: 1, endedAt: 2,
    };
    act(() => root.render(React.createElement(OtherRow, { item })));
    expect(container.textContent).toContain('Tool or script activity outside a recorded turn');
    expect(container.textContent).not.toContain('Agent edit');
    act(() => root.unmount());
  });

  it('renders the omission cue even when no changed paths can be listed', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const item: Extract<ActivityItem, { kind: 'window-unattributed' }> = {
      kind: 'window-unattributed', id: 'win:t1', hostTurnId: 't1', hostTurnSeq: 1,
      paths: [], omittedPathCount: null, hasOmittedPaths: true,
    };
    act(() => root.render(React.createElement(OtherRow, { item })));
    expect(container.textContent).toContain('Additional changed paths cannot be displayed.');
    act(() => root.unmount());
  });

  it('makes no new-items claim on a zero-new revisit and keeps older pages reachable', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const originalLoad = useDashboardStore.getState().loadActivity;
    const originalLoadOlder = useDashboardStore.getState().loadOlderActivity;
    const page: ActivityPage = {
      workspaceId: 'ws', items: [],
      cursor: {
        snapshot: { throughTurnSeq: 8, throughFileActivityId: 13, capturedAt: 100 },
        nextOlder: {
          turns: { before: 8, exhausted: false },
          fileActivities: { before: 13, exhausted: false },
        },
      },
      scope: completeCountScope({ grouping: 'none' }),
      pageCounts: {
        turnCount: 0, agentCount: 0, fileCount: 0, planCount: 0, commitCount: 0, noCheckpointCount: 0,
        blockedOverlapCount: { value: 0, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' },
      },
      scans: { turns: { scanned: 0, emitted: 0, exhausted: false, limit: 50 }, fileActivities: { scanned: 0, emitted: 0, exhausted: false, limit: 200 } },
    };
    useDashboardStore.setState({
      selectedWorkspaceId: 'ws', activityPage: page, activityReturnCounts: page.pageCounts,
      activityScope: { grouping: 'none' }, activityLoading: false, activityError: null,
      loadActivity: vi.fn(async () => undefined), loadOlderActivity: vi.fn(async () => undefined),
    });
    act(() => root.render(React.createElement(ActivityTab)));
    expect(container.textContent).not.toContain('since you last viewed');
    expect(container.textContent).toContain('Load older activity');
    act(() => root.unmount());
    useDashboardStore.setState({ loadActivity: originalLoad, loadOlderActivity: originalLoadOlder });
  });

  it('keeps Load older reachable in the default Time lens while a source is below cap', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const originalLoad = useDashboardStore.getState().loadActivity;
    const originalLoadOlder = useDashboardStore.getState().loadOlderActivity;
    const page: ActivityPage = {
      workspaceId: 'ws', items: [],
      cursor: {
        snapshot: { throughTurnSeq: 8, throughFileActivityId: 13, capturedAt: 100 },
        nextOlder: {
          turns: { before: 8, exhausted: false },
          fileActivities: { before: 13, exhausted: false },
        },
      },
      scope: completeCountScope(),
      pageCounts: {
        turnCount: 0, agentCount: 0, fileCount: 0, planCount: 0, commitCount: 0, noCheckpointCount: 0,
        blockedOverlapCount: { value: 0, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' },
      },
      scans: { turns: { scanned: 50, emitted: 0, exhausted: false, limit: 50 }, fileActivities: { scanned: 200, emitted: 0, exhausted: false, limit: 200 } },
    };
    useDashboardStore.setState({
      selectedWorkspaceId: 'ws', activityPage: page, activityReturnCounts: page.pageCounts,
      activityScope: { grouping: 'time' }, activityTurnWindow: 50, activityFileWindow: 200,
      activityLoading: false, activityError: null,
      loadActivity: vi.fn(async () => undefined), loadOlderActivity: vi.fn(async () => undefined),
    });
    act(() => root.render(React.createElement(ActivityTab)));
    expect(container.querySelector('[aria-label="Activity lens"] [aria-pressed="true"]')?.textContent).toBe('Time');
    expect(container.textContent).toContain('Load older activity');
    expect(container.textContent).not.toContain('switch to Flat to continue');
    act(() => root.unmount());
    useDashboardStore.setState({ loadActivity: originalLoad, loadOlderActivity: originalLoadOlder });
  });

  it('explains a non-repo workspace and enables checkpoints through the existing consent flow', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const gitInit = vi.fn(async () => ({
      ok: true as const,
      status: 'initialized' as const,
      message: 'Created a Git repository at the workspace root.',
    }));
    (window as any).api = { checkpoints: { gitInit } };
    useDashboardStore.setState({
      selectedWorkspaceId: 'ws',
      workspaces: [{ id: 'ws', title: 'plain-folder' }] as any,
      prerequisites: {
        optional: [{ id: 'git', status: 'available', git: { repoState: 'non-repo', protectedRoot: false } }],
      } as any,
      activityPage: null,
      activityReturnCounts: null,
      activityScope: { grouping: 'time' }, activityLoading: false, activityError: null,
      loadActivity: vi.fn(async () => undefined),
      loadPrerequisites: vi.fn(async () => null),
      checkHealth: vi.fn(async () => undefined),
    } as any);

    await act(async () => root.render(React.createElement(ActivityTab)));
    expect(container.textContent).toContain('Checkpoints are unavailable because this folder is not a Git repository.');
    const enable = container.querySelector('[data-testid="git-init-enable"]') as HTMLButtonElement;
    expect(enable).not.toBeNull();
    await act(async () => enable.click());
    expect(gitInit).toHaveBeenCalledWith('ws');
    act(() => root.unmount());
  });

  it('explains the protected-root refusal without offering a dead Enable action', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    useDashboardStore.setState({
      selectedWorkspaceId: 'ws',
      prerequisites: {
        optional: [{ id: 'git', status: 'missing', git: { repoState: 'non-repo', protectedRoot: true } }],
      } as any,
      activityPage: null,
      activityReturnCounts: null,
      activityScope: { grouping: 'time' }, activityLoading: false, activityError: null,
      loadActivity: vi.fn(async () => undefined),
    } as any);

    await act(async () => root.render(React.createElement(ActivityTab)));
    expect(container.textContent).toContain('This folder is a protected root.');
    expect(container.textContent).toContain('Open a specific project subfolder instead.');
    expect(container.querySelector('[data-testid="git-init-enable"]')).toBeNull();
    act(() => root.unmount());
  });

  it('REACHABILITY:wp1-day-group-render opens on Time and renders older day gaps before the older group', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const newer = row('restorable');
    newer.turnId = 'newer'; newer.taskLabel = 'Newest work'; newer.startedAt = Date.UTC(2026, 7, 23, 18);
    const older = row('restorable');
    older.turnId = 'older'; older.taskLabel = 'Older work'; older.startedAt = Date.UTC(2026, 7, 22, 12);
    const activityPage = typedActivityPage({
      workspaceId: 'ws',
      items: [
        { kind: 'day-group', dayKey: '2026-08-23', timeZone: 'UTC', latestStartedAt: newer.startedAt, gapFromNewerGroupMs: null, members: [newer], pageCounts: completeCounts() },
        { kind: 'day-group', dayKey: '2026-08-22', timeZone: 'UTC', latestStartedAt: older.startedAt, gapFromNewerGroupMs: 6 * 3_600_000, members: [older], pageCounts: completeCounts() },
      ],
      cursor: { snapshot: { throughTurnSeq: 2, throughFileActivityId: 0, capturedAt: 1 }, nextOlder: null },
      scope: completeCountScope(),
      pageCounts: { turnCount: 2, agentCount: 1, fileCount: 0, planCount: 0, commitCount: 0, noCheckpointCount: 0, blockedOverlapCount: { value: 0, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' } },
      scans: { turns: { scanned: 2, emitted: 2, exhausted: true, limit: 50 }, fileActivities: { scanned: 0, emitted: 0, exhausted: true, limit: 200 } },
    });
    const setLens = vi.fn();
    useDashboardStore.setState({ selectedWorkspaceId: 'ws', activityPage, activityReturnCounts: activityPage.pageCounts, activityScope: { grouping: 'time' }, activityTurnWindow: 50, activityFileWindow: 200, activityLoading: false, activityError: null, setLens, loadActivity: vi.fn(async () => undefined) } as any);
    await act(async () => root.render(React.createElement(ActivityTab)));
    const lens = container.querySelector('[aria-label="Activity lens"]')!;
    expect(lens.querySelector('[aria-pressed="true"]')?.textContent).toBe('Time');
    expect(container.textContent).toContain('Newest work');
    expect(container.textContent).toContain('Older work');
    expect(container.textContent).toContain('6h later');
    expect(container.querySelector('[data-testid="activity-day-2026-08-23"] [role="separator"]')).toBeNull();
    expect(container.querySelector('[data-testid="activity-day-2026-08-22"] [role="separator"]')?.textContent).toContain('6h later');
    act(() => (Array.from(lens.querySelectorAll('button')).find((button) => button.textContent === 'Plan') as HTMLButtonElement).click());
    expect(setLens).toHaveBeenCalledWith('plan');
    act(() => root.unmount());
  });

  it('uses the guarded mount fallback once and does not reload on scope changes', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const loadActivity = vi.fn(async () => undefined);
    useDashboardStore.setState({ selectedWorkspaceId: 'ws', activityPage: null, activityScope: { grouping: 'time' }, activityLoading: false, activityError: null, loadActivity } as any);
    await act(async () => root.render(React.createElement(ActivityTab)));
    expect(loadActivity).toHaveBeenCalledTimes(1);
    await act(async () => useDashboardStore.setState({ activityScope: { grouping: 'plan' } }));
    expect(loadActivity).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('shows the grouped cap notice instead of a looping Load older button', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const activityPage = typedActivityPage({
      workspaceId: 'ws', items: [],
      cursor: { snapshot: { throughTurnSeq: 8, throughFileActivityId: 13, capturedAt: 100 }, nextOlder: { turns: { before: 1, exhausted: false }, fileActivities: { before: 1, exhausted: false } } },
      scope: completeCountScope(),
      pageCounts: { turnCount: 0, agentCount: 0, fileCount: 0, planCount: 0, commitCount: 0, noCheckpointCount: 0, blockedOverlapCount: { value: 0, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' } },
      scans: { turns: { scanned: 200, emitted: 0, exhausted: false, limit: 200 }, fileActivities: { scanned: 10_000, emitted: 0, exhausted: false, limit: 10_000 } },
    });
    useDashboardStore.setState({ selectedWorkspaceId: 'ws', activityPage, activityScope: { grouping: 'time' }, activityTurnWindow: 200, activityFileWindow: 10_000, activityLoading: false, activityError: null, loadActivity: vi.fn(async () => undefined) } as any);
    await act(async () => root.render(React.createElement(ActivityTab)));
    expect(container.textContent).toContain('More history is available — switch to Flat to continue.');
    expect(container.textContent).not.toContain('Load older activity');
    act(() => root.unmount());
  });
});
