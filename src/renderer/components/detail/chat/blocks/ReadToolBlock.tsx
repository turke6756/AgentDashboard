import React, { useState, useCallback, useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useThemeStore } from '../../../../stores/theme-store';
import { useDashboardStore } from '../../../../stores/dashboard-store';
import { ToolBlockProps } from './GenericToolBlock';
import FileHeader from './fileHeader';

interface ReadInput {
  file_path?: string;
  offset?: number;
  limit?: number;
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  md: 'markdown',
  mdx: 'markdown',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  html: 'markup',
  xml: 'markup',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  r: 'r',
  R: 'r',
};

function detectLang(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot < 0) return 'text';
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_LANG[ext] ?? 'text';
}

// Read emits lines like "   123→content". Strip that gutter so syntax highlighting works.
function stripReadGutter(content: string): string {
  return content
    .split('\n')
    .map((l) => {
      const m = l.match(/^\s*\d+\u2192(.*)$/);
      return m ? m[1] : l;
    })
    .join('\n');
}

export default function ReadToolBlock({ toolUseId, toolName, input, result, agentId }: ToolBlockProps) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const openFileViewer = useDashboardStore((s) => s.openFileViewer);
  const [open, setOpen] = useState(false);
  const [fullResult, setFullResult] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);

  const rec = (input ?? {}) as ReadInput;
  const filePath = rec.file_path ?? '';
  const offset = typeof rec.offset === 'number' ? rec.offset : undefined;
  const limit = typeof rec.limit === 'number' ? rec.limit : undefined;

  const running = result === undefined;
  const isError = result?.isError === true;
  const rawOutput = fullResult ?? result?.content ?? '';
  const cleaned = useMemo(() => stripReadGutter(rawOutput), [rawOutput]);
  const lineCount = cleaned ? cleaned.split('\n').length : 0;
  const lang = detectLang(filePath);

  const rangeLabel = offset !== undefined
    ? limit !== undefined
      ? `lines ${offset}-${offset + limit}`
      : `from line ${offset}`
    : limit !== undefined
    ? `first ${limit} lines`
    : null;

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
        {filePath ? (
          <FileHeader path={filePath} agentId={agentId} />
        ) : (
          <span className={`text-[11px] font-mono italic ${isLight ? 'text-[#57606a]' : 'text-gray-400'}`}>
            (no path)
          </span>
        )}
        {rangeLabel && (
          <span
            className={`text-[10px] shrink-0 px-1 py-px rounded-sm ${
              isLight ? 'bg-[#eaeef2] text-[#57606a]' : 'bg-white/[0.06] text-gray-400'
            }`}
          >
            {rangeLabel}
          </span>
        )}
        <span className="flex-1" />
        {running ? (
          <span className={`text-[10px] shrink-0 italic select-none ${isLight ? 'text-[#8b949e]' : 'text-gray-500'}`}>running…</span>
        ) : lineCount > 0 ? (
          <span className={`text-[10px] shrink-0 select-none ${isLight ? 'text-[#8b949e]' : 'text-gray-600'}`}>
            {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </span>
        ) : null}
      </div>
      {open && (
        <div className={`mt-1 ml-5 pl-2 border-l ${isLight ? 'border-[#d0d7de]' : 'border-gray-800'}`}>
          {cleaned && !isError && (
            <div
              className={`rounded border overflow-hidden ${
                isLight ? 'border-[#d0d7de] bg-[#f6f8fa]' : 'border-gray-800 bg-[#0d1117]'
              }`}
            >
              <SyntaxHighlighter
                language={lang}
                style={isLight ? vs : vscDarkPlus}
                customStyle={{
                  margin: 0,
                  padding: '0.5rem 0.625rem',
                  background: 'transparent',
                  fontSize: '12px',
                  lineHeight: '1.5',
                }}
              >
                {cleaned}
              </SyntaxHighlighter>
            </div>
          )}
          {cleaned && isError && (
            <pre
              className={`whitespace-pre-wrap break-all m-0 text-[11px] font-mono select-text cursor-text ${
                isLight ? 'text-red-700' : 'text-red-300/90'
              }`}
            >
              {cleaned}
            </pre>
          )}
          <div className="flex gap-2 mt-1">
            {filePath && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openFileViewer(filePath, agentId);
                }}
                className={`text-[10px] px-2 py-0.5 rounded border ${
                  isLight
                    ? 'border-[#d0d7de] text-[#0969da] hover:bg-[#f3f4f6]'
                    : 'border-gray-700 text-blue-400 hover:bg-white/[0.03]'
                }`}
              >
                Open in viewer
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
