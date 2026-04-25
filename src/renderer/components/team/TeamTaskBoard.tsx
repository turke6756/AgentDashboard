import React from 'react';
import type { TeamTask, TeamTaskStatus } from '../../../shared/types';

interface Props {
  tasks: TeamTask[];
}

const COLUMNS: { status: TeamTaskStatus; label: string; headerColor: string }[] = [
  { status: 'todo',        label: 'Todo',        headerColor: 'text-gray-400' },
  { status: 'in_progress', label: 'In Progress', headerColor: 'text-blue-400' },
  { status: 'done',        label: 'Done',        headerColor: 'text-green-400' },
  { status: 'blocked',     label: 'Blocked',     headerColor: 'text-red-400' },
];

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '\u2026';
}

export default function TeamTaskBoard({ tasks }: Props) {
  const byStatus = (status: TeamTaskStatus) =>
    tasks.filter((t) => t.status === status);

  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
        No tasks on the board.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-4 gap-3 p-2 min-h-[200px]">
      {COLUMNS.map((col) => {
        const columnTasks = byStatus(col.status);
        return (
          <div key={col.status} className="flex flex-col">
            {/* Column header */}
            <div className={`text-xs font-semibold uppercase tracking-wide mb-2 ${col.headerColor}`}>
              {col.label}
              <span className="text-gray-600 ml-1">({columnTasks.length})</span>
            </div>

            {/* Cards */}
            <div className="space-y-2 flex-1">
              {columnTasks.map((task) => (
                <div
                  key={task.id}
                  className="bg-surface-1 border border-surface-3 px-3 py-2"
                >
                  <div className="text-sm text-white font-medium">{task.title}</div>
                  {task.description && (
                    <div className="text-xs text-gray-400 mt-1">
                      {truncate(task.description, 80)}
                    </div>
                  )}
                  {task.assignedTo && (
                    <div className="text-xs text-gray-500 mt-1.5">
                      Assigned: <span className="text-gray-400">{task.assignedTo.slice(0, 8)}</span>
                    </div>
                  )}
                  {task.notes && (
                    <div className="text-xs text-gray-500 mt-1 italic">
                      {truncate(task.notes, 60)}
                    </div>
                  )}
                  {task.blockedBy.length > 0 && (
                    <div className="text-xs text-red-400/70 mt-1">
                      Blocked by {task.blockedBy.length} task{task.blockedBy.length > 1 ? 's' : ''}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
