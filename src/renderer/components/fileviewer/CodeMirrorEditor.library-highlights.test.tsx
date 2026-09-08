// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CodeMirrorEditor from './CodeMirrorEditor';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(Range.prototype as Range & { getClientRects: () => DOMRect[] }).getClientRects = () => [];
Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) });
let host: HTMLDivElement | undefined;

afterEach(() => { host?.remove(); host = undefined; vi.restoreAllMocks(); });

describe('CodeMirror Library highlights', () => {
  it('uses live logical lines/UTF-16 columns, rejects invalid spans, and paints exact after similar', async () => {
    host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
    await act(async () => root.render(<CodeMirrorEditor initialContent={'\uFEFFone\r\ntwo 😀 here\rthree'} language="text" onChange={() => {}} onSave={() => {}} focusRange={{ lineStart: 2, lineEnd: 2, nonce: 1, highlights: [
      { id: 'similar', kind: 'similar', start: { line: 2, utf16_column: 0 }, end: { line: 2, utf16_column: 11 } },
      { id: 'exact', kind: 'exact', start: { line: 2, utf16_column: 4 }, end: { line: 2, utf16_column: 6 } },
      { id: 'invalid', kind: 'exact', start: { line: 9, utf16_column: 0 }, end: { line: 9, utf16_column: 1 } },
    ] }} />));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(host.querySelector('[data-library-highlight-id="similar"]')).not.toBeNull();
    expect(host.querySelector('[data-library-highlight-id="exact"]')).not.toBeNull();
    expect(host.querySelector('[data-library-highlight-id="invalid"]')).toBeNull();
    act(() => root.unmount());
  });

  it('re-scrolls for a fresh nonce while retaining every valid painted span', async () => {
    const scroll = vi.spyOn(EditorView, 'scrollIntoView');
    host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
    const highlights = [
      { id: 'one', kind: 'exact' as const, start: { line: 1, utf16_column: 0 }, end: { line: 1, utf16_column: 3 } },
      { id: 'two', kind: 'similar' as const, start: { line: 2, utf16_column: 0 }, end: { line: 2, utf16_column: 3 } },
    ];
    await act(async () => root.render(<CodeMirrorEditor initialContent={'one\ntwo'} language="text" onChange={() => {}} onSave={() => {}} focusRange={{ lineStart: 1, lineEnd: 1, nonce: 10, highlights }} />));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    const firstScrollCount = scroll.mock.calls.length;
    await act(async () => root.render(<CodeMirrorEditor initialContent={'one\ntwo'} language="text" onChange={() => {}} onSave={() => {}} focusRange={{ lineStart: 2, lineEnd: 2, nonce: 11, highlights }} />));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(scroll.mock.calls.length).toBeGreaterThan(firstScrollCount);
    expect(host.querySelector('[data-library-highlight-id="one"]')).not.toBeNull();
    expect(host.querySelector('[data-library-highlight-id="two"]')).not.toBeNull();
    act(() => root.unmount());
  });
});
