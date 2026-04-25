import React from 'react';
import { useThemeStore } from '../../../../stores/theme-store';
import { ToolBlockProps } from './GenericToolBlock';

type TodoStatus = 'pending' | 'in_progress' | 'completed';

interface TodoItem {
  content?: string;
  status?: TodoStatus;
  activeForm?: string;
}

interface TodoInput {
  todos?: TodoItem[];
}

export default function TodoWriteToolBlock({ input }: ToolBlockProps) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const rec = (input ?? {}) as TodoInput;
  const todos = Array.isArray(rec.todos) ? rec.todos : [];

  const total = todos.length;
  const completed = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;

  return (
    <div className="my-1 ml-1">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-px rounded-sm select-text ${
            isLight
              ? 'bg-[#daa520]/15 text-[#6e5600] border border-[#daa520]/30'
              : 'bg-amber-400/10 text-amber-300/90 border border-amber-400/20'
          }`}
        >
          TodoWrite
        </span>
        <span className={`text-[10px] select-none ${isLight ? 'text-[#57606a]' : 'text-gray-500'}`}>
          {total} {total === 1 ? 'task' : 'tasks'} · {completed}/{total} done
          {inProgress > 0 && ` · ${inProgress} in progress`}
        </span>
      </div>
      <div className={`ml-5 pl-2 border-l ${isLight ? 'border-[#d0d7de]' : 'border-gray-800'}`}>
        {todos.length === 0 ? (
          <div className={`text-[11px] italic py-0.5 ${isLight ? 'text-[#57606a]' : 'text-gray-500'}`}>
            (empty list)
          </div>
        ) : (
          todos.map((t, i) => {
            const status: TodoStatus = t.status ?? 'pending';
            const label = status === 'in_progress' ? t.activeForm || t.content || '' : t.content || '';
            const icon = status === 'completed' ? '✓' : status === 'in_progress' ? '▶' : '☐';
            const iconColor =
              status === 'completed'
                ? isLight
                  ? 'text-emerald-700'
                  : 'text-emerald-300/90'
                : status === 'in_progress'
                ? isLight
                  ? 'text-[#6e5600]'
                  : 'text-amber-300/90'
                : isLight
                ? 'text-[#57606a]'
                : 'text-gray-500';
            const rowBg =
              status === 'in_progress'
                ? isLight
                  ? 'bg-[#daa520]/10 border border-[#daa520]/30'
                  : 'bg-amber-400/10 border border-amber-400/20'
                : 'border border-transparent';
            const textClass =
              status === 'completed'
                ? `line-through ${isLight ? 'text-[#8b949e]' : 'text-gray-500'}`
                : status === 'in_progress'
                ? isLight
                  ? 'text-[#24292f] font-medium'
                  : 'text-gray-100 font-medium'
                : isLight
                ? 'text-[#24292f]'
                : 'text-gray-300';
            return (
              <div
                key={i}
                className={`flex items-start gap-2 px-1.5 py-0.5 my-0.5 rounded text-[12px] select-text ${rowBg}`}
              >
                <span className={`shrink-0 font-mono select-none ${iconColor}`}>{icon}</span>
                <span className={`flex-1 ${textClass}`}>{label}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
