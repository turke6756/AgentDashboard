import React, { useState } from 'react';
import type { TeamMessage, TeamMessageStatus } from '../../../shared/types';

interface Props {
  messages: TeamMessage[];
}

const STATUS_STYLES: Record<TeamMessageStatus, { bg: string; text: string; label: string }> = {
  request:  { bg: 'bg-blue-500/20',   text: 'text-blue-400',   label: 'Request' },
  question: { bg: 'bg-yellow-500/20',  text: 'text-yellow-400', label: 'Question' },
  complete: { bg: 'bg-green-500/20',   text: 'text-green-400',  label: 'Complete' },
  blocked:  { bg: 'bg-red-500/20',     text: 'text-red-400',    label: 'Blocked' },
  update:   { bg: 'bg-gray-500/20',    text: 'text-gray-400',   label: 'Update' },
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

export default function TeamMessageFlow({ messages }: Props) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
        No messages yet.
      </div>
    );
  }

  // Show newest first
  const sorted = [...messages].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return (
    <div className="space-y-2 p-2 max-h-[60vh] overflow-y-auto">
      {sorted.map((msg) => {
        const style = STATUS_STYLES[msg.status] ?? STATUS_STYLES.update;
        const expanded = expandedId === msg.id;
        const fromLabel = msg.fromTitle ?? msg.fromAgent.slice(0, 8);
        const toLabel = msg.toTitle ?? msg.toAgent.slice(0, 8);

        return (
          <div
            key={msg.id}
            className="bg-surface-1 border border-gray-700 rounded-lg px-3 py-2 cursor-pointer hover:border-gray-600 transition-colors"
            onClick={() => setExpandedId(expanded ? null : msg.id)}
          >
            {/* Header row */}
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500 text-xs font-mono shrink-0">
                {formatTime(msg.createdAt)}
              </span>
              <span className="text-white font-medium truncate">{fromLabel}</span>
              <span className="text-gray-500">{'\u2192'}</span>
              <span className="text-white font-medium truncate">{toLabel}</span>
              <span className={`ml-auto text-xs px-1.5 py-0.5 rounded ${style.bg} ${style.text}`}>
                {style.label}
              </span>
            </div>

            {/* Subject + Summary */}
            <div className="mt-1">
              <span className="text-sm text-gray-300">{msg.subject}</span>
              {!expanded && msg.summary && (
                <span className="text-sm text-gray-500 ml-2">{'\u2014'} {msg.summary}</span>
              )}
            </div>

            {/* Expanded detail */}
            {expanded && (
              <div className="mt-2 space-y-2 text-sm">
                {msg.summary && (
                  <div>
                    <div className="text-gray-500 text-xs uppercase tracking-wide mb-0.5">Summary</div>
                    <div className="text-gray-300">{msg.summary}</div>
                  </div>
                )}
                {msg.detail && (
                  <div>
                    <div className="text-gray-500 text-xs uppercase tracking-wide mb-0.5">Detail</div>
                    <div className="text-gray-300 whitespace-pre-wrap">{msg.detail}</div>
                  </div>
                )}
                {msg.need && (
                  <div>
                    <div className="text-gray-500 text-xs uppercase tracking-wide mb-0.5">Need</div>
                    <div className="text-gray-300">{msg.need}</div>
                  </div>
                )}
                {msg.deliveredAt && (
                  <div className="text-xs text-gray-500">
                    Delivered at {formatTime(msg.deliveredAt)}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
