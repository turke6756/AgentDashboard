import React from 'react';
import { motion } from 'framer-motion';
import type { AgentStatus } from '../../../shared/types';

const STATUS_CONFIG: Record<AgentStatus, { color: string; bg: string; pulse: boolean; label: string }> = {
  launching: { color: 'text-yellow-400', bg: 'bg-yellow-400', pulse: true, label: 'Launching' },
  working: { color: 'text-green-400', bg: 'bg-green-400', pulse: true, label: 'Working' },
  idle: { color: 'text-blue-400', bg: 'bg-blue-400', pulse: false, label: 'Idle' },
  waiting: { color: 'text-orange-400', bg: 'bg-orange-400', pulse: true, label: 'Waiting' },
  done: { color: 'text-gray-500', bg: 'bg-gray-500', pulse: false, label: 'Done' },
  crashed: { color: 'text-red-400', bg: 'bg-red-400', pulse: false, label: 'Crashed' },
  restarting: { color: 'text-yellow-400', bg: 'bg-yellow-400', pulse: true, label: 'Restarting' },
};

export default function StatusBadge({ status }: { status: AgentStatus }) {
  const config = STATUS_CONFIG[status];

  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${config.color}`}>
      <span className="relative flex h-2 w-2">
        {config.pulse && (
          <motion.span
            className={`absolute inline-flex h-full w-full rounded-full ${config.bg} opacity-75`}
            animate={{ scale: [1, 1.5, 1], opacity: [0.75, 0, 0.75] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${config.bg}`} />
      </span>
      {config.label}
    </div>
  );
}
