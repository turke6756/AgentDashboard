import React, { useEffect, Component, ErrorInfo, ReactNode } from 'react';
import { useDashboardStore } from './stores/dashboard-store';
import Sidebar from './components/layout/Sidebar';
import MainContent from './components/layout/MainContent';
import DetailPanel from './components/layout/DetailPanel';
import TerminalPanel from './components/terminal/TerminalPanel';
import ResizeDivider from './components/layout/ResizeDivider';
import { useResize } from './hooks/useResize';

// Error boundary to catch React render crashes and show the error instead of white screen
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Caught:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center h-screen bg-surface-0 text-gray-100 p-8">
          <div className="max-w-lg bg-surface-2 border border-accent-red/50 rounded-lg p-6">
            <h2 className="text-accent-red font-bold text-lg mb-3">Render Error</h2>
            <pre className="text-sm text-gray-300 whitespace-pre-wrap break-words mb-4 font-mono bg-surface-0 p-3 rounded max-h-60 overflow-auto">
              {this.state.error.message}
              {'\n\n'}
              {this.state.error.stack}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="px-4 py-2 bg-accent-blue text-white rounded font-medium text-sm"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppInner() {
  const { loadWorkspaces, checkHealth, panelLayout, setPanelSize, terminalAgentId } = useDashboardStore();

  useEffect(() => {
    loadWorkspaces();
    checkHealth();

    const unsubStatus = window.api.onAgentStatusChanged(({ agentId, status, agent }) => {
      if (agent) {
        const store = useDashboardStore.getState();
        store.updateAgent(agent);
        store.updateWorkspaceHeat();
      }
    });

    const unsubContext = window.api.agents.onContextStatsChanged((stats) => {
      useDashboardStore.getState().updateContextStats(stats);
    });

    return () => {
      unsubStatus();
      unsubContext();
    };
  }, []);

  const sidebarResize = useResize({
    direction: 'horizontal',
    initialSize: panelLayout.sidebarWidth,
    min: 180,
    max: 500,
    storageKey: 'panel-sidebar-width',
  });

  const detailResize = useResize({
    direction: 'horizontal',
    initialSize: panelLayout.detailPanelWidth,
    min: 280,
    max: 700,
    storageKey: 'panel-detail-width',
  });

  const terminalResize = useResize({
    direction: 'vertical',
    initialSize: panelLayout.terminalHeight,
    min: 100,
    max: 600,
    storageKey: 'panel-terminal-height',
  });

  // Sync resize values to store when they change
  useEffect(() => {
    setPanelSize('sidebarWidth', sidebarResize.size);
  }, [sidebarResize.size]);

  useEffect(() => {
    setPanelSize('detailPanelWidth', detailResize.size);
  }, [detailResize.size]);

  useEffect(() => {
    setPanelSize('terminalHeight', terminalResize.size);
  }, [terminalResize.size]);

  const sidebarCollapsed = panelLayout.sidebarCollapsed;
  const detailCollapsed = panelLayout.detailPanelCollapsed;

  return (
    <div className="flex h-screen bg-surface-0 text-gray-100 grid-bg relative overflow-hidden">
      <div className="scanlines pointer-events-none" />

      {/* Sidebar */}
      <Sidebar width={sidebarCollapsed ? 40 : sidebarResize.size} />

      {/* Sidebar resize divider */}
      {!sidebarCollapsed && (
        <ResizeDivider
          direction="horizontal"
          isResizing={sidebarResize.isResizing}
          onMouseDown={sidebarResize.handleMouseDown}
        />
      )}

      {/* Center + Detail */}
      <div className="flex flex-1 min-w-0 min-h-0 z-10">
        {/* Main content column (with terminal below) */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          <MainContent />

          {/* Terminal resize divider (above terminal) — hidden when collapsed */}
          {terminalAgentId !== null && !panelLayout.terminalCollapsed && (
            <ResizeDivider
              direction="vertical"
              isResizing={terminalResize.isResizing}
              onMouseDown={terminalResize.handleMouseDown}
            />
          )}

          <TerminalPanel height={terminalResize.size} />
        </div>

        {/* Detail resize divider */}
        {!detailCollapsed && (
          <ResizeDivider
            direction="horizontal"
            isResizing={detailResize.isResizing}
            onMouseDown={detailResize.handleMouseDown}
          />
        )}

        {/* Detail panel — full height, independent of terminal */}
        <DetailPanel width={detailCollapsed ? 40 : detailResize.size} />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
