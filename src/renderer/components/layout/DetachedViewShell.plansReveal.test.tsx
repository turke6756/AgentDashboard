// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PlanDetachedRevealAckPayload,
  PlanDetachedRevealRequest,
  PlanDocumentsModel,
} from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';

vi.mock('../agent/AgentGrid', () => ({ default: () => null }));
vi.mock('../fileviewer/FileViewerPanel', () => ({ default: () => null }));
vi.mock('../browser/BrowserPanel', () => ({ default: () => null }));
vi.mock('../plan/PlanSurfaceView', () => ({ default: () => null }));

import DetachedViewShell from './DetachedViewShell';

function model(planId: string): PlanDocumentsModel {
  return {
    planId,
    warnings: [],
    tabs: [{ key: 'overview', populated: false, documents: [] }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;
let revealListener: ((request: PlanDetachedRevealRequest) => void) | undefined;
let acknowledgements: PlanDetachedRevealAckPayload[];
let documents: ReturnType<typeof vi.fn>;
let planBProjection: ReturnType<typeof deferred<PlanDocumentsModel>>;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountPlansShell(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(<DetachedViewShell params={new URLSearchParams('view=plans&workspaceId=ws-1&label=Plans')} />);
  });
  await flush();
  expect(revealListener).toBeTypeOf('function');
  expect(documents).toHaveBeenCalledWith('plan-a');
  expect(container.querySelector('[data-tab-key="overview"]')?.getAttribute('aria-selected')).toBe('true');
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  acknowledgements = [];
  revealListener = undefined;
  planBProjection = deferred<PlanDocumentsModel>();
  const perPlanCalls = new Map<string, number>();
  documents = vi.fn((planId: string) => {
    const call = (perPlanCalls.get(planId) ?? 0) + 1;
    perPlanCalls.set(planId, call);
    if (planId === 'plan-b' && call === 2) return planBProjection.promise;
    return Promise.resolve(model(planId));
  });

  (window as unknown as { api: unknown }).api = {
    workspaces: { list: vi.fn(async () => [{ id: 'ws-1', title: 'Workspace', path: 'C:\\ws', pathType: 'windows' }]) },
    agents: {
      list: vi.fn(async () => []),
      listAll: vi.fn(async () => []),
      getAgentPlanBadgeSummary: vi.fn(async () => ({})),
      listContinuationPhases: vi.fn(async () => []),
      onContinuationPhaseChanged: vi.fn(() => () => {}),
      onContextStatsChanged: vi.fn(() => () => {}),
    },
    teams: { list: vi.fn(async () => []) },
    plans: {
      list: vi.fn(async () => [{ id: 'plan-a', title: 'Plan A', slug: 'plan-a', path: 'plan-a.html', format: 'html' }]),
      documents,
      readDocument: vi.fn(),
      getOverview: vi.fn(async () => null),
      listIntents: vi.fn(async () => null),
      previewCandidate: vi.fn(async () => ({ candidate: { members: [] }, selection: null })),
      onRevealInDetached: vi.fn((listener: (request: PlanDetachedRevealRequest) => void) => {
        revealListener = listener;
        return () => { revealListener = undefined; };
      }),
      acknowledgeDetachedReveal: vi.fn((payload: PlanDetachedRevealAckPayload) => {
        acknowledgements.push(payload);
      }),
    },
    onAgentStatusChanged: vi.fn(() => () => {}),
    onAgentDeleted: vi.fn(() => () => {}),
  };
  useDashboardStore.setState({
    workspaces: [],
    agents: [],
    selectedWorkspaceId: null,
    continuationPhases: {},
    openTabs: [],
    detachedViews: [],
  });
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container.remove();
  delete (window as unknown as { api?: unknown }).api;
});

describe('DetachedPlansView targeted reveal', () => {
  it('remounts the real plan container before the same-commit plan swap can observe stale state (pins key)', async () => {
    await mountPlansShell();
    const planAContainer = container.querySelector('[data-testid="plan-surface-container"]');
    expect(planAContainer).not.toBeNull();

    await act(async () => {
      revealListener?.({
        workspaceId: 'ws-1',
        planId: 'plan-b',
        tab: 'overview',
        requestId: 'reveal-b-key-guard',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const planBContainer = container.querySelector('[data-testid="plan-surface-container"]');
    expect(planBContainer).not.toBeNull();
    expect(planBContainer).not.toBe(planAContainer);
    expect(acknowledgements).toEqual([]);

    planBProjection.resolve(model('plan-b'));
    await flush();
    expect(acknowledgements).toEqual([{ requestId: 'reveal-b-key-guard', ok: true }]);
  });

  it('reveals plan B while plan A is displayed and does not ack until B is genuinely settled', async () => {
    await mountPlansShell();

    await act(async () => {
      revealListener?.({
        workspaceId: 'ws-1',
        planId: 'plan-b',
        tab: 'overview',
        requestId: 'reveal-b',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(documents).toHaveBeenCalledTimes(3); // A, authoritative B, rendered B
    expect(acknowledgements).toEqual([]);

    planBProjection.resolve(model('plan-b'));
    await flush();

    expect(acknowledgements).toEqual([{ requestId: 'reveal-b', ok: true }]);
    expect(container.querySelector('[data-tab-key="overview"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('settles a superseded reveal instead of allowing its main timeout to undetach the live window', async () => {
    await mountPlansShell();

    await act(async () => {
      revealListener?.({ workspaceId: 'ws-1', planId: 'plan-b', tab: 'overview', requestId: 'reveal-b' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(acknowledgements).toEqual([]);

    await act(async () => {
      revealListener?.({ workspaceId: 'ws-1', planId: 'plan-c', tab: 'overview', requestId: 'reveal-c' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(acknowledgements).toEqual([
      { requestId: 'reveal-b', ok: false, reason: 'superseded' },
      { requestId: 'reveal-c', ok: true },
    ]);

    planBProjection.resolve(model('plan-b'));
    await flush();
    expect(acknowledgements).toHaveLength(2);
  });
});
