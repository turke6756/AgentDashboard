// @vitest-environment jsdom
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityItem, ActivityPage, TurnActivityRow } from '../../../shared/types';
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

describe('Activity row copy', () => {
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
    const page = {
      workspaceId: 'ws', items: [drift],
      cursor: { snapshot: { throughTurnSeq: 1, throughFileActivityId: 1, capturedAt: 1 }, nextOlder: null },
      pageCounts: { turnCount: 1, agentCount: 1, fileCount: 1, planCount: 0, commitCount: 0, noCheckpointCount: 0, blockedOverlapCount: { value: 1, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' } },
      scans: { turns: { scanned: 1, emitted: 1, exhausted: true, limit: 50 }, fileActivities: { scanned: 0, emitted: 0, exhausted: true, limit: 200 } },
    } as ActivityPage;
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
    const page = { workspaceId: 'ws', items: [live], cursor: { snapshot: { throughTurnSeq: 1, throughFileActivityId: 1, capturedAt: 1 }, nextOlder: null }, pageCounts: { turnCount: 1, agentCount: 1, fileCount: 0, planCount: 0, commitCount: 0, noCheckpointCount: 0, blockedOverlapCount: { value: 1, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' } }, scans: { turns: { scanned: 1, emitted: 1, exhausted: true, limit: 50 }, fileActivities: { scanned: 0, emitted: 0, exhausted: true, limit: 200 } } } as ActivityPage;
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
    const activityPage = {
      workspaceId: 'ws',
      items: [
        { kind: 'day-group', dayKey: '2026-08-23', timeZone: 'UTC', latestStartedAt: newer.startedAt, gapFromNewerGroupMs: null, members: [newer], pageCounts: {} },
        { kind: 'day-group', dayKey: '2026-08-22', timeZone: 'UTC', latestStartedAt: older.startedAt, gapFromNewerGroupMs: 6 * 3_600_000, members: [older], pageCounts: {} },
      ],
      cursor: { snapshot: { throughTurnSeq: 2, throughFileActivityId: 0, capturedAt: 1 }, nextOlder: null },
      pageCounts: { turnCount: 2, agentCount: 1, fileCount: 0, planCount: 0, commitCount: 0, noCheckpointCount: 0, blockedOverlapCount: { value: 0, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' } },
      scans: { turns: { scanned: 2, emitted: 2, exhausted: true, limit: 50 }, fileActivities: { scanned: 0, emitted: 0, exhausted: true, limit: 200 } },
    } as ActivityPage;
    const setLens = vi.fn();
    useDashboardStore.setState({ selectedWorkspaceId: 'ws', activityPage, activityReturnCounts: activityPage.pageCounts, activityScope: { grouping: 'time' }, activityTurnWindow: 50, activityFileWindow: 200, activityLoading: false, activityError: null, setLens, loadActivity: vi.fn(async () => undefined) } as any);
    await act(async () => root.render(React.createElement(ActivityTab)));
    const lens = container.querySelector('[aria-label="Activity lens"]')!;
    expect(lens.querySelector('[aria-pressed="true"]')?.textContent).toBe('Time');
    expect(container.textContent).toContain('Newest work');
    expect(container.textContent).toContain('Older work');
    expect(container.textContent).toContain('6h later');
    expect(container.querySelector('[data-testid="activity-day-2026-08-23"] [role="separator"]')).toBeNull();
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
    const activityPage = {
      workspaceId: 'ws', items: [],
      cursor: { snapshot: { throughTurnSeq: 8, throughFileActivityId: 13, capturedAt: 100 }, nextOlder: { turns: { before: 1, exhausted: false }, fileActivities: { before: 1, exhausted: false } } },
      pageCounts: { turnCount: 0, agentCount: 0, fileCount: 0, planCount: 0, commitCount: 0, noCheckpointCount: 0, blockedOverlapCount: { value: 0, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' } },
      scans: { turns: { scanned: 200, emitted: 0, exhausted: false, limit: 200 }, fileActivities: { scanned: 10_000, emitted: 0, exhausted: false, limit: 10_000 } },
    } as ActivityPage;
    useDashboardStore.setState({ selectedWorkspaceId: 'ws', activityPage, activityScope: { grouping: 'time' }, activityTurnWindow: 200, activityFileWindow: 10_000, activityLoading: false, activityError: null, loadActivity: vi.fn(async () => undefined) } as any);
    await act(async () => root.render(React.createElement(ActivityTab)));
    expect(container.textContent).toContain('More history is available — switch to Flat to continue.');
    expect(container.textContent).not.toContain('Load older activity');
    act(() => root.unmount());
  });
});
