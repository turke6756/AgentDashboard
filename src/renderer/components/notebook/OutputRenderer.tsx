import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Anser from 'anser';
import DOMPurify from 'dompurify';
import ReactMarkdown from 'react-markdown';
import type * as nbformat from '@jupyterlab/nbformat';
import {
  base64ToBlob,
  hashString,
  isErrorOutput,
  isRichOutput,
  isStreamOutput,
  isWidgetMime,
  joinMultiline,
  mimeValueToText,
  normalizeOutputs,
  selectMimeType,
} from './outputUtils';

interface OutputRendererProps {
  outputs: nbformat.IOutput[];
}

export function OutputRenderer({ outputs }: OutputRendererProps) {
  const bufferedOutputs = useRafOutputs(outputs);
  const normalizedOutputs = useMemo(() => normalizeOutputs(bufferedOutputs), [bufferedOutputs]);
  const imageUrlsRef = useRef(new Map<string, string>());

  const getImageUrl = useCallback((mimeType: string, base64: string) => {
    const key = `${mimeType}:${base64.length}:${hashString(base64)}`;
    const cached = imageUrlsRef.current.get(key);
    if (cached) return cached;

    const url = URL.createObjectURL(base64ToBlob(base64, mimeType));
    imageUrlsRef.current.set(key, url);
    return url;
  }, []);

  useEffect(() => {
    return () => {
      for (const url of imageUrlsRef.current.values()) {
        URL.revokeObjectURL(url);
      }
      imageUrlsRef.current.clear();
    };
  }, []);

  if (normalizedOutputs.length === 0) return null;

  return (
    <div className="notebook-output">
      {normalizedOutputs.map((output, index) => (
        <OutputItem
          key={index}
          output={output}
          getImageUrl={getImageUrl}
        />
      ))}
    </div>
  );
}

function useRafOutputs(outputs: nbformat.IOutput[]): nbformat.IOutput[] {
  const latest = useRef(outputs);
  const [renderedOutputs, setRenderedOutputs] = useState(outputs);

  useEffect(() => {
    latest.current = outputs;
    const frame = requestAnimationFrame(() => {
      setRenderedOutputs(latest.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [outputs]);

  return renderedOutputs;
}

function OutputItem({
  output,
  getImageUrl,
}: {
  output: ReturnType<typeof normalizeOutputs>[number];
  getImageUrl: (mimeType: string, base64: string) => string;
}) {
  if (isStreamOutput(output)) {
    return <AnsiPre text={output.text} tone={output.name === 'stderr' ? 'stderr' : 'stdout'} />;
  }

  if (isErrorOutput(output)) {
    const traceback = output.traceback?.length
      ? output.traceback.join('\n')
      : `${output.ename}: ${output.evalue}`;
    return <AnsiPre text={traceback} tone="error" />;
  }

  if (!isRichOutput(output)) {
    return null;
  }

  const mimeType = selectMimeType(output.data);
  if (isWidgetMime(mimeType)) {
    return <UnsupportedWidget />;
  }

  switch (mimeType) {
    case 'image/png':
    case 'image/jpeg': {
      const base64 = mimeValueToText(output.data[mimeType]).trim();
      return (
        <div className="notebook-output-item overflow-auto px-4 py-3">
          <img
            src={getImageUrl(mimeType, base64)}
            alt="Cell output"
            className="max-w-full rounded-[3px]"
          />
        </div>
      );
    }
    case 'image/svg+xml': {
      const html = sanitizeHtml(mimeValueToText(output.data[mimeType]));
      return <div className="notebook-output-item overflow-auto px-4 py-3" dangerouslySetInnerHTML={{ __html: html }} />;
    }
    case 'text/html': {
      const html = sanitizeHtml(mimeValueToText(output.data[mimeType]));
      return (
        <div
          className="notebook-output-item notebook-html-output overflow-auto px-4 py-3 text-sm text-fg-primary"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    case 'text/markdown':
      return (
        <div className="notebook-output-item notebook-markdown px-4 py-3 text-sm text-fg-primary">
          <ReactMarkdown>{mimeValueToText(output.data[mimeType])}</ReactMarkdown>
        </div>
      );
    case 'application/json':
      return <JsonOutput value={output.data[mimeType]} />;
    case 'text/plain':
      return <AnsiPre text={mimeValueToText(output.data[mimeType])} tone="plain" />;
    default:
      return null;
  }
}

function AnsiPre({
  text,
  tone,
}: {
  text: string;
  tone: 'stdout' | 'stderr' | 'error' | 'plain';
}) {
  const html = useMemo(() => {
    const escaped = Anser.escapeForHtml(text);
    return sanitizeHtml(Anser.ansiToHtml(escaped));
  }, [text]);

  const toneClass =
    tone === 'stderr'
      ? 'notebook-output-stderr text-accent-orange'
      : tone === 'error'
        ? 'notebook-output-error text-accent-red'
        : 'notebook-output-console text-fg-primary';

  return (
    <pre
      className={`notebook-output-item m-0 overflow-auto whitespace-pre-wrap px-4 py-2 font-mono text-xs leading-5 ${toneClass}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function JsonOutput({ value }: { value: nbformat.IMimeBundle[string] | undefined }) {
  const text = typeof value === 'string' || Array.isArray(value)
    ? joinMultiline(value)
    : JSON.stringify(value, null, 2);

  return (
    <details className="notebook-output-item px-4 py-2 text-xs text-fg-primary">
      <summary className="cursor-pointer select-none font-sans text-fg-secondary">application/json</summary>
      <pre className="m-0 mt-2 overflow-auto whitespace-pre-wrap font-mono leading-5">{text}</pre>
    </details>
  );
}

function UnsupportedWidget() {
  return (
    <div className="notebook-output-item px-4 py-3 font-sans text-sm text-fg-muted">
      [Interactive widget - not supported in v1]
    </div>
  );
}

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
  });
}
