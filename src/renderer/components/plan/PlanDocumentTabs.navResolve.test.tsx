// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PlanDocumentsModel } from '../../../shared/types';
import PlanDocumentTabs, { type PlanDocumentNavigationResult } from './PlanDocumentTabs';
import PlanSurfaceContainer from './PlanSurfaceContainer';
import { useDashboardStore, type PlanDocumentNavigationRequest } from '../../stores/dashboard-store';

vi.mock('./PlanSurfaceView', () => ({ default: () => null }));

const requestId = '00000000-0000-4000-8000-000000000007';

function planModel(includeProposal = true): PlanDocumentsModel {
  return {
    planId: 'plan-1',
    warnings: [],
    tabs: [
      { key: 'overview', populated: false, documents: [] },
      ...(includeProposal ? [{ key: 'proposal' as const, populated: false, documents: [] }] : []),
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;
let documents: ReturnType<typeof vi.fn>;
let revealInDetached: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  documents = vi.fn(async () => planModel());
  revealInDetached = vi.fn(async () => ({ ok: true as const }));
  (window as unknown as { api: unknown }).api = {
    plans: {
      documents,
      revealInDetached,
      readDocument: vi.fn(),
      getOverview: vi.fn(async () => null),
      listIntents: vi.fn(async () => null),
      previewCandidate: vi.fn(async () => ({ candidate: { members: [] }, selection: null })),
    },
  };
  useDashboardStore.setState({
    openTabs: [],
    activeTabId: null,
    fileViewerOpen: false,
    browserOpen: false,
    plansOpen: false,
    detachedViews: [],
    selectedWorkspaceId: 'ws-1',
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderTabs(
  request: PlanDocumentNavigationRequest,
  onNavigationResolved: (result: PlanDocumentNavigationResult) => void,
): void {
  act(() => {
    root.render(
      <PlanDocumentTabs
        planId="plan-1"
        navigationRequest={request}
        onNavigationResolved={onNavigationResolved}
      />,
    );
  });
}

function renderPanel(request?: PlanDocumentNavigationRequest): void {
  act(() => {
    root.render(<PlanSurfaceContainer planId="plan-1" navigationRequest={request} />);
  });
}

describe('PlanDocumentTabs confirmed navigation', () => {
  it('waits for the projection to settle and for the requested tab to commit', async () => {
    const pending = deferred<PlanDocumentsModel>();
    documents.mockReturnValueOnce(pending.promise);
    const resolved = vi.fn();
    renderTabs({ requestId, planId: 'plan-1', tab: 'proposal' }, resolved);

    await flush();
    expect(resolved).not.toHaveBeenCalled();

    pending.resolve(planModel());
    await flush();
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith({ requestId, tab: 'proposal', ok: true });
    expect(container.querySelector('[data-tab-key="proposal"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('reports tab-absent only after a settled projection commits', async () => {
    documents.mockResolvedValueOnce(planModel(false));
    const resolved = vi.fn();
    renderTabs({ requestId, planId: 'plan-1', tab: 'proposal' }, resolved);

    await flush();
    expect(resolved).toHaveBeenCalledOnce();
    expect(resolved).toHaveBeenCalledWith({ requestId, ok: false, reason: 'tab-absent' });
  });

  it('does not resolve against a settled model belonging to a different requested plan', async () => {
    const resolved = vi.fn();
    renderTabs({ requestId, planId: 'plan-b', tab: 'overview' }, resolved);

    await flush();
    expect(resolved).not.toHaveBeenCalled();
  });

  it('refuses a mismatched settled model when request and component plan ids agree (pins model identity)', async () => {
    documents.mockResolvedValueOnce({ ...planModel(), planId: 'plan-b' });
    const resolved = vi.fn();
    renderTabs({ requestId, planId: 'plan-1', tab: 'overview' }, resolved);

    await flush();
    expect(documents).toHaveBeenCalledWith('plan-1');
    expect(container.querySelector('[data-tab-key="overview"]')).not.toBeNull();
    expect(resolved).not.toHaveBeenCalled();
  });

  it('honors a requestId once across re-entry and later tab changes', async () => {
    const resolved = vi.fn();
    const request = { requestId, planId: 'plan-1', tab: 'proposal' as const };
    renderTabs(request, resolved);
    await flush();
    expect(resolved).toHaveBeenCalledOnce();

    renderTabs(request, resolved);
    await act(async () => {
      (container.querySelector('[data-tab-key="overview"]') as HTMLButtonElement).click();
      (container.querySelector('[data-tab-key="proposal"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(resolved).toHaveBeenCalledOnce();
  });
});

describe('openPlanTab production entry and registry cleanup', () => {
  it('reports a missing projection and visibly opens the gallery', async () => {
    documents.mockResolvedValueOnce(null);
    const outcome = await useDashboardStore.getState().openPlanTab('missing', 'Missing plan', 'ws-1');
    expect(outcome).toEqual({
      kind: 'fallback-gallery',
      reason: 'Plan no longer exists; opened the plans gallery.',
    });
    expect(useDashboardStore.getState().plansOpen).toBe(true);
    expect(useDashboardStore.getState().openTabs).toHaveLength(0);
  });

  it('targets the detached Plans window and reports its confirmed reveal', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestId);
    useDashboardStore.setState({ detachedViews: ['plans'] });
    await expect(useDashboardStore.getState().openPlanTab('plan-1', 'Plan one', 'ws-1'))
      .resolves.toEqual({ kind: 'revealed-detached', tab: 'overview' });
    expect(revealInDetached).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      planId: 'plan-1',
      tab: 'overview',
      requestId,
    });
    expect(documents).not.toHaveBeenCalled();
    expect(useDashboardStore.getState().openTabs).toHaveLength(0);
  });

  it('recovers a timed-out detached window by undetaching and opening the main gallery', async () => {
    revealInDetached.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    useDashboardStore.setState({ detachedViews: ['plans'] });
    await expect(useDashboardStore.getState().openPlanTab('plan-1', 'Plan one', 'ws-1'))
      .resolves.toEqual({
        kind: 'fallback-gallery',
        reason: 'Detached plans window was gone; opened the gallery here.',
      });
    expect(useDashboardStore.getState().detachedViews).not.toContain('plans');
    expect(useDashboardStore.getState().plansOpen).toBe(true);
  });

  it('keeps a found rejecting window detached and reports the typed destination failure', async () => {
    revealInDetached.mockResolvedValueOnce({ ok: false, reason: 'plan-absent' });
    useDashboardStore.setState({ detachedViews: ['plans'] });
    await expect(useDashboardStore.getState().openPlanTab('plan-1', 'Plan one', 'ws-1'))
      .resolves.toEqual({ kind: 'failed', reason: 'Plan no longer exists in the detached window.' });
    expect(useDashboardStore.getState().detachedViews).toContain('plans');
    expect(useDashboardStore.getState().plansOpen).toBe(false);
  });

  it('enters through openPlanTab and resolves only after the real document component commits', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestId);
    const outcomePromise = useDashboardStore.getState().openPlanTab(
      'plan-1', 'Plan one', 'ws-1', { tab: 'proposal' },
    );
    await flush();
    const tab = useDashboardStore.getState().openTabs[0];
    expect(tab.navigationRequest).toEqual({ requestId, planId: 'plan-1', tab: 'proposal' });

    renderTabs(tab.navigationRequest!, ({ requestId: completedId, ...result }) => {
      useDashboardStore.getState().resolvePlanNavigation(completedId, result);
    });
    await flush();
    await expect(outcomePromise).resolves.toEqual({ kind: 'opened-main', tab: 'proposal' });
    expect(useDashboardStore.getState().openTabs[0].navigationRequest).toBeUndefined();

    // Reusing the instrumented id proves the resolved entry was deleted.
    const second = useDashboardStore.getState().openPlanTab(
      'plan-1', 'Plan one', 'ws-1', { tab: 'overview' },
    );
    await flush();
    useDashboardStore.getState().resolvePlanNavigation(requestId, { ok: true, tab: 'overview' });
    await expect(second).resolves.toEqual({ kind: 'opened-main', tab: 'overview' });
  });

  it('clears the success timer so no late timeout can fire', async () => {
    vi.useFakeTimers();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestId);
    const outcome = useDashboardStore.getState().openPlanTab('plan-1', 'Plan one', 'ws-1');
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    useDashboardStore.getState().resolvePlanNavigation(requestId, { ok: true, tab: 'overview' });
    await expect(outcome).resolves.toEqual({ kind: 'opened-main', tab: 'overview' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(useDashboardStore.getState().openTabs[0].navigationRequest).toBeUndefined();
  });

  it('deletes a timed-out entry so the request id can be registered again', async () => {
    vi.useFakeTimers();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestId);
    const first = useDashboardStore.getState().openPlanTab('plan-1', 'Plan one', 'ws-1');
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toMatchObject({ kind: 'failed', reason: expect.stringContaining('Timed out') });
    expect(useDashboardStore.getState().openTabs[0].navigationRequest).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    // A resolver arriving after timeout cannot recreate state or change outcome.
    useDashboardStore.getState().resolvePlanNavigation(requestId, { ok: true, tab: 'overview' });
    expect(useDashboardStore.getState().openTabs[0].navigationRequest).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    const second = useDashboardStore.getState().openPlanTab('plan-1', 'Plan one', 'ws-1');
    await Promise.resolve();
    await Promise.resolve();
    useDashboardStore.getState().resolvePlanNavigation(requestId, { ok: true, tab: 'overview' });
    await expect(second).resolves.toEqual({ kind: 'opened-main', tab: 'overview' });
  });

  it('does not re-honor a settled request after the production panel remounts', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestId);
    const outcome = useDashboardStore.getState().openPlanTab(
      'plan-1', 'Plan one', 'ws-1', { tab: 'proposal' },
    );
    await flush();
    renderPanel(useDashboardStore.getState().openTabs[0].navigationRequest);
    await flush();
    await expect(outcome).resolves.toEqual({ kind: 'opened-main', tab: 'proposal' });
    expect(useDashboardStore.getState().openTabs[0].navigationRequest).toBeUndefined();

    act(() => root.unmount());
    root = createRoot(container);
    renderPanel(useDashboardStore.getState().openTabs[0].navigationRequest);
    await flush();
    expect(container.querySelector('[data-tab-key="overview"]')?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-tab-key="proposal"]')?.getAttribute('aria-selected')).toBe('false');
  });

  it('settles and deletes the entry when its production tab is disposed', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestId);
    const first = useDashboardStore.getState().openPlanTab('plan-1', 'Plan one', 'ws-1');
    await flush();
    useDashboardStore.getState().closeTab(useDashboardStore.getState().openTabs[0].id);
    await expect(first).resolves.toEqual({
      kind: 'failed',
      reason: 'Plan tab closed before navigation completed.',
    });

    const second = useDashboardStore.getState().openPlanTab('plan-1', 'Plan one', 'ws-1');
    await flush();
    useDashboardStore.getState().resolvePlanNavigation(requestId, { ok: true, tab: 'overview' });
    await expect(second).resolves.toEqual({ kind: 'opened-main', tab: 'overview' });
  });

  it('sweeps pending requests when tabs detach or all tabs close', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestId);
    const detached = useDashboardStore.getState().openPlanTab('plan-1', 'Plan one', 'ws-1');
    await flush();
    useDashboardStore.getState().detachTab(useDashboardStore.getState().openTabs[0].id);
    await expect(detached).resolves.toEqual({
      kind: 'failed',
      reason: 'Plan tab detached before navigation completed.',
    });

    const closed = useDashboardStore.getState().openPlanTab('plan-1', 'Plan one', 'ws-1');
    await flush();
    useDashboardStore.getState().closeAllTabs();
    await expect(closed).resolves.toEqual({
      kind: 'failed',
      reason: 'Plan tabs closed before navigation completed.',
    });

    const final = useDashboardStore.getState().openPlanTab('plan-1', 'Plan one', 'ws-1');
    await flush();
    useDashboardStore.getState().resolvePlanNavigation(requestId, { ok: true, tab: 'overview' });
    await expect(final).resolves.toEqual({ kind: 'opened-main', tab: 'overview' });
  });

  it('settles and deletes the entry when the document component unmounts mid-flight', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestId);
    const componentLoad = deferred<PlanDocumentsModel>();
    documents.mockResolvedValueOnce(planModel()).mockReturnValueOnce(componentLoad.promise);
    const first = useDashboardStore.getState().openPlanTab(
      'plan-1', 'Plan one', 'ws-1', { tab: 'proposal' },
    );
    await flush();
    const request = useDashboardStore.getState().openTabs[0].navigationRequest!;
    renderTabs(request, ({ requestId: completedId, ...result }) => {
      useDashboardStore.getState().resolvePlanNavigation(completedId, result);
    });
    await flush();

    act(() => root.unmount());
    await expect(first).resolves.toEqual({ kind: 'failed', reason: 'navigation-unmounted' });

    // A fresh root plus the same instrumented id proves unmount removed the entry.
    root = createRoot(container);
    documents.mockResolvedValueOnce(planModel());
    const second = useDashboardStore.getState().openPlanTab('plan-1', 'Plan one', 'ws-1');
    await flush();
    useDashboardStore.getState().resolvePlanNavigation(requestId, { ok: true, tab: 'overview' });
    await expect(second).resolves.toEqual({ kind: 'opened-main', tab: 'overview' });
  });
});
