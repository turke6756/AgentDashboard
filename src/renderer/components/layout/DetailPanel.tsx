import React, { useEffect, useState, useCallback } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import StatusBadge from '../agent/StatusBadge';
import DetailPaneContext from '../detail/DetailPaneContext';
import DetailPaneProducts from '../detail/DetailPaneProducts';
import DetailPaneLog from '../detail/DetailPaneLog';
import QueryDialog from '../agent/QueryDialog';
import type { PathType } from '../../../shared/types';

const TABS = [
  { label: 'Context', icon: '📖' },
  { label: 'Products', icon: '📦' },
  { label: 'Log', icon: '📋' },
] as const;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);
  return (
    <button
      onClick={handleCopy}
      className="text-[10px] text-gray-600 hover:text-gray-400 ml-1.5 transition-colors"
      title="Copy"
    >
      {copied ? 'copied' : 'copy'}
    </button>
  );
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr + 'Z');
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function DetailPanel() {
  const { agents, selectedAgentId, setTerminalAgent, terminalAgentId, detailPane, setDetailPane, workspaces } = useDashboardStore();
  const [contextCount, setContextCount] = useState(0);
  const [productsCount, setProductsCount] = useState(0);
  const [showMeta, setShowMeta] = useState(false);
  const [showQuery, setShowQuery] = useState(false);

  const agent = agents.find((a) => a.id === selectedAgentId);
  const workspace = agent ? workspaces.find((w) => w.id === agent.workspaceId) : null;
  const pathType: PathType = workspace?.pathType || 'windows';

  // Fetch counts for tab badges
  useEffect(() => {
    if (!agent) return;

    const fetchCounts = async () => {
      const reads = await window.api.agents.getFileActivities(agent.id, 'read');
      const writes = await window.api.agents.getFileActivities(agent.id);
      const uniqueReads = new Set(reads.map((a) => a.filePath)).size;
      const uniqueWrites = new Set(
        writes.filter((a) => a.operation === 'write' || a.operation === 'create').map((a) => a.filePath)
      ).size;
      setContextCount(uniqueReads);
      setProductsCount(uniqueWrites);
    };

    fetchCounts();
    const interval = setInterval(fetchCounts, 5000);

    const unsub = window.api.agents.onFileActivity((activity) => {
      if (activity.agentId === agent.id) {
        if (activity.operation === 'read') setContextCount((c) => c + 1);
        else setProductsCount((c) => c + 1);
      }
    });

    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [agent?.id]);

  if (!agent) {
    return (
      <div className="w-80 bg-surface-1 border-l border-gray-800 flex items-center justify-center text-gray-700 text-sm p-4">
        Select an agent to view details
      </div>
    );
  }

  const isAttached = terminalAgentId === agent.id;
  const tabCounts = [contextCount, productsCount, null];

  return (
    <div className="w-80 bg-surface-1 border-l border-gray-800 flex flex-col">
      {/* Agent info header */}
      <div className="p-4 border-b border-gray-800">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-bold text-lg truncate">{agent.title}</h3>
          <StatusBadge status={agent.status} />
        </div>
        {agent.roleDescription && (
          <p className="text-xs text-gray-500 mb-3">{agent.roleDescription}</p>
        )}
        <div className="space-y-1 text-xs text-gray-400">
          <div>
            <span className="text-gray-600">Dir: </span>
            <span className="font-mono">{agent.workingDirectory}</span>
          </div>
          <div>
            <span className="text-gray-600">Cmd: </span>
            <span className="font-mono">{agent.command}</span>
          </div>
          <div>
            <span className="text-gray-600">Restarts: </span>
            {agent.restartCount}
          </div>
          {agent.lastExitCode !== null && (
            <div>
              <span className="text-gray-600">Exit code: </span>
              {agent.lastExitCode}
            </div>
          )}
          {agent.tmuxSessionName && (
            <div>
              <span className="text-gray-600">Session: </span>
              <span className="font-mono">{agent.tmuxSessionName}</span>
            </div>
          )}
        </div>

        {/* Collapsible Metadata */}
        <button
          onClick={() => setShowMeta(!showMeta)}
          className="mt-2 text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
        >
          {showMeta ? 'Hide' : 'Show'} metadata
        </button>
        {showMeta && (
          <div className="mt-1.5 space-y-1 text-[11px] text-gray-500 bg-surface-0 rounded-md p-2">
            <div className="flex items-center">
              <span className="text-gray-600 w-16 shrink-0">ID:</span>
              <span className="font-mono truncate">{agent.id}</span>
              <CopyButton text={agent.id} />
            </div>
            {agent.pid && (
              <div className="flex items-center">
                <span className="text-gray-600 w-16 shrink-0">PID:</span>
                <span className="font-mono">{agent.pid}</span>
              </div>
            )}
            <div className="flex items-center">
              <span className="text-gray-600 w-16 shrink-0">Created:</span>
              <span>{formatDate(agent.createdAt)}</span>
            </div>
            <div className="flex items-center">
              <span className="text-gray-600 w-16 shrink-0">Updated:</span>
              <span>{formatDate(agent.updatedAt)}</span>
            </div>
            {agent.lastOutputAt && (
              <div className="flex items-center">
                <span className="text-gray-600 w-16 shrink-0">Output:</span>
                <span>{formatDate(agent.lastOutputAt)}</span>
              </div>
            )}
            {agent.resumeSessionId && (
              <div className="flex items-center">
                <span className="text-gray-600 w-16 shrink-0">Session:</span>
                <span className="font-mono truncate">{agent.resumeSessionId}</span>
                <CopyButton text={agent.resumeSessionId} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="p-3 border-b border-gray-800 flex gap-2">
        <button
          onClick={() => setTerminalAgent(isAttached ? null : agent.id)}
          className={`flex-1 px-2 py-1.5 text-xs rounded transition-colors font-medium ${
            isAttached
              ? 'bg-green-600 text-white'
              : 'bg-surface-2 hover:bg-surface-3 text-gray-300'
          }`}
        >
          {isAttached ? 'Detach' : 'Attach'}
        </button>
        <button
          onClick={() => setShowQuery(true)}
          disabled={!agent.resumeSessionId}
          className="flex-1 px-2 py-1.5 text-xs bg-purple-500/20 hover:bg-purple-500/30 rounded transition-colors text-purple-400 disabled:opacity-40 disabled:cursor-not-allowed"
          title={agent.resumeSessionId ? 'Query another agent' : 'No session ID'}
        >
          Query
        </button>
        <button
          onClick={() => window.api.agents.restart(agent.id)}
          className="flex-1 px-2 py-1.5 text-xs bg-surface-2 hover:bg-surface-3 rounded transition-colors text-gray-300"
        >
          Restart
        </button>
        <button
          onClick={() => window.api.agents.stop(agent.id)}
          className="flex-1 px-2 py-1.5 text-xs bg-red-500/20 hover:bg-red-500/30 rounded transition-colors text-red-400"
        >
          Stop
        </button>
      </div>

      {/* Tab strip */}
      <div className="flex border-b border-gray-800">
        {TABS.map((tab, index) => (
          <button
            key={tab.label}
            onClick={() => setDetailPane(index as 0 | 1 | 2)}
            className={`flex-1 px-2 py-2 text-xs font-medium transition-colors relative ${
              detailPane === index
                ? 'text-white'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <span>{tab.label}</span>
            {tabCounts[index] !== null && tabCounts[index]! > 0 && (
              <span className="ml-1.5 text-[10px] bg-surface-3 text-gray-400 px-1.5 py-0.5 rounded-full">
                {tabCounts[index]}
              </span>
            )}
            {detailPane === index && (
              <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-accent-blue rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Active pane */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {detailPane === 0 && <DetailPaneContext agentId={agent.id} pathType={pathType} />}
        {detailPane === 1 && <DetailPaneProducts agentId={agent.id} pathType={pathType} />}
        {detailPane === 2 && <DetailPaneLog agentId={agent.id} />}
      </div>

      {/* Query dialog */}
      {showQuery && agent && (
        <QueryDialog sourceAgent={agent} onClose={() => setShowQuery(false)} />
      )}
    </div>
  );
}
