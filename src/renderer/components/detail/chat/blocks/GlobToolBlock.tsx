import React, { useState, useCallback, useMemo } from 'react';
import { useThemeStore } from '../../../../stores/theme-store';
import { ToolBlockProps } from './GenericToolBlock';
import FileHeader from './fileHeader';

interface GlobInput {
  pattern?: string;
  path?: string;
}

function parseFiles(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export default function GlobToolBlock({ toolUseId, toolName, input, result, agentId }: ToolBlockProps) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const [open, setOpen] = useState(false);
  const [fullResult, setFullResult] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);

  const rec = (input ?? {}) as GlobInput;
  const pattern = rec.pattern ?? '';
  const path = rec.path;

  const running = result === undefined;
  const isError = result?.isError === true;
  const output = fullResult ?? result?.content ?? '';
  const files = useMemo(() => parseFiles(output), [output]);

  const handleToggle = useCallback(() => {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (sel && sel.toString().length > 0) return;
    setOpen((o) => !o);
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

  return (
    <div className="my-1 ml-1">
      <div
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
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
              ? isLight
                ? 'bg-red-500/15 text-red-700 border border-red-500/30'
                : 'bg-red-500/10 text-red-300/90 border border-red-500/20'
              : isLight
              ? 'bg-[#daa520]/15 text-[#6e5600] border border-[#daa520]/30'
              : 'bg-amber-400/10 text-amber-300/90 border border-amber-400/20'
          }`}
        >
          {toolName}
        </span>
        <code
          className={`text-[11px] font-mono truncate select-text cursor-text ${isLight ? 'text-[#24292f]' : 'text-gray-300'}`}
        >
          {pattern || '(no pattern)'}
        </code>
        {path && (
          <span className={`text-[10px] shrink-0 select-none ${isLight ? 'text-[#8b949e]' : 'text-gray-500'}`}>
            in <span className="font-mono">{path}</span>
          </span>
        )}
        <span className="flex-1" />
        {running ? (
          <span className={`text-[10px] shrink-0 italic select-none ${isLight ? 'text-[#8b949e]' : 'text-gray-500'}`}>running…</span>
        ) : (
          <span className={`text-[10px] shrink-0 select-none ${isLight ? 'text-[#8b949e]' : 'text-gray-600'}`}>
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </span>
        )}
      </div>
      {open && (
        <div className={`mt-1 ml-5 pl-2 border-l ${isLight ? 'border-[#d0d7de]' : 'border-gray-800'}`}>
          {files.length === 0 ? (
            <div className={`text-[11px] italic py-0.5 ${isLight ? 'text-[#57606a]' : 'text-gray-500'}`}>(no matches)</div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {files.map((f, i) => (
                <div key={i} className="flex">
                  <FileHeader path={f} agentId={agentId} />
                </div>
              ))}
            </div>
          )}
          {isError && output && (
            <pre
              className={`whitespace-pre-wrap break-all m-0 mt-1 text-[11px] font-mono select-text cursor-text ${
                isLight ? 'text-red-700' : 'text-red-300/90'
              }`}
            >
              {output}
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
