import React from 'react';
import type { SessionEvent, UsageEvent } from '../../../../shared/session-events';
import { useThemeStore } from '../../../stores/theme-store';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function findLatestUsage(events: SessionEvent[]): UsageEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'usage') return e;
  }
  return null;
}

export default function ContextUsageBar({ events }: { agentId: string; events: SessionEvent[] }) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const usage = findLatestUsage(events);

  if (!usage) {
    return (
      <div
        className={`text-[10px] px-3 py-1 border-t ${
          isLight ? 'border-[#d0d7de] text-[#8b949e] bg-[#f6f8fa]' : 'border-gray-800 text-gray-500 bg-[#0d1117]'
        }`}
      >
        Waiting for model response…
      </div>
    );
  }

  const pct = usage.contextPercentage;
  const highUsage = pct >= 80;

  return (
    <div
      className={`text-[10px] px-3 py-1 border-t flex items-center gap-3 ${
        isLight ? 'border-[#d0d7de] bg-[#f6f8fa]' : 'border-gray-800 bg-[#0d1117]'
      }`}
    >
      <span className={isLight ? 'text-[#57606a]' : 'text-gray-400'}>
        <span className="font-semibold">{usage.model}</span>
      </span>
      <span className={isLight ? 'text-[#57606a]' : 'text-gray-400'}>
        {formatTokens(usage.cumulativeContextTokens)} / {formatTokens(usage.contextWindowMax)}
      </span>
      <span
        className={
          highUsage
            ? (isLight ? 'text-red-700 font-semibold' : 'text-red-400 font-semibold')
            : (isLight ? 'text-[#57606a]' : 'text-gray-400')
        }
      >
        {pct}%
      </span>
      <span className={`flex-1 h-1 rounded-full overflow-hidden ${isLight ? 'bg-[#e7e9ec]' : 'bg-gray-800'}`}>
        <span
          className="block h-full transition-[width] duration-200"
          style={{
            width: `${Math.max(2, pct)}%`,
            background: highUsage ? '#dc2626' : (isLight ? '#0969da' : '#1f6feb'),
          }}
        />
      </span>
      <span className={isLight ? 'text-[#8b949e]' : 'text-gray-500'}>
        +{formatTokens(usage.outputTokens)} out · cache {formatTokens(usage.cacheReadTokens)}r/{formatTokens(usage.cacheCreationTokens)}w
      </span>
    </div>
  );
}
