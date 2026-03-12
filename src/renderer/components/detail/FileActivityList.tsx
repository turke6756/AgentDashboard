import React from 'react';
import type { FileActivity, PathType } from '../../../shared/types';

interface Props {
  activities: FileActivity[];
  pathType?: PathType;
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

export default function FileActivityList({ activities, pathType }: Props) {
  const grouped = groupByFile(activities);

  if (grouped.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-gray-600 text-sm">
        No file activity yet...
      </div>
    );
  }

  const handleClick = (filePath: string) => {
    window.api.system.openFile(filePath, pathType || 'windows');
  };

  return (
    <div className="flex-1 overflow-y-auto">
      {grouped.map((activity) => {
        const badge = operationBadge(activity.operation);
        return (
          <button
            key={`${activity.filePath}-${activity.operation}-${activity.id}`}
            onClick={() => handleClick(activity.filePath)}
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
            <span className="text-[10px] text-gray-600 shrink-0 mt-1">
              {timeAgo(activity.timestamp)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
