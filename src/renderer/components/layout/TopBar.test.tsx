// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardStore } from '../../stores/dashboard-store';
import TopBar from './TopBar';

vi.mock('../library/LibraryPane', () => ({ default: () => <div data-testid="library-pane" /> }));

let container: HTMLDivElement;
let root: Root;
let openToolTab: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  openToolTab = vi.fn();
  useDashboardStore.setState({ workspaces: [], selectedWorkspaceId: null, openTabs: [], activeTabId: null, openToolTab } as any);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe('TopBar Tools menu', () => {
  it('opens the GroupThink Providers tool tab', () => {
    act(() => {
      root = createRoot(container);
      root.render(<TopBar />);
    });
    const tools = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Tools')!;
    act(() => tools.click());
    const item = [...container.querySelectorAll('button')].find((button) => button.textContent === 'GroupThink Providers')!;
    act(() => item.click());
    expect(openToolTab).toHaveBeenCalledWith('groupthink-providers', 'GroupThink Providers');
  });

  it('does not mount Library content beneath the titlebar for an active Library tab', () => {
    useDashboardStore.setState({
      activeTabId: 'library-tab',
      openTabs: [{
        id: 'library-tab', kind: 'tool', toolId: 'library', label: 'Library',
        workspaceId: 'ws-1', filePath: '', rootDirectory: '', pathType: 'windows',
      }],
    } as any);

    act(() => {
      root = createRoot(container);
      root.render(<TopBar />);
    });

    expect(container.querySelector('[data-testid="library-pane"]')).toBeNull();
    expect(container.querySelector('.fixed.inset-x-0.bottom-0.top-8.z-40')).toBeNull();
  });
});
