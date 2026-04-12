import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import DOMPurify from 'dompurify';
import { useThemeStore } from '../../stores/theme-store';

// ── Notebook JSON types ─────────────────────────────────────────────────

interface NotebookOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
  name?: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface NotebookCell {
  cell_type: 'markdown' | 'code' | 'raw';
  source: string | string[];
  outputs?: NotebookOutput[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
}

interface NotebookData {
  cells: NotebookCell[];
  metadata?: {
    kernelspec?: { display_name?: string; language?: string; name?: string };
    language_info?: { name?: string };
  };
  nbformat?: number;
  nbformat_minor?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function joinSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source;
}

function getKernelLanguage(nb: NotebookData): string {
  return (
    nb.metadata?.kernelspec?.language?.toLowerCase() ||
    nb.metadata?.language_info?.name?.toLowerCase() ||
    'python'
  );
}

function getKernelDisplay(nb: NotebookData): string {
  return nb.metadata?.kernelspec?.display_name || nb.metadata?.kernelspec?.name || 'Unknown';
}

/** Map notebook language names to Prism language identifiers */
function toPrismLanguage(lang: string): string {
  const map: Record<string, string> = {
    r: 'r', python: 'python', julia: 'julia', javascript: 'javascript',
    typescript: 'typescript', ruby: 'ruby', bash: 'bash', sql: 'sql',
    scala: 'scala', go: 'go', rust: 'rust', c: 'c', cpp: 'cpp',
  };
  return map[lang] || lang;
}

// ── Output renderers ────────────────────────────────────────────────────

function CellOutputs({ outputs, isLight }: { outputs: NotebookOutput[]; isLight: boolean }) {
  return (
    <div className={`border-t ${isLight ? 'border-gray-200 bg-gray-50' : 'border-white/5 bg-black/20'}`}>
      {outputs.map((out, i) => (
        <OutputItem key={i} output={out} isLight={isLight} />
      ))}
    </div>
  );
}

function OutputItem({ output, isLight }: { output: NotebookOutput; isLight: boolean }) {
  // Error output
  if (output.output_type === 'error') {
    const tb = (output.traceback || []).join('\n');
    // Strip ANSI escape codes for display
    const clean = tb.replace(/\x1b\[[0-9;]*m/g, '');
    return (
      <pre className={`px-4 py-2 text-xs overflow-x-auto whitespace-pre-wrap font-mono ${isLight ? 'text-red-700 bg-red-50' : 'text-red-400 bg-red-950/30'}`}>
        {clean || `${output.ename}: ${output.evalue}`}
      </pre>
    );
  }

  // Stream output (stdout/stderr)
  if (output.output_type === 'stream') {
    const text = joinSource(output.text || '');
    const isStderr = output.name === 'stderr';
    return (
      <pre className={`px-4 py-2 text-xs overflow-x-auto whitespace-pre-wrap font-mono ${isStderr ? (isLight ? 'text-orange-700' : 'text-orange-400') : (isLight ? 'text-gray-700' : 'text-gray-300')}`}>
        {text}
      </pre>
    );
  }

  // Rich output (execute_result / display_data)
  const data = output.data || {};

  // Image outputs (base64)
  if (data['image/png']) {
    const src = `data:image/png;base64,${joinSource(data['image/png']).trim()}`;
    return (
      <div className="px-4 py-2">
        <img src={src} alt="Cell output" className="max-w-full" />
      </div>
    );
  }
  if (data['image/jpeg']) {
    const src = `data:image/jpeg;base64,${joinSource(data['image/jpeg']).trim()}`;
    return (
      <div className="px-4 py-2">
        <img src={src} alt="Cell output" className="max-w-full" />
      </div>
    );
  }
  if (data['image/svg+xml']) {
    const svg = DOMPurify.sanitize(joinSource(data['image/svg+xml']));
    return (
      <div className="px-4 py-2" dangerouslySetInnerHTML={{ __html: svg }} />
    );
  }

  // HTML output
  if (data['text/html']) {
    const html = DOMPurify.sanitize(joinSource(data['text/html']));
    return (
      <div
        className={`px-4 py-2 text-xs overflow-x-auto notebook-html-output ${isLight ? 'text-gray-700' : 'text-gray-300'}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  // JSON output
  if (data['application/json']) {
    const json = typeof data['application/json'] === 'string'
      ? data['application/json']
      : JSON.stringify(data['application/json'], null, 2);
    return (
      <pre className={`px-4 py-2 text-xs overflow-x-auto whitespace-pre-wrap font-mono ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
        {json}
      </pre>
    );
  }

  // Plain text fallback
  if (data['text/plain']) {
    return (
      <pre className={`px-4 py-2 text-xs overflow-x-auto whitespace-pre-wrap font-mono ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
        {joinSource(data['text/plain'])}
      </pre>
    );
  }

  return null;
}

// ── Markdown cell (inline) ──────────────────────────────────────────────

function MarkdownCell({ source, isLight }: { source: string; isLight: boolean }) {
  return (
    <div className="px-5 py-3 prose-custom">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-xl font-bold font-sans text-gray-50 mb-3 mt-4 pb-1 border-b border-accent-blue/30">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-lg font-bold font-sans text-gray-50 mb-2 mt-3">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-base font-bold font-sans text-gray-200 mb-2 mt-3">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="text-gray-300 mb-2 leading-relaxed text-sm">{children}</p>
          ),
          a: ({ href, children }) => (
            <a href={href} className="text-accent-blue hover:text-accent-blue/80 underline underline-offset-2">{children}</a>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-inside mb-2 text-gray-300 text-sm space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside mb-2 text-gray-300 text-sm space-y-1">{children}</ol>
          ),
          li: ({ children }) => <li className="text-gray-300">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-accent-blue/50 pl-3 my-2 text-gray-400 italic">{children}</blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto mb-2">
              <table className="w-full text-sm border border-accent-blue/20">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-surface-2 text-gray-300 font-sans text-[13px]">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="px-3 py-1.5 text-left border-b dark:border-white/10 light:border-black/10">{children}</th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-1.5 text-gray-400 border-b border-surface-2">{children}</td>
          ),
          code: ({ className, children }) => {
            const match = /language-(\w+)/.exec(className || '');
            const inline = !className;
            if (inline) {
              return (
                <code className={`px-1.5 py-0.5 rounded text-[13px] font-mono ${isLight ? 'bg-[#e5e7eb] text-[#ab3f11]' : 'bg-surface-2 text-accent-orange'}`}>
                  {children}
                </code>
              );
            }
            return (
              <div className={`my-2 rounded border overflow-hidden ${isLight ? 'border-gray-300 bg-[#f3f4f6]' : 'border-surface-2 bg-[rgba(0,0,0,0.3)]'}`}>
                <SyntaxHighlighter
                  language={match?.[1] || 'text'}
                  style={isLight ? vs : vscDarkPlus}
                  customStyle={{ margin: 0, padding: '0.75rem', background: 'transparent', fontSize: '0.8125rem' }}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              </div>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

// ── Code cell ───────────────────────────────────────────────────────────

function CodeCell({ cell, language, isLight }: { cell: NotebookCell; language: string; isLight: boolean }) {
  const source = joinSource(cell.source);
  const execCount = cell.execution_count;
  const outputs = cell.outputs || [];

  return (
    <div>
      {/* Code input */}
      <div className="flex">
        {/* Execution count gutter */}
        <div className={`flex-shrink-0 w-12 pt-3 text-right pr-2 text-[11px] font-mono select-none ${isLight ? 'text-gray-400' : 'text-gray-600'}`}>
          {execCount != null ? `[${execCount}]` : '[ ]'}
        </div>
        {/* Code block */}
        <div className="flex-1 min-w-0 overflow-auto">
          <SyntaxHighlighter
            language={language}
            style={isLight ? vs : vscDarkPlus}
            showLineNumbers={false}
            customStyle={{
              margin: 0,
              padding: '0.75rem 1rem',
              background: 'transparent',
              fontSize: '0.8125rem',
              lineHeight: '1.5',
            }}
          >
            {source}
          </SyntaxHighlighter>
        </div>
      </div>

      {/* Outputs */}
      {outputs.length > 0 && <CellOutputs outputs={outputs} isLight={isLight} />}
    </div>
  );
}

// ── Raw cell ────────────────────────────────────────────────────────────

function RawCell({ source, isLight }: { source: string; isLight: boolean }) {
  return (
    <pre className={`px-5 py-3 text-xs whitespace-pre-wrap font-mono ${isLight ? 'text-gray-600' : 'text-gray-500'}`}>
      {source}
    </pre>
  );
}

// ── Main component ──────────────────────────────────────────────────────

interface Props {
  content: string;
}

export default function NotebookRenderer({ content }: Props) {
  const theme = useThemeStore((s) => s.theme);
  const isLight = theme === 'light';

  const notebook = useMemo<NotebookData | null>(() => {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }, [content]);

  if (!notebook || !notebook.cells) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center p-8">
          <div className="text-3xl mb-4">&#x1F4D3;</div>
          <div className="text-gray-400 font-sans text-sm">Failed to parse notebook</div>
        </div>
      </div>
    );
  }

  const kernelDisplay = getKernelDisplay(notebook);
  const language = toPrismLanguage(getKernelLanguage(notebook));
  const cellCount = notebook.cells.length;
  const codeCount = notebook.cells.filter((c) => c.cell_type === 'code').length;

  return (
    <div className="overflow-auto h-full scrollbar-thin">
      {/* Header badge */}
      <div className={`sticky top-0 z-10 flex items-center gap-3 px-5 py-2 border-b text-[12px] font-sans ${isLight ? 'bg-white/90 border-gray-200 text-gray-500' : 'bg-surface-0/90 border-white/5 text-gray-500'} backdrop-blur`}>
        <span className={`px-2 py-0.5 rounded font-medium ${isLight ? 'bg-blue-100 text-blue-700' : 'bg-accent-blue/15 text-accent-blue'}`}>
          {kernelDisplay}
        </span>
        <span>{cellCount} cells ({codeCount} code)</span>
        {notebook.nbformat && (
          <span className="text-gray-600">nbformat {notebook.nbformat}.{notebook.nbformat_minor ?? 0}</span>
        )}
      </div>

      {/* Cells */}
      <div className="pb-8">
        {notebook.cells.map((cell, i) => {
          const isCode = cell.cell_type === 'code';
          const isMarkdown = cell.cell_type === 'markdown';

          return (
            <div
              key={i}
              className={`border-b ${isLight ? 'border-gray-100' : 'border-white/[0.03]'} ${
                isCode
                  ? isLight ? 'bg-gray-50/50' : 'bg-white/[0.02]'
                  : ''
              }`}
            >
              {isMarkdown && <MarkdownCell source={joinSource(cell.source)} isLight={isLight} />}
              {isCode && <CodeCell cell={cell} language={language} isLight={isLight} />}
              {cell.cell_type === 'raw' && <RawCell source={joinSource(cell.source)} isLight={isLight} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
