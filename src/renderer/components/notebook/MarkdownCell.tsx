import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { IMarkdownCell } from '@jupyterlab/nbformat';
import { useThemeStore } from '../../stores/theme-store';

interface MarkdownCellProps {
  cell: Pick<IMarkdownCell, 'source' | 'metadata'>;
}

export function MarkdownCell({ cell }: MarkdownCellProps) {
  const theme = useThemeStore((state) => state.theme);
  const isLight = theme === 'light';
  const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;

  return (
    <div className="px-5 py-4">
      <div className="prose prose-sm max-w-none font-sans dark:prose-invert">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={{
            h1: ({ children }) => (
              <h1 className="mb-4 border-b border-accent-blue/20 pb-2 text-xl font-semibold text-fg-primary">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="mb-3 mt-6 border-b border-surface-3 pb-1 text-lg font-semibold text-fg-primary">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="mb-2 mt-5 text-base font-semibold text-fg-primary">{children}</h3>
            ),
            p: ({ children }) => (
              <p className="mb-3 text-sm leading-6 text-fg-primary">{children}</p>
            ),
            a: ({ href, children }) => (
              <a
                href={href}
                className="text-accent-blue underline underline-offset-2 hover:text-accent-blue-bright"
              >
                {children}
              </a>
            ),
            ul: ({ children }) => (
              <ul className="mb-3 list-disc pl-5 text-sm text-fg-primary">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="mb-3 list-decimal pl-5 text-sm text-fg-primary">{children}</ol>
            ),
            li: ({ children }) => <li className="mb-1">{children}</li>,
            blockquote: ({ children }) => (
              <blockquote className="my-4 border-l-2 border-accent-blue/40 pl-4 italic text-fg-secondary">
                {children}
              </blockquote>
            ),
            table: ({ children }) => (
              <div className="mb-4 overflow-x-auto">
                <table className="w-full border-collapse text-sm">{children}</table>
              </div>
            ),
            thead: ({ children }) => (
              <thead className={isLight ? 'bg-gray-100 text-gray-700' : 'bg-surface-2 text-fg-secondary'}>
                {children}
              </thead>
            ),
            th: ({ children }) => (
              <th className="border border-surface-3 px-3 py-2 text-left font-medium">{children}</th>
            ),
            td: ({ children }) => (
              <td className="border border-surface-3 px-3 py-2 text-fg-primary">{children}</td>
            ),
            code: ({ className, children }) => {
              if (className) {
                return (
                  <code className="block overflow-x-auto rounded border border-surface-3 bg-surface-1 px-3 py-2 font-mono text-xs text-fg-primary">
                    {String(children).replace(/\n$/, '')}
                  </code>
                );
              }

              return (
                <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-accent-orange">
                  {children}
                </code>
              );
            },
            pre: ({ children }) => <pre className="my-3 overflow-x-auto">{children}</pre>,
          }}
        >
          {source}
        </ReactMarkdown>
      </div>
    </div>
  );
}
