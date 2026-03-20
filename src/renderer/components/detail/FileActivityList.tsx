import React, { useRef, useState } from 'react';
import type { FileActivity, PathType } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import FileContextMenu from '../shared/FileContextMenu';
import { fileDragStart } from '../../utils/drag-file';

interface Props {
  activities: FileActivity[];
  pathType?: PathType;
  agentId?: string;
}

function timeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp + 'Z').getTime();
  const diffMs = now - then;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function fileName(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

function dirPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return '';
  return normalized.substring(0, lastSlash);
}

function operationBadge(op: string): { label: string; className: string } {
  switch (op) {
    case 'read':
      return { label: 'read', className: 'bg-blue-500/20 text-blue-400' };
    case 'create':
      return { label: 'created', className: 'bg-green-500/20 text-green-400' };
    case 'write':
      return { label: 'modified', className: 'bg-yellow-500/20 text-yellow-400' };
    default:
      return { label: op, className: 'bg-gray-500/20 text-gray-400' };
  }
}

// Group activities by file, keeping the most recent per file
function groupByFile(activities: FileActivity[]): FileActivity[] {
  const seen = new Map<string, FileActivity>();
  for (const a of activities) {
    const key = `${a.filePath}:${a.operation}`;
    if (!seen.has(key)) {
      seen.set(key, a);
    }
  }
  return Array.from(seen.values());
}

export default function FileActivityList({ activities, pathType, agentId }: Props) {
  const { openFileViewer, agents, workspaces } = useDashboardStore();
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; filePath: string } | null>(null);
  const grouped = groupByFile(activities);

  // Resolve workspace context for this agent
  const agent = agentId ? agents.find((a) => a.id === agentId) : null;
  const workspace = agent ? workspaces.find((w) => w.id === agent.workspaceId) : null;
  const workingDirectory = agent?.workingDirectory || '';
  const resolvedPathType = workspace?.pathType || pathType || 'wsl';

  if (grouped.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-gray-600 text-sm">
        No file activity yet...
      </div>
    );
  }

  const openInWorkspaceVSCode = (filePath: string) => {
    if (workingDirectory) {
      window.api.system.openFileInWorkspace(filePath, workingDirectory, resolvedPathType);
    } else {
      window.api.system.openFile(filePath, resolvedPathType);
    }
  };

  const handleClick = (filePath: string) => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      return; // double-click already fired
    }
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      if (agentId) {
        openFileViewer(filePath, agentId);
      } else {
        window.api.system.openFile(filePath, resolvedPathType);
      }
    }, 250);
  };

  const handleDoubleClick = (filePath: string) => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    openInWorkspaceVSCode(filePath);
  };

  const handleContextMenu = (e: React.MouseEvent, filePath: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, filePath });
  };

  const handleRevealInTree = () => {
    if (agentId && contextMenu) {
      openFileViewer(contextMenu.filePath, agentId);
    }
  };

  const handleVSCode = (e: React.MouseEvent, filePath: string) => {
    e.stopPropagation();
    openInWorkspaceVSCode(filePath);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      {grouped.map((activity) => {
        const badge = operationBadge(activity.operation);
        return (
          <button
            key={`${activity.filePath}-${activity.operation}-${activity.id}`}
            onClick={() => handleClick(activity.filePath)}
            onDoubleClick={() => handleDoubleClick(activity.filePath)}
            onContextMenu={(e) => handleContextMenu(e, activity.filePath)}
            draggable
            onDragStart={(e) => fileDragStart(e, activity.filePath)}
            className="w-full text-left px-4 py-2 hover:bg-surface-2 transition-colors flex items-start gap-2 group"
          >
            <span className="text-gray-500 text-sm mt-0.5 shrink-0">
              {activity.operation === 'read' ? '📖' : activity.operation === 'create' ? '📝' : '✏️'}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-200 truncate group-hover:text-white">
                  {fileName(activity.filePath)}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${badge.className}`}>
                  {badge.label}
                </span>
              </div>
              <div className="text-[11px] text-gray-600 truncate">{dirPath(activity.filePath)}</div>
            </div>
            <span
              onClick={(e) => handleVSCode(e, activity.filePath)}
              className="text-[10px] font-mono font-bold text-accent-blue/40 hover:text-accent-blue opacity-0 group-hover:opacity-100 transition-all shrink-0 mt-0.5 px-1 border border-transparent hover:border-accent-blue/30 cursor-pointer"
              title="Open in VS Code"
            >
              VS
            </span>
            <span className="text-[10px] text-gray-600 shrink-0 mt-1">
              {timeAgo(activity.timestamp)}
            </span>
          </button>
        );
      })}

      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          filePath={contextMenu.filePath}
          workingDirectory={workingDirectory}
          pathType={resolvedPathType}
          showRevealInTree={!!agentId}
          onClose={() => setContextMenu(null)}
          onRevealInTree={handleRevealInTree}
        />
      )}
    </div>
  );
}
