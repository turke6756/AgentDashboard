import React from 'react';
import { motion } from 'framer-motion';
import type { AgentStatus } from '../../../shared/types';

const STATUS_CONFIG: Record<AgentStatus, { color: string; bg: string; pulse: boolean; label: string }> = {
  launching: { color: 'text-accent-yellow', bg: 'bg-accent-yellow', pulse: true, label: 'Starting' },
  working: { color: 'text-accent-green', bg: 'bg-accent-green', pulse: true, label: 'Working' },
  idle: { color: 'text-accent-blue', bg: 'bg-accent-blue', pulse: false, label: 'Idle' },
  waiting: { color: 'text-accent-orange', bg: 'bg-accent-orange', pulse: true, label: 'Waiting' },
  done: { color: 'text-gray-300', bg: 'bg-gray-500', pulse: false, label: 'Done' },
  crashed: { color: 'text-accent-red', bg: 'bg-accent-red', pulse: false, label: 'Failed' },
  restarting: { color: 'text-accent-yellow', bg: 'bg-accent-yellow', pulse: true, label: 'Restarting' },
};

export default function StatusBadge({ status }: { status: AgentStatus }) {
  const config = STATUS_CONFIG[status];

  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 border border-current border-opacity-30 rounded-sm text-[13px] font-sans font-bold   ${config.color} ${config.bg.replace('bg-', 'bg-')}/10`}>
      <span className="relative flex h-1.5 w-1.5">
        {config.pulse && (
          <motion.span
            className={`absolute inline-flex h-full w-full rounded-full ${config.bg} opacity-75`}
            animate={{ scale: [1, 2.2, 1], opacity: [0.8, 0, 0.8] }}
            transition={{ duration: 1.2, repeat: Infinity }}
          />
        )}
        <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${config.bg} shadow-[0_0_5px_currentColor]`} />
      </span>
      {config.label}
    </div>
  );
}
