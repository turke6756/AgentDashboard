import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractPdf } from '../../../main/library/pdf-extractor';
import { makeTextQuoteSelector } from '../../../main/library/library-chunker';
import { resolveLibraryPdfSelector } from './pdf-comment-anchors';
import { normalizePageTextContent } from './pdf-text-geometry';

const opened: Array<{ destroy(): Promise<void> }> = [];

async function pdfJsPage(filePath: string) {
  Object.assign(globalThis, {
    DOMMatrix: class DOMMatrix {},
    ImageData: class ImageData {},
    Path2D: class Path2D {},
  });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(filePath)) });
  const document = await task.promise;
  opened.push(document);
  const page = await document.getPage(1);
  const content = await page.getTextContent();
  const [x0, y0, x1, y1] = page.view;
  return normalizePageTextContent(0, content.items, Math.abs(x1 - x0), Math.abs(y1 - y0));
}

afterEach(async () => {
  while (opened.length) await opened.pop()?.destroy();
});

describe('real PDFium to real pdf.js selector compatibility', () => {
  it('resolves selectable-text.pdf exactly with geometry and ordered endpoints', async () => {
    const fixture = path.resolve('examples/pdf-fixtures/selectable-text.pdf');
    const pdfium = await extractPdf(fixture);
    const exactEnd = pdfium.pages[0].text.indexOf('.') + 1;
    const selector = makeTextQuoteSelector(pdfium.pages[0].text, 0, exactEnd);
    const normalized = await pdfJsPage(fixture);
    const result = resolveLibraryPdfSelector(normalized, selector);
    expect(result.status).toBe('exact');
    expect(result.rects.length).toBeGreaterThan(0);
    expect(result.start).toBeDefined();
    expect(result.end).toBeDefined();
    expect(result.start!.itemIndex).toBeLessThanOrEqual(result.end!.itemIndex);
    if (result.start!.itemIndex === result.end!.itemIndex) {
      expect(result.start!.charOffset).toBeLessThan(result.end!.charOffset);
    }
  });

  it('ligature divergence is exact or page-only, never a wrong fuzzy span', async () => {
    const fixture = path.resolve('examples/pdf-fixtures/ligature.pdf');
    const pdfium = await extractPdf(fixture);
    const text = pdfium.pages[0]?.text ?? '';
    const end = Math.min(text.length, Math.max(1, text.indexOf(' ') > 0 ? text.indexOf(' ') : text.length));
    const result = resolveLibraryPdfSelector(await pdfJsPage(fixture), makeTextQuoteSelector(text, 0, end));
    expect(['exact', 'ambiguous', 'unresolved']).toContain(result.status);
    if (result.status !== 'exact') expect(result.rects).toEqual([]);
  });
});
