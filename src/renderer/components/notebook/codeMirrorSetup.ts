import { Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { yUndoManagerKeymap } from 'y-codemirror.next';

export const languageCompartment = new Compartment();

function resolveLanguage(language: string): Extension {
  switch (language) {
    case 'python':
    default:
      return python();
  }
}

export function languageExtension(language: string): Extension {
  return languageCompartment.of(resolveLanguage(language));
}

const notebookEditorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--color-surface-0)',
    color: 'var(--color-fg-primary)',
    fontSize: '13px',
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
    minWidth: '44px',
  },
  '.cm-activeLineGutter, .cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-accent-blue-bright)',
  },
  '.cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(55, 148, 255, 0.25)',
  },
});

export const sharedEditorExtensions: Extension[] = [
  history(),
  lineNumbers(),
  EditorView.lineWrapping,
  notebookEditorTheme,
  keymap.of([
    ...defaultKeymap,
    ...historyKeymap,
    ...yUndoManagerKeymap,
  ]),
];
