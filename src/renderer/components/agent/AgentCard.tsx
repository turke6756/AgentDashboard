import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import type { Agent } from '../../../shared/types';
import StatusBadge from './StatusBadge';
import { useDashboardStore } from '../../stores/dashboard-store';

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

export default function AgentCard({ agent }: { agent: Agent }) {
  const { selectAgent, selectedAgentId, terminalAgentId, setTerminalAgent, deleteAgent, forkAgent, queryAgent } = useDashboardStore();
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

  const isSelected = selectedAgentId === agent.id;
  const isTerminalActive = terminalAgentId === agent.id;
  
  const borderColor = BORDER_COLORS[agent.status] || 'border-gray-700';
  
  // Backlit effect for active terminal agent (white glow from behind)
  const backlitClass = isTerminalActive 
    ? 'shadow-[0_0_50px_rgba(255,255,255,0.3),_inset_0_0_20px_rgba(255,255,255,0.1)] bg-white/[0.08] border-white/40 z-10 scale-[1.02] ring-1 ring-white/20' 
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
      if (sourceId && sourceId !== agent.id && agent.resumeSessionId) {
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
      className={`relative glass-panel rounded-sm p-4 cursor-pointer transition-all duration-300 group
        border-l-4 ${isSelected ? borderColor : 'border-l-gray-700 border-t-transparent border-r-transparent border-b-transparent'}
        ${isSelected ? 'bg-surface-2' : 'hover:bg-surface-2'}
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
             <span className="text-[9px] text-gray-500 font-mono">ID::{agent.id.substring(0,6).toUpperCase()}</span>
             {agent.isAttached && (
                <span className="text-[9px] text-accent-green font-mono animate-pulse">● LIVE_FEED</span>
             )}
           </div>
           <h4 className={`font-mono font-bold text-sm truncate uppercase tracking-wider ${isSelected ? 'text-accent-blue glow-text' : 'text-gray-300 group-hover:text-white'}`}>
             {agent.title}
           </h4>
        </div>
        
        <div className="flex items-center gap-2">
           {forking && <span className="text-[9px] text-accent-purple animate-pulse">FORKING...</span>}
           {forkError && <span className="text-[9px] text-accent-red">{forkError}</span>}
           <StatusBadge status={agent.status} />
           
           {!confirmDelete && (
            <button
              onClick={handleDelete}
              className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-accent-red transition-all transform hover:scale-110"
              title="Terminate Agent"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
                <path d="M1 1L9 9M9 1L1 9" strokeWidth="1.5" />
              </svg>
            </button>
           )}
        </div>
      </div>

      {confirmDelete && (
        <div className="absolute inset-0 bg-surface-1/90 backdrop-blur-sm z-20 flex items-center justify-center flex-col p-4 border border-accent-red">
          <span className="text-accent-red font-bold text-xs uppercase mb-2 animate-pulse">CONFIRM TERMINATION?</span>
          <div className="flex gap-4">
            <button
              onClick={handleDelete}
              className="text-accent-red hover:bg-accent-red/10 px-3 py-1 text-xs border border-accent-red"
            >
              YES
            </button>
            <button
              onClick={handleCancelDelete}
              className="text-gray-400 hover:text-white px-3 py-1 text-xs"
            >
              NO
            </button>
          </div>
        </div>
      )}

      {/* Role / Output Preview */}
      <div className="mb-3 h-16 relative overflow-hidden bg-black/40 border border-gray-800 p-2 font-mono text-[10px] text-accent-green/80">
        {/* Fake scanline for the log window */}
        <div className="absolute inset-0 bg-gradient-to-b from-white/5 to-transparent opacity-10 pointer-events-none" />
        
        {agent.roleDescription ? (
           <p className="line-clamp-3 opacity-80">{'>'} {agent.roleDescription}</p>
        ) : (
           <p className="opacity-50 italic">{'> NO ROLE ASSIGNED'}</p>
        )}
      </div>

      {/* Footer Meta */}
      <div className="flex items-center justify-between text-[9px] font-mono text-gray-500 uppercase tracking-tight">
        <div className="flex items-center gap-2">
            <span className="truncate max-w-[100px] border-b border-gray-800 pb-0.5" title={agent.workingDirectory}>
            DIR: ...{agent.workingDirectory.split(/[/\\]/).slice(-1)[0]}
            </span>
            {agent.restartCount > 0 && (
                <span className="text-accent-orange">RST:{agent.restartCount}</span>
            )}
        </div>
        <span className={isSelected ? 'text-accent-blue' : ''}>
            ACT: {timeAgo(agent.lastOutputAt || agent.createdAt)}
        </span>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-surface-2 border border-accent-blue/30 shadow-[0_0_15px_rgba(0,0,0,0.8)] min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="bg-accent-blue/10 px-2 py-1 text-[9px] text-accent-blue font-mono border-b border-accent-blue/20">
             AGENT_OPERATIONS
          </div>
          <button
            onClick={handleFork}
            disabled={!agent.resumeSessionId}
            className="w-full text-left px-3 py-2 text-xs font-mono hover:bg-accent-blue/20 hover:text-accent-blue transition-colors disabled:opacity-30 disabled:cursor-not-allowed uppercase"
          >
            Fork_Agent {!agent.resumeSessionId && '[NO_SESSION]'}
          </button>
        </div>
      )}

      {/* Drag-to-query popover */}
      {dragQuery && (
        <div
          ref={popoverRef}
          className="absolute inset-0 z-30 bg-surface-1 border border-accent-purple shadow-xl p-3 flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-[10px] text-accent-purple mb-2 font-mono uppercase tracking-wider animate-pulse">{'>> INTER-AGENT QUERY DETECTED'}</div>
          <textarea
            value={dragQueryText}
            onChange={(e) => setDragQueryText(e.target.value)}
            placeholder="Transmit data packet..."
            className="w-full bg-black border border-accent-purple/30 rounded-none text-xs p-2 resize-none flex-1 focus:outline-none focus:border-accent-purple text-accent-purple font-mono"
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
              className="flex-1 py-1 text-[10px] bg-accent-purple text-black font-bold uppercase hover:bg-white transition-colors disabled:opacity-50"
            >
              {dragQuerying ? 'SENDING...' : 'TRANSMIT'}
            </button>
            <button
              onClick={closeDragQuery}
              className="px-2 py-1 text-[10px] text-gray-500 hover:text-gray-300 border border-gray-700 uppercase"
            >
              ABORT
            </button>
          </div>
          {dragQueryResult && (
            <div className="mt-2 p-2 bg-black border-t border-accent-purple/30 text-[10px] text-accent-purple max-h-24 overflow-y-auto font-mono whitespace-pre-wrap">
              {dragQueryResult}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}
