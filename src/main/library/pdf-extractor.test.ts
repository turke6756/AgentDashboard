import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { chunkDocument } from './library-chunker';
import { extractPdf } from './pdf-extractor';

const FIXTURE = path.resolve('examples/pdf-fixtures/selectable-text.pdf');

test('real PDFium extraction returns reviewed selectable-text content', async () => {
  const extracted = await extractPdf(FIXTURE);
  assert.equal(extracted.page_count, 1);
  assert.deepEqual(extracted.pages, [{
    page_index: 0,
    text: 'The quick brown fox jumps over the lazy dog. Selectable text fixture for the Lares dual PDF viewer.\r\nSecond paragraph: anchors need prefix and suffix context.',
  }]);
  const first = chunkDocument({
    document_id: 'selectable-pdf', source_hash: 'fixture-hash', kind: 'pdf', pages: extracted.pages,
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].locator.kind, 'pdf');
  if (first[0].locator.kind === 'pdf') {
    assert.deepEqual([first[0].locator.page_char_start, first[0].locator.page_char_end], [0, 157]);
  }
});
