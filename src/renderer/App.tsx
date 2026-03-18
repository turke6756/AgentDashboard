import React, { useEffect } from 'react';
import { useDashboardStore } from './stores/dashboard-store';
import Sidebar from './components/layout/Sidebar';
import MainContent from './components/layout/MainContent';
import DetailPanel from './components/layout/DetailPanel';
import TerminalPanel from './components/terminal/TerminalPanel';

export default function App() {
  const { loadWorkspaces, checkHealth } = useDashboardStore();

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

  return (
    <div className="flex h-screen bg-surface-0 text-gray-100 grid-bg relative overflow-hidden">
      <div className="scanlines pointer-events-none" />
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0 z-10">
        <div className="flex flex-1 min-h-0">
          <MainContent />
          <DetailPanel />
        </div>
        <TerminalPanel />
      </div>
    </div>
  );
}
