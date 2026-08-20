// @vitest-environment jsdom
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityItem, ActivityPage, TurnActivityRow } from '../../../shared/types';
import ActivityTab, { activityBadge, OtherRow } from './ActivityTab';
import { useDashboardStore } from '../../stores/dashboard-store';

function row(state: TurnActivityRow['undo']['state'], status: TurnActivityRow['status'] = 'accepted'): TurnActivityRow {
  return {
    kind: 'turn', turnId: 'turn-1', turnSeq: 1, agentId: 'agent-1', agentTitle: 'Worker', taskLabel: 'Build',
    planId: null, planItemId: null, planStampStatus: 'unstamped', status, startedAt: 1, endedAt: 2,
    witnessedPaths: [], writeCount: 0,
    undo: { state, basis: 'stored-hints', reason: null, contention: [] },
    beforeReady: state === 'restorable', afterReady: state === 'restorable', beforeQuality: null, afterQuality: null,
    failureReason: null, beforePrunedAt: null, afterPrunedAt: null, commitOids: [],
  };
}

describe('Activity row copy', () => {
  it('uses the settled compact badge vocabulary', () => {
    expect(activityBadge(row('restorable'))).toBe('Restorable');
    expect(activityBadge(row('no-checkpoint'))).toBe('No restore point');
    expect(activityBadge(row('blocked-overlap'))).toBe('Undo blocked by later overlap');
    expect(activityBadge(row('checking'))).toBe('In progress');
    expect(activityBadge(row('restorable', 'open'))).toBe('In progress');
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
      activityFilter: {}, activityLoading: false, activityError: null,
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
      activityFilter: {}, activityLoading: false, activityError: null,
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
      activityFilter: {}, activityLoading: false, activityError: null,
      loadActivity: vi.fn(async () => undefined),
    } as any);

    await act(async () => root.render(React.createElement(ActivityTab)));
    expect(container.textContent).toContain('This folder is a protected root.');
    expect(container.textContent).toContain('Open a specific project subfolder instead.');
    expect(container.querySelector('[data-testid="git-init-enable"]')).toBeNull();
    act(() => root.unmount());
  });
});
