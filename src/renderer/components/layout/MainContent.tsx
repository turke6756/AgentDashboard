import React, { useState } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentGrid from '../agent/AgentGrid';
import AgentLaunchDialog from '../agent/AgentLaunchDialog';

export default function MainContent() {
  const { workspaces, selectedWorkspaceId, agents } = useDashboardStore();
  const [showLaunch, setShowLaunch] = useState(false);

  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);

  if (!workspace) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        <div className="text-center">
          <div className="text-4xl mb-4">&#x1f916;</div>
          <div className="text-lg">Select or create a workspace to get started</div>
        </div>
      </div>
    );
  }

  const activeCount = agents.filter(
    (a) => !['done', 'crashed'].includes(a.status)
  ).length;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Workspace Header */}
      <div className="px-6 py-4 border-b border-gray-800 bg-surface-1/50">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold">{workspace.title}</h2>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-xs text-gray-500 font-mono truncate max-w-[400px]">
                {workspace.path}
              </span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                  workspace.pathType === 'wsl'
                    ? 'bg-orange-500/20 text-orange-400'
                    : 'bg-blue-500/20 text-blue-400'
                }`}
              >
                {workspace.pathType === 'wsl' ? 'WSL' : 'WIN'}
              </span>
              <span className="text-xs text-gray-600">
                {activeCount} active
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => window.api.workspaces.openInVSCode(workspace.id)}
              className="px-3 py-1.5 text-sm bg-surface-2 hover:bg-surface-3 rounded-md transition-colors"
            >
              Open in VS Code
            </button>
            <button
              onClick={() => setShowLaunch(true)}
              className="px-3 py-1.5 text-sm bg-accent-blue hover:bg-accent-blue/80 text-white rounded-md transition-colors font-medium"
            >
              Launch Agent
            </button>
          </div>
        </div>
      </div>

      {/* Agent Grid */}
      <div className="flex-1 overflow-y-auto p-6">
        <AgentGrid />
      </div>

      {showLaunch && (
        <AgentLaunchDialog
          workspace={workspace}
          onClose={() => setShowLaunch(false)}
        />
      )}
    </div>
  );
}
