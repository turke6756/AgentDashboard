import { createElement, Fragment } from 'react';
import { common, createLowlight } from 'lowlight';
import type { ElementContent, Root } from 'hast';
import { useThemeStore } from '../../stores/theme-store';

const lowlight = createLowlight(common);

interface StaticCodeBlockProps {
  source: string;
  language?: string;
}

export function StaticCodeBlock({
  source,
  language = 'python',
}: StaticCodeBlockProps) {
  const theme = useThemeStore((state) => state.theme);
  const tree = highlightSource(source, language);

  return (
    <pre className="notebook-static-code m-0 overflow-auto px-4 py-3 font-mono text-xs leading-5 text-fg-primary">
      <code>{renderNodes(tree.children, theme)}</code>
    </pre>
  );
}

function highlightSource(source: string, language: string): Root {
  if (lowlight.registered(language)) {
    return lowlight.highlight(language, source);
  }

  return lowlight.highlightAuto(source, {
    subset: lowlight.listLanguages(),
  });
}

function renderNodes(nodes: ElementContent[], theme: 'dark' | 'light') {
  return nodes.map((node, index) => {
    if (node.type === 'text') {
      return <Fragment key={index}>{node.value}</Fragment>;
    }

    if (node.type !== 'element') {
      return null;
    }

    return (
      <span key={index} style={styleForClasses(node.properties.className, theme)}>
        {renderNodes(node.children, theme)}
      </span>
    );
  });
}

function styleForClasses(className: unknown, theme: 'dark' | 'light') {
  const classes = Array.isArray(className) ? className : [];
  const joined = classes.join(' ');
  const palette = theme === 'light' ? lightPalette : darkPalette;

  if (joined.includes('hljs-keyword') || joined.includes('hljs-selector-tag')) return { color: palette.keyword };
  if (joined.includes('hljs-string') || joined.includes('hljs-regexp')) return { color: palette.string };
  if (joined.includes('hljs-attr') || joined.includes('hljs-attribute')) return { color: palette.variable };
  if (joined.includes('hljs-number') || joined.includes('hljs-literal')) return { color: palette.number };
  if (joined.includes('hljs-comment')) return { color: palette.comment, fontStyle: 'italic' as const };
  if (joined.includes('hljs-title') || joined.includes('hljs-function')) return { color: palette.function };
  if (joined.includes('hljs-variable') || joined.includes('hljs-params') || joined.includes('hljs-name')) {
    return { color: palette.variable };
  }
  if (joined.includes('hljs-built_in') || joined.includes('hljs-type') || joined.includes('hljs-class')) {
    return { color: palette.type };
  }

  return undefined;
}

const darkPalette = {
  keyword: '#c586c0',
  string: '#89d185',
  number: '#d7ba7d',
  comment: '#7a8a78',
  function: '#9cdcfe',
  variable: '#9cdcfe',
  type: '#4ec9b0',
};

const lightPalette = {
  keyword: '#8b2bb9',
  string: '#2e7d32',
  number: '#a15c00',
  comment: '#6b7668',
  function: '#005a9e',
  variable: '#005a9e',
  type: '#0b7f79',
};
