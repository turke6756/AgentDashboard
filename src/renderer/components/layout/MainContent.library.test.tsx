// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MainContent from './MainContent';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof ResizeObserver !== 'function') {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
}

const storeMock = vi.hoisted(() => {
  const state: any = {
    workspaces: [{ id: 'ws-1', title: 'Workspace', path: '/ws', pathType: 'windows' }],
    selectedWorkspaceId: 'ws-1',
    fileViewerOpen: false,
    browserOpen: false,
    plansOpen: false,
    activityOpen: false,
    openTabs: [],
    activeTabId: null,
    detachedViews: [],
    showFileViewer: vi.fn(),
    showBrowser: vi.fn(),
    showDashboard: vi.fn(),
    showActivity: vi.fn(),
    openToolTab: vi.fn(),
    markViewDetached: vi.fn(),
  };
  const useDashboardStore: any = (selector: (value: typeof state) => unknown) => selector(state);
  useDashboardStore.getState = () => state;
  return { state, useDashboardStore };
});

vi.mock('../../stores/dashboard-store', () => ({ useDashboardStore: storeMock.useDashboardStore }));
vi.mock('../../stores/browser-store', () => ({
  useBrowserStore: (selector: (state: any) => unknown) => selector({ paneAttention: false }),
  ensureBrowserBridge: () => {},
}));
vi.mock('../agent/AgentGrid', () => ({ default: () => null }));
vi.mock('../agent/AgentLaunchDialog', () => ({ default: () => null }));
vi.mock('../fileviewer/FileViewerPanel', () => ({ default: () => null }));
vi.mock('../browser/BrowserPanel', () => ({ default: () => null }));
vi.mock('../plan/PlansPane', () => ({ default: () => null }));
vi.mock('../plan/PlansMenu', () => ({ default: () => null }));
vi.mock('../activity/ActivityTab', () => ({ default: () => null }));
vi.mock('../../assets/material-icons/vscode.svg', () => ({ default: 'vscode.svg' }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  storeMock.state.openTabs = [];
  storeMock.state.activeTabId = null;
  storeMock.state.openToolTab.mockClear();
  (globalThis as any).window.api = {
    views: { detach: vi.fn() },
    workspaces: { openInVSCode: vi.fn() },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MainContent workspace toolbar Library button', () => {
  it('opens the Library tool tab from between Activity and Open VS Code', () => {
    act(() => root.render(<MainContent />));

    const libraryButton = container.querySelector('[data-testid="view-btn-library"]') as HTMLButtonElement;
    expect(libraryButton).not.toBeNull();
    expect(libraryButton.getAttribute('aria-label')).toBe('Open Workspace Library');
    expect(libraryButton.previousElementSibling?.getAttribute('data-testid')).toBe('view-btn-activity');
    expect(libraryButton.nextElementSibling?.getAttribute('title')).toBe('Open workspace in VS Code');

    act(() => libraryButton.click());
    expect(storeMock.state.openToolTab).toHaveBeenCalledWith('library', 'Library');
  });

  it('shows pressed and active styling when Library is the active tool tab', () => {
    storeMock.state.openTabs = [{ id: 'library-tab', kind: 'tool', toolId: 'library' }];
    storeMock.state.activeTabId = 'library-tab';

    act(() => root.render(<MainContent />));

    const libraryButton = container.querySelector('[data-testid="view-btn-library"]') as HTMLButtonElement;
    expect(libraryButton.getAttribute('aria-pressed')).toBe('true');
    expect(libraryButton.classList.contains('is-active')).toBe(true);
  });
});
