import React, { useEffect } from 'react';
import { useDashboardStore } from './stores/dashboard-store';
import Sidebar from './components/layout/Sidebar';
import MainContent from './components/layout/MainContent';
import DetailPanel from './components/layout/DetailPanel';
import TerminalPanel from './components/terminal/TerminalPanel';

export default function App() {
  const { loadWorkspaces, checkHealth, terminalAgentId } = useDashboardStore();

  useEffect(() => {
    loadWorkspaces();
    checkHealth();

    const unsub = window.api.onAgentStatusChanged(({ agentId, status, agent }) => {
      if (agent) {
        const store = useDashboardStore.getState();
        store.updateAgent(agent);
        store.updateWorkspaceHeat();
      }
    });
    return unsub;
  }, []);

  return (
    <div className="flex h-screen bg-surface-0 text-gray-100">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex flex-1 min-h-0">
          <MainContent />
          <DetailPanel />
        </div>
        {terminalAgentId && <TerminalPanel />}
      </div>
    </div>
  );
}
