import React, { useEffect, useState, useCallback } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import StatusBadge from '../agent/StatusBadge';
import DetailPaneContext from '../detail/DetailPaneContext';
import DetailPaneProducts from '../detail/DetailPaneProducts';
import DetailPaneLog from '../detail/DetailPaneLog';
import QueryDialog from '../agent/QueryDialog';
import CollapseButton from './CollapseButton';
import type { PathType, ContextStats } from '../../../shared/types';

const TABS = [
  { label: 'CONTEXT', icon: '\u{1F4D6}' },
  { label: 'OUTPUTS', icon: '\u{1F4E6}' },
  { label: 'LOGS', icon: '\u{1F4CB}' },
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
      className="text-[9px] text-accent-blue hover:text-white ml-2 transition-colors uppercase border border-accent-blue/30 px-1 rounded-sm"
      title="Copy to clipboard"
    >
      {copied ? 'COPIED' : 'CPY'}
    </button>
  );
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '---';
  const d = new Date(dateStr + 'Z');
  return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

interface DetailPanelProps {
  width: number;
}

export default function DetailPanel({ width }: DetailPanelProps) {
  const { agents, selectedAgentId, setTerminalAgent, terminalAgentId, detailPane, setDetailPane, workspaces, contextStats, panelLayout, togglePanelCollapsed } = useDashboardStore();
  const [contextCount, setContextCount] = useState(0);
  const [productsCount, setProductsCount] = useState(0);
  const [showMeta, setShowMeta] = useState(false);
  const [showQuery, setShowQuery] = useState(false);
  const collapsed = panelLayout.detailPanelCollapsed;

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

  // Collapsed detail panel: thin strip with expand button
  if (collapsed) {
    return (
      <div
        className="bg-surface-1/90 backdrop-blur border-l border-gray-800 flex flex-col items-center z-20 shadow-2xl py-2"
        style={{ width }}
      >
        <CollapseButton collapsed direction="right" onClick={() => togglePanelCollapsed('detailPanelCollapsed')} />
        <div className="mt-2 text-[9px] font-mono text-accent-blue" style={{ writingMode: 'vertical-rl' }}>
          DETAIL
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div
        className="bg-surface-1/90 backdrop-blur border-l border-gray-800 flex flex-col z-20 shadow-2xl"
        style={{ width }}
      >
        <div className="flex items-center justify-end p-1 border-b border-gray-800">
          <CollapseButton collapsed={false} direction="right" onClick={() => togglePanelCollapsed('detailPanelCollapsed')} />
        </div>
        <div className="flex-1 flex items-center justify-center text-gray-600 font-mono text-xs uppercase tracking-widest p-4">
          [NO_DATA_STREAM_SELECTED]
        </div>
      </div>
    );
  }

  const isAttached = terminalAgentId === agent.id;
  const tabCounts = [contextCount, productsCount, null];

  return (
    <div
      className="bg-surface-1/90 backdrop-blur border-l border-gray-800 flex flex-col font-mono relative shadow-2xl z-20"
      style={{ width }}
    >
      {/* Decorative line */}
      <div className="absolute left-0 top-0 bottom-0 w-[1px] bg-gradient-to-b from-accent-blue/50 via-transparent to-accent-blue/50" />

      {/* Agent info header */}
      <div className="p-4 border-b border-gray-800 relative overflow-hidden">
        <div className="absolute top-0 right-0 p-1 opacity-20 pointer-events-none">
             <svg width="60" height="60" viewBox="0 0 100 100" fill="none" stroke="currentColor" className="text-accent-blue">
                 <circle cx="50" cy="50" r="40" strokeWidth="1" strokeDasharray="4 4" />
                 <path d="M50 10 L50 90 M10 50 L90 50" strokeWidth="1" />
             </svg>
        </div>

        <div className="flex items-center justify-between mb-3 relative z-10">
          <h3 className="font-bold text-lg truncate uppercase tracking-wider text-white glow-text">{agent.title}</h3>
          <div className="flex items-center gap-1">
            <StatusBadge status={agent.status} />
            <CollapseButton collapsed={false} direction="right" onClick={() => togglePanelCollapsed('detailPanelCollapsed')} />
          </div>
        </div>

        <div className="space-y-1 text-[10px] text-gray-400 font-mono uppercase tracking-tight relative z-10">
          <div className="flex">
            <span className="text-accent-blue w-16 shrink-0 opacity-70">DIR::</span>
            <span className="truncate text-gray-300">{agent.workingDirectory}</span>
          </div>
          <div className="flex">
            <span className="text-accent-blue w-16 shrink-0 opacity-70">CMD::</span>
            <span className="truncate text-gray-300">{agent.command}</span>
          </div>
          <div className="flex">
             <span className="text-accent-blue w-16 shrink-0 opacity-70">SES::</span>
             <span className="truncate text-gray-300">{agent.tmuxSessionName || 'N/A'}</span>
          </div>
        </div>

        {/* Collapsible Metadata */}
        <button
          onClick={() => setShowMeta(!showMeta)}
          className="mt-3 w-full text-[9px] border border-gray-800 hover:border-accent-blue/50 text-gray-500 hover:text-accent-blue transition-colors uppercase py-1 flex justify-center items-center gap-2"
        >
          {showMeta ? '[-] COLLAPSE_META' : '[+] EXPAND_META'}
        </button>

        {showMeta && (
          <div className="mt-2 space-y-1 text-[10px] text-gray-400 bg-black/40 border border-gray-800 p-2 font-mono">
            <div className="flex items-center justify-between border-b border-gray-800 pb-1 mb-1">
               <span className="text-accent-blue">SYSTEM_METRICS</span>
            </div>
            <div className="flex items-center">
              <span className="text-gray-600 w-16 shrink-0">UUID:</span>
              <span className="truncate text-gray-300">{agent.id}</span>
              <CopyButton text={agent.id} />
            </div>
            {agent.pid && (
              <div className="flex items-center">
                <span className="text-gray-600 w-16 shrink-0">PID:</span>
                <span className="text-accent-green">{agent.pid}</span>
              </div>
            )}
            <div className="flex items-center">
              <span className="text-gray-600 w-16 shrink-0">INIT:</span>
              <span>{formatDate(agent.createdAt)}</span>
            </div>
            <div className="flex items-center">
              <span className="text-gray-600 w-16 shrink-0">LAST_OP:</span>
              <span>{formatDate(agent.lastOutputAt)}</span>
            </div>
            {agent.resumeSessionId && (
              <div className="flex items-center pt-1 border-t border-gray-800 mt-1">
                <span className="text-accent-purple w-16 shrink-0">RESUME:</span>
                <span className="truncate text-accent-purple">{agent.resumeSessionId}</span>
                <CopyButton text={agent.resumeSessionId} />
              </div>
            )}
          </div>
        )}

        {showMeta && contextStats[agent.id] && (() => {
          const cs = contextStats[agent.id];
          const pct = cs.contextPercentage;
          const pctColor = pct > 85 ? 'text-accent-red' : pct > 60 ? 'text-accent-orange' : 'text-accent-blue';
          const barColor = pct > 85 ? 'bg-accent-red' : pct > 60 ? 'bg-accent-orange' : 'bg-accent-blue';
          const barGlow = pct > 85 ? 'shadow-[0_0_6px_rgba(239,68,68,0.6)]' : '';
          const fmt = (n: number) => {
            if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
            if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
            return String(n);
          };
          return (
            <div className="mt-2 space-y-1 text-[10px] text-gray-400 bg-black/40 border border-gray-800 p-2 font-mono">
              <div className="flex items-center justify-between border-b border-gray-800 pb-1 mb-1">
                <span className="text-accent-blue">CONTEXT_WINDOW</span>
                <span className={`px-1 text-[9px] font-bold ${pctColor} border ${pct > 85 ? 'border-accent-red/50' : pct > 60 ? 'border-accent-orange/50' : 'border-accent-blue/50'}`}>
                  {pct}%
                </span>
              </div>
              <div className="w-full h-[2px] bg-gray-800 rounded-full overflow-hidden mb-1">
                <div className={`h-full ${barColor} ${barGlow} transition-all duration-500`} style={{ width: `${pct}%` }} />
              </div>
              <div className="flex items-center">
                <span className="text-gray-600 w-16 shrink-0">MODEL:</span>
                <span className="text-gray-300">{cs.model}</span>
              </div>
              <div className="flex items-center">
                <span className="text-gray-600 w-16 shrink-0">INPUT:</span>
                <span className="text-gray-300">{fmt(cs.inputTokens)}</span>
              </div>
              <div className="flex items-center">
                <span className="text-gray-600 w-16 shrink-0">CACHE+:</span>
                <span className="text-gray-300">{fmt(cs.cacheCreationTokens)}</span>
              </div>
              <div className="flex items-center">
                <span className="text-gray-600 w-16 shrink-0">CACHE~:</span>
                <span className="text-gray-300">{fmt(cs.cacheReadTokens)}</span>
              </div>
              <div className="flex items-center">
                <span className="text-gray-600 w-16 shrink-0">OUT_T:</span>
                <span className="text-gray-300">{fmt(cs.totalOutputTokens)}</span>
              </div>
              <div className="flex items-center">
                <span className="text-gray-600 w-16 shrink-0">TURNS:</span>
                <span className="text-gray-300">{cs.turnCount}</span>
              </div>
              <div className="flex items-center">
                <span className="text-gray-600 w-16 shrink-0">WINDOW:</span>
                <span className="text-gray-300">{fmt(cs.totalContextTokens)}/{fmt(cs.contextWindowMax)}</span>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Controls */}
      <div className="p-3 border-b border-gray-800 grid grid-cols-2 gap-2 bg-surface-0/30">
        <button
          onClick={() => setTerminalAgent(isAttached ? null : agent.id)}
          className={`px-2 py-2 text-[10px] font-bold uppercase tracking-wider transition-all border ${
            isAttached
              ? 'bg-accent-green text-black border-accent-green hover:bg-white'
              : 'bg-transparent text-accent-green border-accent-green/50 hover:bg-accent-green/10'
          }`}
        >
          {isAttached ? '>> DETACH_FEED' : '>> ATTACH_FEED'}
        </button>
        <button
          onClick={() => setShowQuery(true)}
          disabled={!agent.resumeSessionId}
          className="px-2 py-2 text-[10px] font-bold uppercase tracking-wider transition-all border border-accent-purple/50 text-accent-purple hover:bg-accent-purple/10 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Query_Agent
        </button>
        <button
          onClick={() => window.api.agents.restart(agent.id)}
          className="px-2 py-2 text-[10px] font-bold uppercase tracking-wider transition-all border border-accent-yellow/50 text-accent-yellow hover:bg-accent-yellow/10"
        >
          REBOOT_SYS
        </button>
        <button
          onClick={() => window.api.agents.stop(agent.id)}
          className="px-2 py-2 text-[10px] font-bold uppercase tracking-wider transition-all border border-accent-red/50 text-accent-red hover:bg-accent-red/10 hover:shadow-[0_0_10px_rgba(255,0,85,0.4)]"
        >
          KILL_PROC
        </button>
      </div>

      {/* Tab strip */}
      <div className="flex border-b border-gray-800 bg-surface-0">
        {TABS.map((tab, index) => (
          <button
            key={tab.label}
            onClick={() => setDetailPane(index as 0 | 1 | 2)}
            className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider relative transition-all border-r border-gray-900 ${
              detailPane === index
                ? 'text-accent-blue bg-surface-2'
                : 'text-gray-600 hover:text-gray-400 hover:bg-surface-1'
            }`}
          >
            <div className="flex items-center justify-center gap-1">
                <span>{tab.label}</span>
                {tabCounts[index] !== null && tabCounts[index]! > 0 && (
                <span className={`ml-1 px-1 rounded-sm text-[9px] ${detailPane === index ? 'bg-accent-blue text-black' : 'bg-gray-700 text-gray-300'}`}>
                    {tabCounts[index]}
                </span>
                )}
            </div>

            {detailPane === index && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-blue shadow-[0_0_8px_currentColor]" />
            )}
          </button>
        ))}
      </div>

      {/* Active pane */}
      <div className="flex-1 overflow-hidden flex flex-col relative">
        <div className="absolute inset-0 bg-grid-white/[0.02] pointer-events-none" />
        {detailPane === 0 && <DetailPaneContext agentId={agent.id} pathType={pathType} />}
        {detailPane === 1 && <DetailPaneProducts agentId={agent.id} pathType={pathType} />}
        {detailPane === 2 && <DetailPaneLog agentId={agent.id} agentStatus={agent.status} />}
      </div>

      {/* Query dialog */}
      {showQuery && agent && (
        <QueryDialog sourceAgent={agent} onClose={() => setShowQuery(false)} />
      )}
    </div>
  );
}
