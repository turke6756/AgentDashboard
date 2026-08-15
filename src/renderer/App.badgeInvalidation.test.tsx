// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPlanBadge, PlanBadgesInvalidatedPayload } from '../shared/types';
import App from './App';
import { useDashboardStore } from './stores/dashboard-store';

vi.mock('./hooks/useDoubleSpaceSidePanelCollapse', () => ({
  useDoubleSpaceSidePanelCollapse: () => undefined,
}));
vi.mock('./hooks/useResize', () => ({
  useResize: () => ({ size: 200, isResizing: false, handleMouseDown: vi.fn() }),
}));

vi.mock('./components/layout/Sidebar', () => ({ default: () => null }));
vi.mock('./components/layout/TopBar', () => ({ default: () => null }));
vi.mock('./components/layout/MainContent', () => ({ default: () => null }));
vi.mock('./components/layout/DetailPanel', () => ({ default: () => null }));
vi.mock('./components/terminal/TerminalPanel', () => ({ default: () => null }));
vi.mock('./components/layout/ResizeDivider', () => ({ default: () => null }));
vi.mock('./components/fileviewer/DetachedFileView', () => ({ default: () => null }));
vi.mock('./components/layout/DetachedViewShell', () => ({ default: () => null }));
vi.mock('./components/watchdog/PressureNotification', () => ({ default: () => null }));
vi.mock('./components/watchdog/LogRetentionNotice', () => ({ default: () => null }));
vi.mock('./components/memory/MemoryWarningBanner', () => ({ default: () => null }));
vi.mock('./components/workspace/SecurityNoticeCard', () => ({ default: () => null }));
vi.mock('./components/workspace/GitignoreSuggestionCard', () => ({ default: () => null }));
vi.mock('./components/onboarding/RuntimePrerequisitesDialog', () => ({ default: () => null }));
vi.mock('./components/onboarding/PrerequisitesCard', () => ({ default: () => null }));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const workspaceId = 'workspace-a';
const emptyBadges: Record<string, AgentPlanBadge> = {};
const olderBadges = { older: [] as AgentPlanBadge };
const newerBadges = { newer: [] as AgentPlanBadge };

let invalidationCallback: ((payload: PlanBadgesInvalidatedPayload) => void) | undefined;
let unsubscribe: ReturnType<typeof vi.fn>;
let getAgentPlanBadgeSummary: ReturnType<typeof vi.fn>;

function listener(): (payload: PlanBadgesInvalidatedPayload) => void {
  expect(invalidationCallback).toBeTypeOf('function');
  return invalidationCallback!;
}

function mountApp(): { unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<App />));
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function installApi(): void {
  const noOpSubscription = vi.fn(() => vi.fn());
  unsubscribe = vi.fn();
  getAgentPlanBadgeSummary = vi.fn(async () => emptyBadges);
  (window as any).api = {
    workspaces: { list: vi.fn(async () => []) },
    system: {
      healthCheck: vi.fn(async () => ({})),
      getRuntimePrerequisites: vi.fn(async () => null),
    },
    agents: {
      listAll: vi.fn(async () => []),
      listContinuationPhases: vi.fn(async () => []),
      onContinuationPhaseChanged: noOpSubscription,
      onContextStatsChanged: noOpSubscription,
      onPlanBadgesInvalidated: vi.fn((callback: typeof invalidationCallback) => {
        invalidationCallback = callback;
        return unsubscribe;
      }),
      getAgentPlanBadgeSummary,
    },
    usage: {
      getLimits: vi.fn(async () => null),
      onLimitsChanged: noOpSubscription,
    },
    tabs: { onDetachedClosed: noOpSubscription },
    views: { onClosed: noOpSubscription },
    onAgentStatusChanged: noOpSubscription,
    onAgentDeleted: noOpSubscription,
    onTeamUpdated: noOpSubscription,
    onTeamMessageCreated: noOpSubscription,
    listActiveOrchestrations: vi.fn(async () => []),
    onOrchestrationActiveChanged: noOpSubscription,
    onOpenFileTab: noOpSubscription,
  };
}

beforeEach(() => {
  invalidationCallback = undefined;
  installApi();
  window.history.replaceState({}, '', '/');
  useDashboardStore.setState({
    selectedWorkspaceId: workspaceId,
    agentPlanBadges: emptyBadges,
    workspaces: [],
    agents: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('plan badge invalidation subscription', () => {
  it.each([
    ['main dashboard', '/'],
    ['detached dashboard', '/?detached=1&view=dashboard'],
  ])('REACHABILITY:badge-invalidation-subscription installs at the top-level %s route and unsubscribes exactly once', (_label, url) => {
    window.history.replaceState({}, '', url);

    const view = mountApp();
    expect((window as any).api.agents.onPlanBadgesInvalidated).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('refetches once for a matching workspace and never queries for a foreign workspace', async () => {
    const view = mountApp();
    getAgentPlanBadgeSummary.mockClear();

    act(() => listener()({ workspaceId: 'workspace-b' }));
    expect(getAgentPlanBadgeSummary).not.toHaveBeenCalled();

    await act(async () => listener()({ workspaceId }));
    expect(getAgentPlanBadgeSummary).toHaveBeenCalledTimes(1);
    expect(getAgentPlanBadgeSummary).toHaveBeenCalledWith(workspaceId);
    view.unmount();
  });

  it('discards an older same-workspace response that resolves after a newer response', async () => {
    window.history.replaceState({}, '', '/?detached=1&view=dashboard');
    const first = deferred<Record<string, AgentPlanBadge>>();
    const second = deferred<Record<string, AgentPlanBadge>>();
    getAgentPlanBadgeSummary
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const view = mountApp();

    act(() => listener()({ workspaceId }));
    act(() => listener()({ workspaceId }));
    await act(async () => second.resolve(newerBadges));
    expect(useDashboardStore.getState().agentPlanBadges).toEqual(newerBadges);

    await act(async () => first.resolve(olderBadges));
    expect(useDashboardStore.getState().agentPlanBadges).toEqual(newerBadges);
    view.unmount();
  });

  it('does not apply a response after the selected workspace changes', async () => {
    window.history.replaceState({}, '', '/?detached=1&view=dashboard');
    const initialBadges = { initial: [] as AgentPlanBadge };
    useDashboardStore.setState({ agentPlanBadges: initialBadges });
    const pending = deferred<Record<string, AgentPlanBadge>>();
    getAgentPlanBadgeSummary.mockImplementationOnce(() => pending.promise);
    const view = mountApp();

    act(() => listener()({ workspaceId }));
    act(() => useDashboardStore.setState({ selectedWorkspaceId: 'workspace-b' }));
    await act(async () => pending.resolve(olderBadges));

    expect(useDashboardStore.getState().agentPlanBadges).toEqual(initialBadges);
    view.unmount();
  });
});
