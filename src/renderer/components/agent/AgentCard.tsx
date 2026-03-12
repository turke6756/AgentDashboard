import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import type { Agent } from '../../../shared/types';
import StatusBadge from './StatusBadge';
import { useDashboardStore } from '../../stores/dashboard-store';

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'never';
  const diff = Date.now() - new Date(dateStr + 'Z').getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

const BORDER_COLORS: Record<string, string> = {
  working: 'border-green-500/30',
  idle: 'border-blue-500/20',
  waiting: 'border-orange-500/40',
  crashed: 'border-red-500/40',
  launching: 'border-yellow-500/30',
  restarting: 'border-yellow-500/30',
  done: 'border-gray-700',
};

export default function AgentCard({ agent }: { agent: Agent }) {
  const { selectAgent, selectedAgentId, setTerminalAgent, deleteAgent, forkAgent, queryAgent } = useDashboardStore();
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
  const borderColor = BORDER_COLORS[agent.status] || 'border-gray-700';

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

  const handleFork = async () => {
    setContextMenu(null);
    setForking(true);
    await forkAgent(agent.id);
    setForking(false);
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
    const result = await queryAgent(agent.id, dragQueryText.trim());
    setDragQuerying(false);
    setDragQueryResult(result?.result || 'No response');
  };

  return (
    <motion.div
      ref={cardRef}
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`bg-surface-2 border rounded-lg p-4 cursor-pointer transition-all hover:bg-surface-3 relative group ${borderColor} ${
        isSelected ? 'ring-1 ring-accent-blue' : ''
      } ${dragOver ? 'ring-2 ring-purple-500/60' : ''}`}
      onClick={() => selectAgent(agent.id)}
      onDoubleClick={() => setTerminalAgent(agent.id)}
      onContextMenu={handleContextMenu}
    >
      <div className="flex items-start justify-between mb-2">
        <h4 className="font-semibold text-sm truncate flex-1">{agent.title}</h4>
        <div className="flex items-center gap-1.5">
          <StatusBadge status={agent.status} />
          {forking && <span className="text-[10px] text-purple-400">forking...</span>}
          {!confirmDelete && (
            <button
              onClick={handleDelete}
              className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 text-xs leading-none transition-opacity"
              title="Delete agent"
            >
              X
            </button>
          )}
        </div>
      </div>

      {confirmDelete && (
        <div className="flex items-center gap-2 mb-2 text-xs">
          <span className="text-red-400">Delete?</span>
          <button
            onClick={handleDelete}
            className="text-red-400 hover:text-red-300 font-medium"
          >
            Yes
          </button>
          <button
            onClick={handleCancelDelete}
            className="text-gray-500 hover:text-gray-300"
          >
            No
          </button>
        </div>
      )}

      {agent.roleDescription && (
        <p className="text-xs text-gray-500 mb-2 line-clamp-2">{agent.roleDescription}</p>
      )}

      <div className="flex items-center justify-between text-[11px] text-gray-600">
        <span className="font-mono truncate max-w-[60%]">
          {agent.workingDirectory.split(/[/\\]/).slice(-2).join('/')}
        </span>
        <span>{timeAgo(agent.lastOutputAt || agent.createdAt)}</span>
      </div>

      {agent.restartCount > 0 && (
        <div className="mt-1.5 text-[10px] text-orange-400/70">
          Restarted {agent.restartCount}x
        </div>
      )}

      {agent.isAttached && (
        <div className="mt-1.5 text-[10px] text-green-400 font-medium">
          ATTACHED
        </div>
      )}

      <div className="mt-1.5 text-[10px] text-gray-700 font-mono truncate">
        {agent.id}
      </div>

      {agent.resumeSessionId && (
        <div className="mt-0.5 text-[10px] text-purple-500/50 font-mono truncate" title={agent.resumeSessionId}>
          session: {agent.resumeSessionId.substring(0, 8)}...
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-surface-3 border border-gray-700 rounded-md shadow-xl py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={handleFork}
            disabled={!agent.resumeSessionId}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Fork Agent{!agent.resumeSessionId && ' (no session)'}
          </button>
        </div>
      )}

      {/* Drag-to-query popover */}
      {dragQuery && (
        <div
          ref={popoverRef}
          className="absolute top-0 left-0 right-0 z-40 bg-surface-3 border border-purple-500/40 rounded-lg p-3 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-[11px] text-purple-400 mb-2 font-medium">Query this agent</div>
          <textarea
            value={dragQueryText}
            onChange={(e) => setDragQueryText(e.target.value)}
            placeholder="Ask a question..."
            className="w-full bg-surface-0 border border-gray-700 rounded text-xs p-2 resize-none h-16 focus:outline-none focus:border-purple-500/60"
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
              className="px-2 py-1 text-[11px] bg-purple-600 hover:bg-purple-500 rounded text-white disabled:opacity-40"
            >
              {dragQuerying ? 'Asking...' : 'Ask'}
            </button>
            <button
              onClick={closeDragQuery}
              className="px-2 py-1 text-[11px] text-gray-500 hover:text-gray-300"
            >
              Cancel
            </button>
          </div>
          {dragQueryResult && (
            <div className="mt-2 p-2 bg-surface-0 rounded text-xs text-gray-300 max-h-32 overflow-y-auto whitespace-pre-wrap">
              {dragQueryResult}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}
