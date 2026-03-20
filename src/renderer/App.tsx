import React, { useEffect } from 'react';
import { useDashboardStore } from './stores/dashboard-store';
import Sidebar from './components/layout/Sidebar';
import MainContent from './components/layout/MainContent';
import DetailPanel from './components/layout/DetailPanel';
import TerminalPanel from './components/terminal/TerminalPanel';
import ResizeDivider from './components/layout/ResizeDivider';
import { useResize } from './hooks/useResize';

export default function App() {
  const { loadWorkspaces, checkHealth, panelLayout, setPanelSize } = useDashboardStore();

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

      {/* Center + Detail + Terminal */}
      <div className="flex flex-col flex-1 min-w-0 z-10">
        <div className="flex flex-1 min-h-0">
          <MainContent />

          {/* Detail resize divider */}
          {!detailCollapsed && (
            <ResizeDivider
              direction="horizontal"
              isResizing={detailResize.isResizing}
              onMouseDown={detailResize.handleMouseDown}
            />
          )}

          <DetailPanel width={detailCollapsed ? 40 : detailResize.size} />
        </div>

        {/* Terminal resize divider (above terminal) */}
        <ResizeDivider
          direction="vertical"
          isResizing={terminalResize.isResizing}
          onMouseDown={terminalResize.handleMouseDown}
        />

        <TerminalPanel height={terminalResize.size} />
      </div>
    </div>
  );
}
