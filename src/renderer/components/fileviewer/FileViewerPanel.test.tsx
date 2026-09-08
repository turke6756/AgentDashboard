// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardStore } from '../../stores/dashboard-store';

vi.mock('../../hooks/useResize', () => ({ useResize: () => ({ size: 240, isResizing: false, handleMouseDown: vi.fn() }) }));
vi.mock('./FileTabBar', () => ({ default: () => <div data-testid="tabs" /> }));
vi.mock('./FileViewerHeader', () => ({ default: () => <div data-testid="file-header" /> }));
vi.mock('./FileContentArea', () => ({ default: () => null }));
vi.mock('./DirectoryTree', () => ({ default: () => <div data-testid="directory-tree" /> }));
vi.mock('../layout/ResizeDivider', () => ({ default: () => null }));
vi.mock('../layout/CollapseButton', () => ({ default: () => null }));
vi.mock('../context-overhead/ContextOverheadPanel', () => ({ default: () => null }));
vi.mock('../agent-knowledge/AgentKnowledgePanel', () => ({ default: () => null }));
vi.mock('../skill-analytics/SkillAnalyticsPanel', () => ({ default: () => null }));
vi.mock('../context-optimizer/ContextOptimizerPanel', () => ({ default: () => null }));
vi.mock('../context-optimizer/CapstonePanel', () => ({ default: () => null }));
vi.mock('../plan/PlanSurfaceContainer', () => ({ default: () => null }));
vi.mock('../watchdog/SystemMemoryView', () => ({ default: () => null }));
vi.mock('../context-gauge/ContextWindowWarningPanel', () => ({ default: () => null }));
vi.mock('./useFileContentCache', () => ({ evictTabCache: vi.fn() }));
vi.mock('./saveCoordinator', () => ({ hasUnsavedWork: () => false, requestSave: vi.fn() }));
vi.mock('../orchestration/GroupThinkProvidersPanel', () => ({ default: () => <div>GroupThink provider settings panel</div> }));
vi.mock('../library/LibraryPane', () => ({
  default: ({ initialType }: { initialType?: string }) => (
    <div data-testid="library-pane" data-initial-type={initialType ?? ''}>Workspace Library</div>
  ),
}));

import FileViewerPanel from './FileViewerPanel';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  useDashboardStore.setState({
    selectedWorkspaceId: 'ws-1',
    activeTabId: 'groupthink-tab',
    openTabs: [{
      id: 'groupthink-tab', kind: 'tool', toolId: 'groupthink-providers', label: 'GroupThink Providers',
      workspaceId: 'ws-1', filePath: '', rootDirectory: '', pathType: 'windows',
    }],
  } as any);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  useDashboardStore.setState({ selectedWorkspaceId: null, activeTabId: null, openTabs: [] } as any);
});

describe('FileViewerPanel tool dispatch', () => {
  it('renders the dedicated GroupThink providers panel for its tool tab', () => {
    act(() => {
      root = createRoot(container);
      root.render(<FileViewerPanel />);
    });
    expect(container.textContent).toContain('GroupThink provider settings panel');
    expect(container.textContent).not.toContain('Unknown tool');
  });

  it('renders Library inside the tool-tab frame without file chrome', () => {
    useDashboardStore.setState({
      activeTabId: 'library-tab',
      openTabs: [{
        id: 'library-tab', kind: 'tool', toolId: 'library', label: 'Library',
        workspaceId: 'ws-1', filePath: '', rootDirectory: '', pathType: 'windows', params: { type: 'proposal' },
      }],
    } as any);

    act(() => {
      root = createRoot(container);
      root.render(<FileViewerPanel />);
    });

    expect(container.querySelector('[data-testid="tabs"]')).not.toBeNull();
    const libraryPane = container.querySelector('[data-testid="library-pane"]');
    expect(libraryPane, 'REACHABILITY:library:tool-tab').not.toBeNull();
    expect(libraryPane?.getAttribute('data-initial-type')).toBe('');
    expect(container.querySelector('[data-testid="file-header"]')).toBeNull();
    expect(container.querySelector('[data-testid="directory-tree"]')).toBeNull();
    expect(container.textContent).not.toContain('Unknown tool');
  });

  it('passes the research type only for research Library tabs and removes Library on tab switch', () => {
    useDashboardStore.setState({
      activeTabId: 'library-research-tab',
      openTabs: [
        {
          id: 'library-research-tab', kind: 'tool', toolId: 'library', label: 'Research Library',
          workspaceId: 'ws-1', filePath: '', rootDirectory: '', pathType: 'windows', params: { type: 'research' },
        },
        {
          id: 'groupthink-tab', kind: 'tool', toolId: 'groupthink-providers', label: 'GroupThink Providers',
          workspaceId: 'ws-1', filePath: '', rootDirectory: '', pathType: 'windows',
        },
      ],
    } as any);

    act(() => {
      root = createRoot(container);
      root.render(<FileViewerPanel />);
    });
    expect(container.querySelector('[data-testid="library-pane"]')?.getAttribute('data-initial-type')).toBe('research');

    act(() => useDashboardStore.setState({ activeTabId: 'groupthink-tab' }));
    expect(container.querySelector('[data-testid="library-pane"]')).toBeNull();
    expect(container.textContent).toContain('GroupThink provider settings panel');
  });
});
