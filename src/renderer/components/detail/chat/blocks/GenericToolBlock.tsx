import React, { useState, useCallback } from 'react';
import { useThemeStore } from '../../../../stores/theme-store';

export interface ToolBlockProps {
  toolUseId: string;
  toolName: string;
  input: unknown;
  result?: { content: string; truncated: boolean; isError?: boolean };
  agentId: string;
}

function summarizeInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);

  const rec = input as Record<string, unknown>;

  // Prefer commonly meaningful fields first
  const priorityKeys = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt'];
  for (const k of priorityKeys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }

  try {
    const json = JSON.stringify(input);
    return json;
  } catch {
    return '';
  }
}

function truncatePreview(text: string, max = 80): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > max ? singleLine.slice(0, max) + '…' : singleLine;
}

export default function GenericToolBlock({ toolUseId, toolName, input, result, agentId }: ToolBlockProps) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const [open, setOpen] = useState(false);
  const [fullResult, setFullResult] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);

  const preview = truncatePreview(summarizeInput(input));
  const running = result === undefined;

  const outputText = fullResult ?? result?.content ?? '';
  const outLines = outputText ? outputText.split('\n').filter(l => l.trim().length > 0).length : 0;

  const handleToggle = useCallback(() => {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (sel && sel.toString().length > 0) return;
    setOpen(o => !o);
  }, []);

  const handleLoadFull = useCallback(async () => {
    if (loadingFull || fullResult) return;
    setLoadingFull(true);
    try {
      const full = await window.api.agents.getFullToolResult(agentId, toolUseId);
      if (full != null) setFullResult(full);
    } finally {
      setLoadingFull(false);
    }
  }, [agentId, toolUseId, loadingFull, fullResult]);

  const prettyInput = (() => {
    if (typeof input === 'string') return input;
    try { return JSON.stringify(input, null, 2); } catch { return String(input); }
  })();

  const isError = result?.isError === true;

  return (
    <div className="my-1 ml-1">
      <div
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(o => !o);
          }
        }}
        className={`group flex items-center gap-1.5 w-full text-left px-2 py-1 rounded-md transition-colors cursor-pointer ${
          isLight
            ? 'hover:bg-[#f3f4f6] border border-transparent hover:border-[#d0d7de]'
            : 'hover:bg-white/[0.03] border border-transparent hover:border-white/[0.06]'
        }`}
      >
        <span
          className={`text-[9px] transition-transform duration-100 select-none shrink-0 ${isLight ? 'text-[#57606a]' : 'text-gray-500'}`}
          style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          &#9654;
        </span>
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-px rounded-sm select-text ${
            isError
              ? (isLight ? 'bg-red-500/15 text-red-700 border border-red-500/30' : 'bg-red-500/10 text-red-300/90 border border-red-500/20')
              : (isLight ? 'bg-[#daa520]/15 text-[#6e5600] border border-[#daa520]/30' : 'bg-amber-400/10 text-amber-300/90 border border-amber-400/20')
          }`}
        >
          {toolName}
        </span>
        <span
          className={`text-[11px] truncate flex-1 font-mono select-text cursor-text ${isLight ? 'text-[#57606a]' : 'text-gray-400'}`}
        >
          {preview || '…'}
        </span>
        {running ? (
          <span className={`text-[10px] shrink-0 italic select-none ${isLight ? 'text-[#8b949e]' : 'text-gray-500'}`}>running…</span>
        ) : outLines > 0 ? (
          <span className={`text-[10px] shrink-0 select-none ${isLight ? 'text-[#8b949e]' : 'text-gray-600'}`}>
            {outLines} {outLines === 1 ? 'line' : 'lines'}
          </span>
        ) : null}
      </div>
      {open && (
        <div className={`mt-1 ml-5 pl-2 border-l ${isLight ? 'border-[#d0d7de]' : 'border-gray-800'}`}>
          <pre className={`whitespace-pre-wrap break-all m-0 mb-1 text-[11px] font-mono select-text cursor-text ${isLight ? 'text-[#57606a]' : 'text-gray-500'}`}>
            {prettyInput}
          </pre>
          {outputText && (
            <pre className={`whitespace-pre-wrap break-all m-0 text-[11px] font-mono select-text cursor-text ${
              isError ? (isLight ? 'text-red-700' : 'text-red-300/90') : (isLight ? 'text-[#24292f]' : 'text-gray-400')
            }`}>
              {outputText}
            </pre>
          )}
          {result?.truncated && !fullResult && (
            <button
              type="button"
              onClick={handleLoadFull}
              disabled={loadingFull}
              className={`mt-1 text-[10px] px-2 py-0.5 rounded border ${
                isLight
                  ? 'border-[#d0d7de] text-[#0969da] hover:bg-[#f3f4f6]'
                  : 'border-gray-700 text-blue-400 hover:bg-white/[0.03]'
              } disabled:opacity-50`}
            >
              {loadingFull ? 'Loading…' : 'Show full output'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
