import React, { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { useThemeStore } from '../../stores/theme-store';

interface Props {
  initialContent: string;
  language: 'markdown' | 'text';
  saving?: boolean;
  error?: string | null;
  onChange: (content: string) => void;
  onSave: () => void;
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--color-surface-0)',
    color: 'var(--color-fg-primary)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
    lineHeight: '1.5',
  },
  '.cm-content': {
    padding: '12px 0',
  },
  '.cm-line': {
    padding: '0 12px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-surface-1)',
    color: 'var(--color-fg-muted)',
    borderRight: '1px solid var(--color-surface-3)',
  },
  '.cm-activeLineGutter, .cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
});

export default function CodeMirrorEditor({
  initialContent,
  language,
  saving,
  error,
  onChange,
  onSave,
}: Props) {
  const theme = useThemeStore((state) => state.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const initialContentRef = useRef(initialContent);

  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  }, [onChange, onSave]);

  useEffect(() => {
    if (!containerRef.current) return;

    const extensions = [
      history(),
      EditorView.lineWrapping,
      editorTheme,
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            onSaveRef.current();
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
    ];

    if (language === 'markdown') {
      extensions.push(markdown());
    }
    if (theme === 'dark') {
      extensions.push(oneDark);
    }

    const state = EditorState.create({
      doc: initialContentRef.current,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [language, theme]);

  return (
    <div className="h-full flex flex-col bg-surface-0">
      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" />
      {(saving || error) && (
        <div className="shrink-0 px-3 py-1 border-t border-surface-3 text-[12px] font-sans">
          {saving ? (
            <span className="text-gray-400">Saving...</span>
          ) : (
            <span className="text-accent-red">{error}</span>
          )}
        </div>
      )}
    </div>
  );
}
