// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromotedPlanFolder } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import PromotedPlansList from './PromotedPlansList';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const workspace = { id: 'ws-1', path: 'C:\\work', pathType: 'windows', title: 'Work' } as any;
let host: HTMLDivElement;
let root: Root | null;
const openPlanTab = vi.fn();
const selectAgent = vi.fn();
let listPromotedFolders: ReturnType<typeof vi.fn>;
let deletePermanent: ReturnType<typeof vi.fn>;

function plan(overrides: Partial<PromotedPlanFolder> = {}): PromotedPlanFolder {
  return {
    planArtifactId: 'active-art',
    planId: 'active-id',
    folderName: 'active',
    title: 'Active plan',
    status: 'manifest-status',
    archived: false,
    updatedAt: 2,
    responsibleSupervisor: { display: 'Edward', agentId: 's1', source: 'manual-skill' },
    lifecycle: 'ready',
    rollup: { total: 2, landed: 1, remaining: 1, archived: 0, completed: false },
    activeVerifiedTurnCount: 0,
    activityTier: 'owner-live',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  openPlanTab.mockClear();
  selectAgent.mockClear();
  listPromotedFolders = vi.fn(async () => ({ plans: [
    plan(),
    plan({ planArtifactId: 'old-art', planId: 'old-id', folderName: 'old', title: 'Archived plan',
      lifecycle: 'archived', status: 'archived', archived: true, updatedAt: 1, responsibleSupervisor: null }),
  ], warnings: [] }));
  deletePermanent = vi.fn(async () => ({ ok: true, planId: 'old-id', releasedBaselineRefs: [] }));
  (window as any).api = { plans: { listPromotedFolders, deletePermanent } };
  useDashboardStore.setState({ workspaces: [workspace], selectedWorkspaceId: 'ws-1', openPlanTab, selectAgent } as any);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  host.remove();
  vi.useRealTimers();
});

async function render(): Promise<void> {
  await act(async () => { root?.render(<PromotedPlansList />); await Promise.resolve(); await Promise.resolve(); });
}

describe('PromotedPlansList', () => {
  it('hides archived plans by default and reveals them through the labeled history control', async () => {
    await render();
    expect(host.textContent).toContain('Active plan');
    expect(host.textContent).not.toContain('Archived plan');
    const toggle = host.querySelector<HTMLInputElement>('[data-testid="promoted-history-toggle"] input')!;
    act(() => toggle.click());
    expect(host.textContent).toContain('Archived plan');
  });

  it('double-clicks through the existing plan-tab route', async () => {
    await render();
    const row = host.querySelector<HTMLElement>('[data-testid="promoted-plan-row"]')!;
    act(() => row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(openPlanTab).toHaveBeenCalledWith('active-id', 'Active plan', 'ws-1');
  });

  it('REACHABILITY:wp4-card-renderer renders the projected lifecycle and treats an all-landed rollup as a completion prompt', async () => {
    listPromotedFolders.mockResolvedValueOnce({ plans: [
      plan({ title: 'Done plan', lifecycle: 'executing',
        rollup: { total: 2, landed: 2, remaining: 0, archived: 0, completed: true } }),
      plan({ planId: 'completed', folderName: 'completed', title: 'Completed plan', lifecycle: 'completed',
        latestLifecycleKind: 'completed', rollup: null }),
      plan({ planId: 'mixed', folderName: 'mixed', title: 'Mixed plan', lifecycle: 'ready',
        rollup: { total: 2, landed: 1, remaining: 0, archived: 1, completed: false } }),
    ], warnings: [] });
    await render();
    expect(host.querySelector('[data-testid="plans-promoted-region"]')).not.toBeNull();
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="promoted-plan-row"]'));
    const doneStatus = rows[0].querySelector<HTMLElement>('[data-testid="promoted-plan-status"]')!;
    expect(doneStatus.textContent).toBe('In implementation');
    expect(doneStatus.dataset.lifecycle).toBe('executing');
    expect(rows[0].querySelector('[data-testid="promoted-plan-all-landed"]')?.textContent)
      .toContain('All 2 packages landed');
    expect(rows[1].querySelector('[data-testid="promoted-plan-status"]')?.textContent).toBe('Completed');
    expect(rows[2].querySelector('[data-testid="promoted-plan-status"]')?.textContent).toBe('Ready');
    expect(rows[2].querySelector('[data-testid="promoted-plan-archived-count"]')?.textContent).toContain('1 archived');
  });

  it('renders pulse, steady dim, and no activity indicator directly from the DTO tier', async () => {
    listPromotedFolders.mockResolvedValueOnce({ plans: [
      plan({ activeVerifiedTurnCount: 2, activityTier: 'active' }),
      plan({ planId: 'owner-live', folderName: 'owner-live', title: 'Owner live plan', activityTier: 'owner-live' }),
      plan({ planId: 'idle', folderName: 'idle', title: 'Idle plan', responsibleSupervisor: null, activityTier: 'idle' }),
    ], warnings: [] });
    await render();
    const dots = host.querySelectorAll<HTMLElement>('[data-testid="promoted-plan-activity"]');
    expect(dots).toHaveLength(2);
    expect(dots[0].dataset.activityTier).toBe('active');
    expect(dots[0].getAttribute('title')).toBe('2 agents active');
    expect(dots[0].className).toContain('animate-pulse');
    expect(dots[1].dataset.activityTier).toBe('owner-live');
    expect(dots[1].className).not.toContain('animate-pulse');
    expect(host.querySelector('[data-testid="promoted-plan-owner"]')?.textContent).toContain('Edward');
  });

  it('focuses the live responsible agent with one click and disables an offline owner', async () => {
    listPromotedFolders.mockResolvedValueOnce({ plans: [
      plan(),
      plan({ planId: 'offline', folderName: 'offline', title: 'Offline plan', activityTier: 'idle' }),
    ], warnings: [] });
    await render();
    const owners = host.querySelectorAll<HTMLButtonElement>('[data-testid="promoted-plan-owner"]');
    act(() => owners[0].click());
    expect(selectAgent).toHaveBeenCalledWith('s1');
    expect(owners[1].disabled).toBe(true);
    expect(owners[1].textContent).toContain('owner offline');
  });

  it('offers lifecycle actions only in the states allowed by policy', async () => {
    listPromotedFolders.mockResolvedValueOnce({ plans: [
      plan({ title: 'Ready plan' }),
      plan({ planId: 'done', folderName: 'done', title: 'Done plan', lifecycle: 'completed' }),
      plan({ planId: 'archived', folderName: 'archived', title: 'Archived plan', lifecycle: 'archived', archived: true }),
    ], warnings: [] });
    await render();
    const toggle = host.querySelector<HTMLInputElement>('[data-testid="promoted-history-toggle"] input')!;
    act(() => toggle.click());
    const rows = host.querySelectorAll<HTMLElement>('[data-testid="promoted-plan-row"]');
    expect(rows[0].querySelector('[data-testid="promoted-plan-actions"]')?.textContent).toContain('Archive');
    expect(rows[0].querySelector('[data-testid="promoted-plan-actions"]')?.textContent).toContain('Complete');
    act(() => rows[0].querySelector<HTMLButtonElement>('[aria-label="Complete Ready plan"]')?.click());
    expect(selectAgent).toHaveBeenCalledWith('s1');
    expect(rows[1].querySelector('[data-testid="promoted-plan-actions"]')?.textContent).toBe('Archive');
    expect(rows[2].querySelector('[data-testid="promoted-plan-actions"]')?.textContent).toBe('Delete');
    expect(rows[2].querySelector<HTMLButtonElement>('[aria-label="Delete Archived plan"]')?.disabled).toBe(false);
  });

  it('REACHABILITY:wp5b-delete-wire confirms and invokes permanent deletion for an archived plan', async () => {
    await render();
    act(() => host.querySelector<HTMLInputElement>('[data-testid="promoted-history-toggle"] input')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Delete Archived plan"]')!.click());
    expect(deletePermanent).not.toHaveBeenCalled();
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('cannot be undone');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="promoted-plan-delete-confirm"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(deletePermanent).toHaveBeenCalledWith({ planId: 'old-id', confirmed: true });
  });

  it('renders a typed permanent-delete refusal to the user', async () => {
    deletePermanent.mockResolvedValueOnce({ ok: false, reason: 'plan-not-archived', runState: 'executing' });
    await render();
    act(() => host.querySelector<HTMLInputElement>('[data-testid="promoted-history-toggle"] input')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Delete Archived plan"]')!.click());
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="promoted-plan-delete-confirm"]')!.click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Only archived plans can be permanently deleted.');
  });

  it('keeps rows visible while a background refresh is pending', async () => {
    const pending = deferred<{ plans: PromotedPlanFolder[]; warnings: string[] }>();
    listPromotedFolders.mockResolvedValueOnce({ plans: [plan()], warnings: [] }).mockReturnValueOnce(pending.promise);
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(host.textContent).toContain('Active plan');
    expect(host.textContent).not.toContain('Loading promoted plans');
    pending.resolve({ plans: [plan()], warnings: [] });
    await act(async () => { await pending.promise; });
  });

  it('does not overlap background refresh requests', async () => {
    const pending = deferred<{ plans: PromotedPlanFolder[]; warnings: string[] }>();
    listPromotedFolders.mockResolvedValueOnce({ plans: [plan()], warnings: [] }).mockReturnValueOnce(pending.promise);
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(listPromotedFolders).toHaveBeenCalledTimes(2);
    pending.resolve({ plans: [plan()], warnings: [] });
    await act(async () => { await pending.promise; });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(listPromotedFolders).toHaveBeenCalledTimes(3);
  });

  it('ignores a response from the previously selected workspace', async () => {
    const oldResponse = deferred<{ plans: PromotedPlanFolder[]; warnings: string[] }>();
    listPromotedFolders.mockImplementation((workspaceId: string) => workspaceId === 'ws-1'
      ? oldResponse.promise
      : Promise.resolve({ plans: [plan({ title: 'New workspace plan' })], warnings: [] }));
    await render();
    const nextWorkspace = { ...workspace, id: 'ws-2', path: 'C:\\next' };
    await act(async () => {
      useDashboardStore.setState({ workspaces: [nextWorkspace], selectedWorkspaceId: 'ws-2' } as any);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('New workspace plan');
    oldResponse.resolve({ plans: [plan({ title: 'Stale workspace plan' })], warnings: [] });
    await act(async () => { await oldResponse.promise; });
    expect(host.textContent).toContain('New workspace plan');
    expect(host.textContent).not.toContain('Stale workspace plan');
  });

  it('clears the refresh timer on unmount', async () => {
    await render();
    expect(vi.getTimerCount()).toBe(1);
    act(() => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });
});
