import React, { useState, useRef, useCallback } from 'react';
import type { AgentStatus } from '../../../shared/types';
import { useThemeStore } from '../../stores/theme-store';

const ACCEPTING_INPUT: AgentStatus[] = ['idle', 'waiting', 'done', 'crashed'];

export default function ChatInputBar({ agentId, agentStatus }: { agentId: string; agentStatus: AgentStatus }) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const canSend = ACCEPTING_INPUT.includes(agentStatus) && input.trim().length > 0 && !sending;
  const isDisabled = !ACCEPTING_INPUT.includes(agentStatus);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !canSend) return;

    setSending(true);
    try {
      await window.api.agents.sendInput(agentId, text);
      setInput('');
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [agentId, input, canSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (types.includes('application/x-file-path') || types.includes('text/plain')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!isDragOver) setIsDragOver(true);
    }
  }, [isDragOver]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the drop zone entirely, not when crossing child boundaries
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const path =
      e.dataTransfer.getData('application/x-file-path') ||
      e.dataTransfer.getData('text/plain');
    if (!path) return;

    // Format as @path — readable in prose and visually distinct.
    const token = `@${path}`;

    const ta = inputRef.current;
    const prev = input;
    let next: string;
    if (ta && document.activeElement === ta) {
      const start = ta.selectionStart ?? prev.length;
      const end = ta.selectionEnd ?? prev.length;
      const before = prev.slice(0, start);
      const after = prev.slice(end);
      const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
      const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
      const insert = `${needsLeadingSpace ? ' ' : ''}${token}${needsTrailingSpace ? ' ' : ' '}`;
      next = before + insert + after;
      // Restore caret after the inserted token
      requestAnimationFrame(() => {
        const caret = (before + insert).length;
        ta.focus();
        ta.setSelectionRange(caret, caret);
      });
    } else {
      const sep = prev.length === 0 || /\s$/.test(prev) ? '' : ' ';
      next = `${prev}${sep}${token} `;
      requestAnimationFrame(() => {
        ta?.focus();
        const caret = next.length;
        ta?.setSelectionRange(caret, caret);
      });
    }
    setInput(next);
  }, [input]);

  const statusHint = isDragOver
    ? 'Drop to attach file path…'
    : isDisabled
      ? agentStatus === 'working' || agentStatus === 'launching'
        ? 'Agent is working…'
        : `Agent is ${agentStatus}`
      : 'Message the agent…';

  return (
    <div
      className={`border-t px-3 py-2 ${
        isLight ? 'border-[#d0d7de] bg-[#f6f8fa]' : 'border-gray-800/40 bg-surface-1/50'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={`flex items-end gap-2 border rounded-full px-3 py-1.5 transition-colors ${
          isDragOver
            ? 'border-[var(--color-accent-blue)] shadow-[0_0_0_3px_rgba(0,122,204,0.2)] bg-[var(--color-accent-blue)]/5'
            : isDisabled
              ? 'border-surface-3 opacity-60'
              : isLight
                ? 'border-[#d0d7de] bg-white focus-within:border-[var(--color-accent-blue)] focus-within:shadow-[0_0_0_3px_rgba(0,122,204,0.1)]'
                : 'border-gray-800 bg-[#0d1117] focus-within:border-[var(--color-accent-blue)] focus-within:shadow-[0_0_0_3px_rgba(0,122,204,0.15)]'
        }`}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          placeholder={statusHint}
          rows={1}
          className={`flex-1 bg-transparent text-[13px] resize-none outline-none min-h-[22px] max-h-[160px] leading-relaxed disabled:cursor-not-allowed ${
            isLight ? 'text-[#1a1a1a] placeholder-[#8b949e]' : 'text-gray-50 placeholder-gray-500'
          }`}
          style={{ fieldSizing: 'content' } as React.CSSProperties}
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          className="ui-btn ui-btn-primary text-[11px] font-semibold uppercase tracking-wider px-3 py-1 min-h-0 shrink-0 rounded-full"
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
      {isDisabled && (agentStatus === 'working' || agentStatus === 'launching') && (
        <div className="flex items-center gap-1.5 mt-1.5 px-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-accent-yellow)] animate-pulse" />
          <span
            className={`text-[10px] uppercase tracking-wider font-semibold ${
              isLight ? 'text-[#57606a]' : 'text-gray-500'
            }`}
          >
            {agentStatus === 'launching' ? 'Initializing' : 'Thinking…'}
          </span>
        </div>
      )}
    </div>
  );
}
