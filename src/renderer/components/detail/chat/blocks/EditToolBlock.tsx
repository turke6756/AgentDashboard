import React, { useState, useCallback } from 'react';
import { useThemeStore } from '../../../../stores/theme-store';
import { ToolBlockProps } from './GenericToolBlock';
import FileHeader from './fileHeader';
import { computeLineDiff } from './diff';

interface EditInput {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}

export interface EditToolBlockExtraProps {
  isCreate?: boolean;
}

export default function EditToolBlock(props: ToolBlockProps & EditToolBlockExtraProps) {
  const { toolUseId, toolName, input, result, agentId, isCreate = false } = props;
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const [open, setOpen] = useState(false);
  const [fullResult, setFullResult] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);

  const rec = (input ?? {}) as EditInput;
  const filePath = rec.file_path ?? '';
  const oldString = rec.old_string ?? '';
  const newString = rec.new_string ?? '';
  const replaceAll = rec.replace_all === true;

  const running = result === undefined;
  const isError = result?.isError === true;
  const outputText = fullResult ?? result?.content ?? '';

  const diffLines = computeLineDiff(oldString, newString);
  const removed = diffLines.filter((l) => l.kind === 'removed').length;
  const added = diffLines.filter((l) => l.kind === 'added').length;

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

  const verb = isCreate ? 'created' : 'modified';

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
        <span className={`text-[10px] shrink-0 select-none ${isLight ? 'text-[#8b949e]' : 'text-gray-500'}`}>
          {verb}
        </span>
        {filePath ? (
          <FileHeader path={filePath} agentId={agentId} />
        ) : (
          <span className={`text-[11px] font-mono italic ${isLight ? 'text-[#57606a]' : 'text-gray-400'}`}>
            (no path)
          </span>
        )}
        {replaceAll && (
          <span
            className={`text-[10px] shrink-0 px-1 py-px rounded-sm ${
              isLight ? 'bg-[#eaeef2] text-[#57606a]' : 'bg-white/[0.06] text-gray-400'
            }`}
          >
            replace all
          </span>
        )}
        <span className="flex-1" />
        {running ? (
          <span className={`text-[10px] shrink-0 italic select-none ${isLight ? 'text-[#8b949e]' : 'text-gray-500'}`}>running…</span>
        ) : (
          <span className={`text-[10px] shrink-0 select-none font-mono ${isLight ? 'text-[#8b949e]' : 'text-gray-600'}`}>
            {removed > 0 && <span className={isLight ? 'text-red-700' : 'text-red-300/90'}>-{removed}</span>}
            {removed > 0 && added > 0 && ' '}
            {added > 0 && <span className={isLight ? 'text-emerald-700' : 'text-emerald-300/90'}>+{added}</span>}
          </span>
        )}
      </div>
      {open && (
        <div className={`mt-1 ml-5 pl-2 border-l ${isLight ? 'border-[#d0d7de]' : 'border-gray-800'}`}>
          <div
            className={`rounded border overflow-hidden ${
              isLight ? 'border-[#d0d7de] bg-[#f6f8fa]' : 'border-gray-800 bg-[#0d1117]'
            }`}
          >
            {diffLines.length === 0 ? (
              <div className={`px-2 py-1 text-[11px] font-mono italic ${isLight ? 'text-[#57606a]' : 'text-gray-500'}`}>
                (empty)
              </div>
            ) : (
              diffLines.map((line, i) => {
                const bg =
                  line.kind === 'removed'
                    ? isLight
                      ? 'bg-red-500/10'
                      : 'bg-red-500/10'
                    : line.kind === 'added'
                    ? isLight
                      ? 'bg-emerald-500/10'
                      : 'bg-emerald-500/10'
                    : '';
                const text =
                  line.kind === 'removed'
                    ? isLight
                      ? 'text-red-700'
                      : 'text-red-300/90'
                    : line.kind === 'added'
                    ? isLight
                      ? 'text-emerald-700'
                      : 'text-emerald-300/90'
                    : isLight
                    ? 'text-[#24292f]'
                    : 'text-gray-300';
                const prefix = line.kind === 'removed' ? '-' : line.kind === 'added' ? '+' : ' ';
                return (
                  <div
                    key={i}
                    className={`px-2 text-[11px] font-mono whitespace-pre-wrap break-all select-text ${bg} ${text}`}
                  >
                    <span className="select-none opacity-60 mr-2">{prefix}</span>
                    {line.text || '\u00a0'}
                  </div>
                );
              })
            )}
          </div>
          {outputText && isError && (
            <pre
              className={`whitespace-pre-wrap break-all m-0 mt-1 text-[11px] font-mono select-text cursor-text ${
                isLight ? 'text-red-700' : 'text-red-300/90'
              }`}
            >
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
