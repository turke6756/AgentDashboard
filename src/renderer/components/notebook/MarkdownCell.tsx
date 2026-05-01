import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { IMarkdownCell } from '@jupyterlab/nbformat';

interface MarkdownCellProps {
  cell: Pick<IMarkdownCell, 'source' | 'metadata'>;
}

export function MarkdownCell({ cell }: MarkdownCellProps) {
  const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;

  return (
    <div className="notebook-markdown px-5 py-4">
      <div className="max-w-none font-sans">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={{
            h1: ({ children }) => (
              <h1 className="mb-3 border-b border-surface-3 pb-2 text-xl font-semibold text-fg-primary">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="mb-2 mt-5 border-b border-surface-3 pb-1 text-[17px] font-semibold text-fg-primary">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="mb-2 mt-4 text-[15px] font-semibold text-fg-primary">{children}</h3>
            ),
            p: ({ children }) => (
              <p className="mb-3 text-[13px] leading-6 text-fg-primary">{children}</p>
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
              <ul className="mb-3 list-disc pl-5 text-[13px] leading-6 text-fg-primary">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="mb-3 list-decimal pl-5 text-[13px] leading-6 text-fg-primary">{children}</ol>
            ),
            li: ({ children }) => <li className="mb-1">{children}</li>,
            blockquote: ({ children }) => (
              <blockquote className="my-4 border-l-2 border-accent-blue/50 bg-surface-1/70 py-2 pl-4 pr-3 text-fg-secondary">
                {children}
              </blockquote>
            ),
            table: ({ children }) => (
              <div className="mb-4 overflow-x-auto">
                <table className="notebook-markdown-table w-full border-collapse text-[13px]">{children}</table>
              </div>
            ),
            thead: ({ children }) => <thead>{children}</thead>,
            th: ({ children }) => (
              <th className="border border-surface-3 px-3 py-2 text-left font-medium text-fg-secondary">{children}</th>
            ),
            td: ({ children }) => (
              <td className="border border-surface-3 px-3 py-2 text-fg-primary">{children}</td>
            ),
            code: ({ className, children }) => {
              if (className) {
                return (
                  <code className="block overflow-x-auto rounded-[4px] border border-surface-3 bg-surface-1 px-3 py-2 font-mono text-xs leading-5 text-fg-primary">
                    {String(children).replace(/\n$/, '')}
                  </code>
                );
              }

              return (
                <code className="rounded-[3px] bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-accent-orange">
                  {children}
                </code>
              );
            },
            pre: ({ children }) => <pre className="my-3 overflow-x-auto">{children}</pre>,
            hr: () => <hr className="my-5 border-surface-3" />,
          }}
        >
          {source}
        </ReactMarkdown>
      </div>
    </div>
  );
}
