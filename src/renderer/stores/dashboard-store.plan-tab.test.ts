// @vitest-environment jsdom
//
// WP5 mount: openPlanTab opens a kind:'plan' tab in the shared file-tab strip,
// deduped by (workspace, planId) so re-opening the same plan re-focuses instead
// of stacking a duplicate — mirroring the tool-tab contract.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useDashboardStore } from './dashboard-store';

const store = () => useDashboardStore.getState();

beforeEach(() => {
  (window as unknown as { api: unknown }).api = {
    plans: {
      documents: vi.fn(async () => ({
        planId: 'plan-1', warnings: [], tabs: [{ key: 'overview', populated: false, documents: [] }],
      })),
    },
  };
  useDashboardStore.setState({
    openTabs: [],
    activeTabId: null,
    fileViewerOpen: false,
    browserOpen: false,
    selectedWorkspaceId: 'ws-1',
  });
});

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api;
});

async function open(planId: string, label: string, workspaceId?: string): Promise<void> {
  const outcome = store().openPlanTab(planId, label, workspaceId);
  await Promise.resolve();
  await Promise.resolve();
  const request = store().openTabs.find((tab) =>
    tab.planId === planId && tab.workspaceId === (workspaceId ?? 'ws-1'))?.navigationRequest;
  expect(request).toBeDefined();
  store().resolvePlanNavigation(request!.requestId, { ok: true, tab: request!.tab });
  await outcome;
}

describe('openPlanTab', () => {
  it('opens a plan tab (kind:plan) and makes it the active center view', async () => {
    await open('plan-1', 'auth', 'ws-1');
    const tabs = store().openTabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe('plan');
    expect(tabs[0].planId).toBe('plan-1');
    expect(tabs[0].label).toBe('auth');
    expect(tabs[0].workspaceId).toBe('ws-1');
    // Owns its content region like a tool tab: no file/tree read.
    expect(tabs[0].filePath).toBe('');
    expect(tabs[0].rootDirectory).toBe('');
    expect(store().activeTabId).toBe(tabs[0].id);
    expect(store().fileViewerOpen).toBe(true);
    expect(store().browserOpen).toBe(false);
  });

  it('re-focuses the existing tab instead of opening a duplicate for the same plan', async () => {
    await open('plan-1', 'auth', 'ws-1');
    const firstId = store().activeTabId;
    // Focus something else, then re-open the same plan.
    useDashboardStore.setState({ activeTabId: null, fileViewerOpen: false });
    await open('plan-1', 'auth', 'ws-1');
    expect(store().openTabs).toHaveLength(1);
    expect(store().activeTabId).toBe(firstId);
    expect(store().fileViewerOpen).toBe(true);
  });

  it('scopes the dedup by workspace — the same plan id in another workspace is a distinct tab', async () => {
    await open('plan-1', 'auth', 'ws-1');
    await open('plan-1', 'auth', 'ws-2');
    expect(store().openTabs).toHaveLength(2);
  });

  it('falls back to the selected workspace when none is passed', async () => {
    await open('plan-9', 'infra');
    expect(store().openTabs[0].workspaceId).toBe('ws-1');
  });
});
