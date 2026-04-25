import React, { useState, useCallback, useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useThemeStore } from '../../../../stores/theme-store';
import { ToolBlockProps } from './GenericToolBlock';
import { stripAnsi } from './ansi';

interface BashInput {
  command?: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

const INLINE_VISIBLE_LINES = 12;

export default function BashToolBlock({ toolUseId, toolName, input, result, agentId }: ToolBlockProps) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [fullResult, setFullResult] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);

  const rec = (input ?? {}) as BashInput;
  const command = rec.command ?? '';
  const description = rec.description;
  const background = rec.run_in_background === true;

  const running = result === undefined;
  const isError = result?.isError === true;

  const rawOutput = fullResult ?? result?.content ?? '';
  const cleanOutput = useMemo(() => stripAnsi(rawOutput), [rawOutput]);
  const outputLines = cleanOutput ? cleanOutput.split('\n') : [];
  const outCountNonEmpty = outputLines.filter((l) => l.trim().length > 0).length;
  const tooLong = outputLines.length > INLINE_VISIBLE_LINES;
  const visibleOutput = showAll || !tooLong
    ? cleanOutput
    : outputLines.slice(0, INLINE_VISIBLE_LINES).join('\n');

  const cmdLines = command.split('\n');
  const firstLine = cmdLines[0] ?? '';
  const extraCmdLines = cmdLines.length - 1;
  const previewCmd = firstLine.length > 72 ? firstLine.slice(0, 72) + '…' : firstLine;

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
          className={`text-[11px] truncate font-mono select-text cursor-text ${
            isLight ? 'text-[#24292f]' : 'text-gray-300'
          }`}
        >
          {previewCmd || '(empty command)'}
        </code>
        {extraCmdLines > 0 && (
          <span className={`text-[10px] shrink-0 select-none ${isLight ? 'text-[#8b949e]' : 'text-gray-500'}`}>
            +{extraCmdLines}
          </span>
        )}
        {background && (
          <span
            className={`text-[10px] shrink-0 px-1 py-px rounded-sm font-mono ${
              isLight ? 'bg-[#eaeef2] text-[#57606a]' : 'bg-white/[0.06] text-gray-400'
            }`}
          >
            bg
          </span>
        )}
        {description && (
          <span className={`text-[10px] truncate italic flex-1 select-text ${isLight ? 'text-[#8b949e]' : 'text-gray-500'}`}>
            {description}
          </span>
        )}
        {!description && <span className="flex-1" />}
        {running ? (
          <span className={`text-[10px] shrink-0 italic select-none ${isLight ? 'text-[#8b949e]' : 'text-gray-500'}`}>running…</span>
        ) : outCountNonEmpty > 0 ? (
          <span className={`text-[10px] shrink-0 select-none ${isLight ? 'text-[#8b949e]' : 'text-gray-600'}`}>
            {outCountNonEmpty} {outCountNonEmpty === 1 ? 'line' : 'lines'}
          </span>
        ) : null}
      </div>
      {open && (
        <div className={`mt-1 ml-5 pl-2 border-l ${isLight ? 'border-[#d0d7de]' : 'border-gray-800'}`}>
          {command && (
            <div
              className={`rounded border overflow-hidden mb-1 ${
                isLight ? 'border-[#d0d7de] bg-[#f6f8fa]' : 'border-gray-800 bg-[#0d1117]'
              }`}
            >
              <SyntaxHighlighter
                language="bash"
                style={isLight ? vs : vscDarkPlus}
                customStyle={{
                  margin: 0,
                  padding: '0.5rem 0.625rem',
                  background: 'transparent',
                  fontSize: '12px',
                  lineHeight: '1.45',
                }}
              >
                {command}
              </SyntaxHighlighter>
            </div>
          )}
          {cleanOutput && (
            <pre
              className={`whitespace-pre-wrap break-all m-0 text-[11px] font-mono select-text cursor-text ${
                isError ? (isLight ? 'text-red-700' : 'text-red-300/90') : isLight ? 'text-[#24292f]' : 'text-gray-400'
              }`}
            >
              {visibleOutput}
            </pre>
          )}
          <div className="flex gap-2 mt-1">
            {tooLong && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className={`text-[10px] px-2 py-0.5 rounded border ${
                  isLight
                    ? 'border-[#d0d7de] text-[#0969da] hover:bg-[#f3f4f6]'
                    : 'border-gray-700 text-blue-400 hover:bg-white/[0.03]'
                }`}
              >
                {showAll ? 'Show less' : `Show all ${outputLines.length} lines`}
              </button>
            )}
            {result?.truncated && !fullResult && (
              <button
                type="button"
                onClick={handleLoadFull}
                disabled={loadingFull}
                className={`text-[10px] px-2 py-0.5 rounded border ${
                  isLight
                    ? 'border-[#d0d7de] text-[#0969da] hover:bg-[#f3f4f6]'
                    : 'border-gray-700 text-blue-400 hover:bg-white/[0.03]'
                } disabled:opacity-50`}
              >
                {loadingFull ? 'Loading…' : 'Show full output'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
