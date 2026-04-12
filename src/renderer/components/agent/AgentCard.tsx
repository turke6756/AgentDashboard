import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import type { Agent } from '../../../shared/types';
import StatusBadge from './StatusBadge';
import { PROVIDER_META } from '../../../shared/constants';
import { useDashboardStore } from '../../stores/dashboard-store';

/** Strip .claude/agents/supervisor suffix to show the workspace root name. */
function getDisplayDirectory(agent: Agent): string {
  const dir = agent.workingDirectory.replace(/\\/g, '/');
  const stripped = agent.isSupervisor
    ? dir.replace(/\/\.claude\/agents\/[^/]+$/, '')
    : dir;
  return stripped.split('/').filter(Boolean).pop() || stripped;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'NEVER';
  const diff = Date.now() - new Date(dateStr + 'Z').getTime();
  if (diff < 60_000) return 'NOW';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}M AGO`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}H AGO`;
  return `${Math.floor(diff / 86400_000)}D AGO`;
}

const BORDER_COLORS: Record<string, string> = {
  working: 'border-accent-green',
  idle: 'border-accent-blue',
  waiting: 'border-accent-orange',
  crashed: 'border-accent-red',
  launching: 'border-accent-yellow',
  restarting: 'border-accent-yellow',
  done: 'border-gray-700',
};

const GLOW_COLORS: Record<string, string> = {
  working: 'shadow-[0_0_15px_rgba(34,197,94,0.3)]',
  idle: 'shadow-[0_0_15px_rgba(59,130,246,0.3)]',
  waiting: 'shadow-[0_0_15px_rgba(249,115,22,0.3)]',
  crashed: 'shadow-[0_0_20px_rgba(239,68,68,0.5)]',
  launching: 'shadow-[0_0_15px_rgba(234,179,8,0.3)]',
  restarting: 'shadow-[0_0_15px_rgba(234,179,8,0.3)]',
  done: 'shadow-none',
};

export default function AgentCard({ agent, onGroupThink, onTeam }: { agent: Agent; onGroupThink?: (agentId: string) => void; onTeam?: (agentId: string) => void }) {
  const { selectAgent, selectedAgentId, terminalAgentId, setTerminalAgent, deleteAgent, forkAgent, queryAgent, contextStats, groupThinkSessions } = useDashboardStore();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [forking, setForking] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [dragQuery, setDragQuery] = useState<{ sourceId: string } | null>(null);
  const [dragQueryText, setDragQueryText] = useState('');
  const [dragQueryResult, setDragQueryResult] = useState<string | null>(null);
  const [dragQuerying, setDragQuerying] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Fetch initial context stats on mount (covers app restart / pre-existing JSONL data)
  useEffect(() => {
    window.api.agents.getContextStats(agent.id).then(stats => {
      if (stats) {
        useDashboardStore.getState().updateContextStats(stats);
      }
    });
  }, [agent.id]);

  const isSelected = selectedAgentId === agent.id;
  const isTerminalActive = terminalAgentId === agent.id;
  
  const borderColor = BORDER_COLORS[agent.status] || 'border-gray-700';
  
  // Backlit effect for active terminal agent
  const backlitClass = isTerminalActive
    ? 'shadow-[0_0_50px_rgba(0,68,170,0.25),_inset_0_0_20px_rgba(0,68,170,0.08)] dark:shadow-[0_0_50px_rgba(255,255,255,0.3),_inset_0_0_20px_rgba(255,255,255,0.1)] bg-accent-blue/[0.06] dark:bg-white/[0.08] border-accent-blue/40 dark:border-white/40 z-10 scale-[1.02] ring-1 ring-accent-blue/20 dark:ring-white/20'
    : '';

  // Standard glow for selected agent (status-colored) - only if not backlit
  const glowClass = (isSelected && !isTerminalActive) ? GLOW_COLORS[agent.status] : '';

  // Close context menu on click away
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu]);

  // Close drag query popover on click away or Escape
  useEffect(() => {
    if (!dragQuery) return;
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        closeDragQuery();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDragQuery();
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [dragQuery]);

  const closeDragQuery = () => {
    setDragQuery(null);
    setDragQueryText('');
    setDragQueryResult(null);
    setDragQuerying(false);
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await deleteAgent(agent.id);
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const [forkError, setForkError] = useState<string | null>(null);

  const handleFork = async () => {
    setContextMenu(null);
    setForking(true);
    setForkError(null);
    const result = await forkAgent(agent.id);
    setForking(false);
    if (!result) {
      setForkError('Fork failed — check console for details');
      setTimeout(() => setForkError(null), 5000);
    }
  };

  const handleToggleSupervised = async () => {
    setContextMenu(null);
    try {
      await window.api.agents.updateSupervised(agent.id, !agent.isSupervised);
      const { loadAgents } = useDashboardStore.getState();
      await loadAgents(agent.workspaceId);
    } catch (err) {
      console.error('Failed to toggle supervised:', err);
    }
  };

  // Attach native drag events via ref to avoid framer-motion conflicts
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;

    if (agent.resumeSessionId) {
      el.setAttribute('draggable', 'true');
    } else {
      el.removeAttribute('draggable');
    }

    const onDragStart = (e: DragEvent) => {
      // Don't start drag from interactive elements (buttons, inputs)
      const target = e.target as HTMLElement;
      if (target.closest('button, textarea, input, a')) {
        e.preventDefault();
        return;
      }
      e.dataTransfer?.setData('text/agentId', agent.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    };

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('text/agentid')) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }
    };

    const onDragLeave = () => setDragOver(false);

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const sourceId = e.dataTransfer?.getData('text/agentId');
      if (sourceId && sourceId !== agent.id && agent.resumeSessionId && (agent.provider || 'claude') === 'claude') {
        setDragQuery({ sourceId });
      }
    };

    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);

    return () => {
      el.removeEventListener('dragstart', onDragStart);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('drop', onDrop);
    };
  }, [agent.id, agent.resumeSessionId]);

  const handleDragQuerySubmit = async () => {
    if (!dragQueryText.trim() || !dragQuery) return;
    setDragQuerying(true);
    const result = await queryAgent(agent.id, dragQueryText.trim(), dragQuery.sourceId);
    setDragQuerying(false);
    setDragQueryResult(result?.result || 'No response');
  };

  return (
    <motion.div
      ref={cardRef}
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`ui-card relative rounded-xl p-4 cursor-pointer transition-all duration-200 group interactive
        border-l-4 ${isSelected ? borderColor : 'border-l-gray-700 border-t-transparent border-r-transparent border-b-transparent'}
        ${isSelected ? 'bg-surface-2 ring-1 ring-black/5 dark:ring-white/5 shadow-lg' : 'hover:bg-surface-2/80'}
        ${agent.status === 'working' ? 'bg-accent-green/5' : ''}
        ${glowClass}
        ${backlitClass}
        ${dragOver ? 'ring-2 ring-accent-purple shadow-[0_0_20px_rgba(168,85,247,0.4)]' : ''}
      `}
      onClick={() => selectAgent(agent.id)}
      onDoubleClick={() => setTerminalAgent(agent.id)}
      onContextMenu={handleContextMenu}
    >
      {/* Decorative corners */}
      <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-gray-600 group-hover:border-accent-blue transition-colors" />
      <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-gray-600 group-hover:border-accent-blue transition-colors" />

      {/* Header */}
      <div className="flex items-start justify-between mb-3 relative z-10">
        <div className="flex-1 min-w-0 pr-2">
           <div className="flex items-center gap-2 mb-1">
             <span className="text-[13px] text-gray-400 font-sans font-bold">#{agent.id.substring(0,6)}</span>
             {(() => {
               const meta = PROVIDER_META[agent.provider || 'claude'];
               return (
                 <span className={`text-[13px] font-sans font-bold px-1.5 py-0.5 rounded ${meta.bgClass} ${meta.textClass}`}>
                   {meta.label}
                 </span>
               );
             })()}
             {agent.isAttached && (
                <span className="text-[13px] text-accent-green font-sans animate-pulse font-bold">● Live</span>
             )}
             {agent.isSupervised && (
                <span className="text-[11px] text-purple-400 bg-purple-500/15 px-1.5 py-0.5 rounded-full font-sans font-bold">Supervised</span>
             )}
             {(() => {
               const gtSession = groupThinkSessions.find(
                 (s) => s.status === 'active' && s.memberAgentIds.includes(agent.id)
               );
               if (!gtSession) return null;
               return (
                 <span
                   className="text-[11px] text-fuchsia-400 bg-fuchsia-500/15 px-1.5 py-0.5 rounded-full font-sans font-bold"
                   title={`Group Think R${gtSession.roundCount}/${gtSession.maxRounds}: ${gtSession.topic}`}
                 >
                   GT R{gtSession.roundCount}/{gtSession.maxRounds}
                 </span>
               );
             })()}
           </div>
           <h4 className={`font-sans font-bold text-sm truncate   ${isSelected ? 'text-accent-blue glow-text' : 'text-gray-100 group-hover:text-gray-50'}`}>
             {agent.title}
           </h4>
        </div>
        
        <div className="flex items-center gap-2">
           {forking && <span className="text-[13px] text-accent-purple animate-pulse font-bold">FORKING...</span>}
           {forkError && <span className="text-[13px] text-accent-red font-bold">{forkError}</span>}
           <StatusBadge status={agent.status} />
           
           {!confirmDelete && (
            <button
              onClick={handleDelete}
              className="ui-btn ui-btn-danger opacity-0 group-hover:opacity-100 min-h-0 px-2 py-1 text-gray-400 hover:text-accent-red"
              title="Terminate Agent"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
                <path d="M1 1L9 9M9 1L1 9" strokeWidth="2" />
              </svg>
            </button>
           )}
        </div>
      </div>

      {confirmDelete && (
        <div className="absolute inset-0 bg-surface-1/95 backdrop-blur-md z-20 flex items-center justify-center flex-col p-4 border-2 border-accent-red shadow-2xl">
          <span className="text-accent-red font-bold text-sm  mb-3 animate-pulse">Stop this agent?</span>
          <div className="flex gap-4">
            <button
              onClick={handleDelete}
              className="ui-btn ui-btn-danger px-6 py-2 text-[13px] font-bold"
            >
              Confirm
            </button>
            <button
              onClick={handleCancelDelete}
              className="ui-btn ui-btn-ghost px-6 py-2 text-[13px] font-bold"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Role / Output Preview */}
      <div className="mb-3 h-16 relative overflow-hidden log-surface border border-gray-800/20 p-2 font-sans text-[13px] shadow-inner">
        {/* Fake scanline for the log window */}
        <div className="absolute inset-0 bg-gradient-to-b from-white/5 to-transparent opacity-10 pointer-events-none" />
        
        {agent.roleDescription ? (
           <p className="line-clamp-3 leading-tight font-medium">{'>'} {agent.roleDescription}</p>
        ) : (
           <p className="opacity-40 italic">No role assigned</p>
        )}
      </div>

      {/* Context Stats Bar (Claude only — other providers don't emit JSONL stats) */}
      {(agent.provider || 'claude') === 'claude' && contextStats[agent.id] && (() => {
        const cs = contextStats[agent.id];
        const pct = cs.contextPercentage;
        const isWarning = pct > 60;
        const isCritical = pct > 85;
        const barColor = isCritical ? 'bg-accent-red' : isWarning ? 'bg-accent-orange' : 'bg-accent-blue';
        const textColor = isCritical ? 'text-accent-red' : isWarning ? 'text-accent-orange' : 'text-accent-blue';
        const barGlow = isCritical ? 'shadow-[0_0_8px_rgba(239,68,68,0.6)]' : isWarning ? 'shadow-[0_0_4px_rgba(249,115,22,0.3)]' : '';
        return (
          <div className="mb-2">
            <div className="flex items-center justify-between text-[13px] font-sans text-gray-300  mb-1">
              <span className={`${textColor} ${isCritical ? 'animate-pulse font-bold' : 'font-medium'}`}>
                {isCritical ? '!! ' : ''}Ctx {formatTokenCount(cs.totalContextTokens)}/{formatTokenCount(cs.contextWindowMax)}
              </span>
              <span>Turns: {cs.turnCount} Out: {formatTokenCount(cs.totalOutputTokens)}</span>
            </div>
            <div className="relative w-full h-[6px] bg-gray-800/80 overflow-hidden border border-gray-700/50">
              {/* Quarter markers */}
              <div className="absolute top-0 bottom-0 left-1/4 w-px bg-gray-600/30 z-10" />
              <div className="absolute top-0 bottom-0 left-1/2 w-px bg-gray-600/40 z-10" />
              <div className="absolute top-0 bottom-0 left-3/4 w-px bg-gray-600/30 z-10" />
              {/* Fill bar */}
              <div
                className={`h-full ${barColor} ${barGlow} transition-all duration-700 ease-out`}
                style={{ width: `${pct}%` }}
              />
              {/* Scanline overlay */}
              <div className="absolute inset-0 bg-gradient-to-b from-white/10 to-transparent pointer-events-none" />
            </div>
            {/* Model tag */}
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-[13px] font-sans text-gray-400  truncate">{cs.model.replace('claude-', '').replace(/-\d{8}$/, '')}</span>
              <span className={`text-[13px] font-sans ${textColor} font-bold`}>{pct}%</span>
            </div>
          </div>
        );
      })()}

      {/* Footer Meta */}
      <div className="flex items-center justify-between text-[13px] font-sans text-gray-300  ">
        <div className="flex items-center gap-2">
            <span className="truncate max-w-[100px] border- dark:border-white/10 light:border-black/10 pb-0.5" title={agent.workingDirectory}>
            ...{getDisplayDirectory(agent)}
            </span>
            {agent.restartCount > 0 && (
                <span className="text-accent-orange">Restarts: {agent.restartCount}</span>
            )}
        </div>
        <span className={isSelected ? 'text-accent-blue' : ''}>
            Active: {timeAgo(agent.lastOutputAt || agent.createdAt)}
        </span>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="panel-shell fixed z-50 min-w-[180px] rounded-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="panel-header px-3 py-2 text-[13px] text-accent-blue font-sans rounded-t-xl">
             Agent Actions
          </div>
          <button
            onClick={handleFork}
            disabled={!agent.resumeSessionId || (agent.provider || 'claude') !== 'claude'}
            className="w-full text-left px-3 py-2 text-[13px] font-sans hover:bg-accent-blue/20 hover:text-accent-blue transition-colors disabled:opacity-30 disabled:cursor-not-allowed "
          >
            Fork Agent {(agent.provider || 'claude') !== 'claude' ? '(Claude only)' : !agent.resumeSessionId ? '(no session)' : ''}
          </button>
          <button
            onClick={handleToggleSupervised}
            className="w-full text-left px-3 py-2 text-[13px] font-sans hover:bg-purple-500/20 hover:text-purple-400 transition-colors"
          >
            {agent.isSupervised ? 'Disable Supervision' : 'Enable Supervision'}
          </button>
          {onGroupThink && !agent.isSupervisor && !['done', 'crashed'].includes(agent.status) && (
            <button
              onClick={() => { setContextMenu(null); onGroupThink(agent.id); }}
              className="w-full text-left px-3 py-2 text-[13px] font-sans hover:bg-fuchsia-500/20 hover:text-fuchsia-400 transition-colors"
            >
              Start Group Think
            </button>
          )}
          {onTeam && !agent.isSupervisor && !['done', 'crashed'].includes(agent.status) && (
            <button
              onClick={() => { setContextMenu(null); onTeam(agent.id); }}
              className="w-full text-left px-3 py-2 text-[13px] font-sans hover:bg-cyan-500/20 hover:text-cyan-400 transition-colors"
            >
              Create Team
            </button>
          )}
        </div>
      )}

      {/* Drag-to-query popover */}
      {dragQuery && (
        <div
          ref={popoverRef}
          className="panel-shell absolute inset-0 z-30 border-accent-purple p-3 flex flex-col rounded-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-[13px] text-accent-purple mb-2 font-sans   animate-pulse">Inter-Agent Query</div>
          <textarea
            value={dragQueryText}
            onChange={(e) => setDragQueryText(e.target.value)}
            placeholder="Ask this agent a question..."
            className="ui-textarea w-full resize-none flex-1 text-[13px] text-accent-purple font-sans rounded-lg"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleDragQuerySubmit();
              }
            }}
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleDragQuerySubmit}
              disabled={dragQuerying || !dragQueryText.trim()}
              className="ui-btn ui-btn-purple flex-1 py-1 text-[13px] font-bold"
            >
              {dragQuerying ? 'Sending...' : 'Send'}
            </button>
            <button
              onClick={closeDragQuery}
              className="ui-btn ui-btn-ghost px-2 py-1 text-[13px]"
            >
              Cancel
            </button>
          </div>
          {dragQueryResult && (
            <div className="mt-2 p-2 bg-surface-0 border-t border-accent-purple/30 text-[13px] text-accent-purple max-h-24 overflow-y-auto font-sans whitespace-pre-wrap">
              {dragQueryResult}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}
