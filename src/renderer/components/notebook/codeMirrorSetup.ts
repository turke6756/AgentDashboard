import { Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { tags } from '@lezer/highlight';
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
    padding: '0 16px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--notebook-code-gutter-bg)',
    color: 'var(--color-fg-muted)',
    borderRight: '1px solid var(--notebook-subtle-border)',
    minWidth: '44px',
  },
  '.cm-activeLineGutter, .cm-activeLine': {
    backgroundColor: 'var(--notebook-active-line)',
  },
  '&.cm-focused .cm-activeLine': {
    backgroundColor: 'var(--notebook-active-line-focused)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-accent-blue-bright)',
  },
  '.cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(55, 148, 255, 0.25)',
  },
});

const notebookHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--notebook-syntax-keyword)' },
  { tag: [tags.string, tags.regexp, tags.special(tags.string)], color: 'var(--notebook-syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--notebook-syntax-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--notebook-syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.name, tags.variableName, tags.propertyName, tags.attributeName], color: 'var(--notebook-syntax-name)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--notebook-syntax-function)' },
  { tag: [tags.typeName, tags.className, tags.standard(tags.name), tags.standard(tags.variableName)], color: 'var(--notebook-syntax-type)' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: 'var(--color-fg-secondary)' },
]);

export const sharedEditorExtensions: Extension[] = [
  history(),
  lineNumbers(),
  EditorView.lineWrapping,
  notebookEditorTheme,
  syntaxHighlighting(notebookHighlightStyle),
  keymap.of([
    ...defaultKeymap,
    ...historyKeymap,
    ...yUndoManagerKeymap,
  ]),
];
