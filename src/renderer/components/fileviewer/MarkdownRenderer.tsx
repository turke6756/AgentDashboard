import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useThemeStore } from '../../stores/theme-store';

interface Props {
  content: string;
}

export default function MarkdownRenderer({ content }: Props) {
  const theme = useThemeStore((s) => s.theme);
  const isLight = theme === 'light';

  return (
    <div className="overflow-auto h-full p-6">
      <div className="max-w-3xl mx-auto prose-custom">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => (
              <h1 className="text-2xl font-bold font-sans text-gray-50 mb-4 mt-6 pb-2 border-b border-accent-blue/30">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="text-xl font-bold font-sans text-gray-50 mb-3 mt-5 pb-1 border-b dark:border-white/10 light:border-black/10">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="text-lg font-bold font-sans text-gray-200 mb-2 mt-4">{children}</h3>
            ),
            h4: ({ children }) => (
              <h4 className="text-base font-bold font-sans text-gray-300 mb-2 mt-3">{children}</h4>
            ),
            p: ({ children }) => (
              <p className="text-gray-300 mb-3 leading-relaxed text-sm">{children}</p>
            ),
            a: ({ href, children }) => (
              <a href={href} className="text-accent-blue hover:text-accent-blue/80 underline underline-offset-2">
                {children}
              </a>
            ),
            ul: ({ children }) => (
              <ul className="list-disc list-inside mb-3 text-gray-300 text-sm space-y-1">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="list-decimal list-inside mb-3 text-gray-300 text-sm space-y-1">{children}</ol>
            ),
            li: ({ children }) => <li className="text-gray-300">{children}</li>,
            blockquote: ({ children }) => (
              <blockquote className="border-l-2 border-accent-blue/50 pl-4 my-3 text-gray-400 italic">
                {children}
              </blockquote>
            ),
            table: ({ children }) => (
              <div className="overflow-x-auto mb-3">
                <table className="w-full text-sm border border-accent-blue/20">{children}</table>
              </div>
            ),
            thead: ({ children }) => (
              <thead className="bg-surface-2 text-gray-300 font-sans text-[13px]  ">
                {children}
              </thead>
            ),
            th: ({ children }) => (
              <th className="px-3 py-2 text-left border-b dark:border-white/10 light:border-black/10">{children}</th>
            ),
            td: ({ children }) => (
              <td className="px-3 py-2 text-gray-400 border-b border-surface-2">{children}</td>
            ),
            hr: () => <hr className="border-accent-blue/20 my-6" />,
            code: ({ className, children, ...props }) => {
              const match = /language-(\w+)/.exec(className || '');
              const inline = !className;
              if (inline) {
                return (
                  <code className={`px-1.5 py-0.5 rounded text-[13px] font-sans ${isLight ? 'bg-[#e5e7eb] text-[#ab3f11]' : 'bg-surface-2 text-accent-orange'}`}>
                    {children}
                  </code>
                );
              }
              return (
                <div className={`my-3 rounded border overflow-hidden ${isLight ? 'border-gray-300 bg-[#f3f4f6]' : 'border-surface-2 bg-[rgba(0,0,0,0.3)]'}`}>
                  <SyntaxHighlighter
                    language={match?.[1] || 'text'}
                    style={isLight ? vs : vscDarkPlus}
                    customStyle={{
                      margin: 0,
                      padding: '1rem',
                      background: 'transparent',
                      fontSize: '0.8125rem',
                    }}
                  >
                    {String(children).replace(/\n$/, '')}
                  </SyntaxHighlighter>
                </div>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
