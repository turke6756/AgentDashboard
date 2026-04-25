import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { yCollab } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { languageExtension, sharedEditorExtensions } from './codeMirrorSetup';

interface CodeCellProps {
  cellId: string;
  ytext: Y.Text;
  awareness: Awareness;
  language?: string;
  onFocus?: (cellId: string) => void;
}

export function CodeCell({
  cellId,
  ytext,
  awareness,
  language = 'python',
  onFocus,
}: CodeCellProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onFocusRef = useRef(onFocus);

  useEffect(() => {
    onFocusRef.current = onFocus;
  }, [onFocus]);

  useEffect(() => {
    if (!containerRef.current) return;

    const undoManager = new Y.UndoManager(ytext);
    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        ...sharedEditorExtensions,
        languageExtension(language),
        EditorView.domEventHandlers({
          focus: () => {
            onFocusRef.current?.(cellId);
          },
        }),
        yCollab(ytext, awareness, {
          undoManager,
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
      undoManager.destroy();
    };
  }, [awareness, cellId, language, ytext]);

  return <div ref={containerRef} className="min-h-[48px]" />;
}
