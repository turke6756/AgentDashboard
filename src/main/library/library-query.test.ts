import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeLibraryStore, insertLibraryChunk, openLibraryStore, queryLibrary, upsertLibraryDocument, type LibraryDocumentRow, type LibraryStore } from './library-store';

function document(id: string, trust: LibraryDocumentRow['trust'] = 'cleared'): LibraryDocumentRow {
  return { id, type: 'md', title: `${id} title`, created: '2026-09-06', topics_json: '["query"]', trust,
    source_rel_path: `.lares/library/cleared/${id}.md`, reader_rel_path: `.lares/library/cleared/${id}.md`,
    source_hash: `${id}-hash`, size: 100, page_count: null, provider: null, agent_id: null, summary: null,
    status: 'ready', error_reason: null, index_generation: 0, chunker_version: 'library-chunker-v1', tokenizer_version: 'unicode-codepoint-v1', attempt_count: 0 };
}

function addText(store: LibraryStore, doc: LibraryDocumentRow, id: string, ordinal: number, content: string, start: number): void {
  upsertLibraryDocument(store, doc);
  insertLibraryChunk(store, { id, document_id: doc.id, ordinal, content, content_char_length: content.length, embedding: null,
    locator: { version: 1, kind: 'text', encoding: 'utf-8', line_start: 1, line_end: 2,
      start: { line: 1, utf16_column: start }, end: { line: 2, utf16_column: 0 },
      canonical_char_start: start, canonical_char_end: start + content.length,
      quote: { exact: content, prefix: '', suffix: '' } } });
}

(async () => {
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-library-query-'));
const store = openLibraryStore(root);
try {
  addText(store, document('trusted'), 'trusted-1', 0, 'needle and needle\nnext', 0);
  addText(store, document('untrusted', 'untrusted'), 'untrusted-1', 0, 'needle secret', 0);
  let embedCalls = 0;
  const embedText = async () => { embedCalls += 1; return new Float32Array(384); };
  const defaultResult = await queryLibrary(store, { query: 'needle', mode: 'keyword', limit: 1, highlight_doc_id: 'trusted' }, { embedText });
  assert.strictEqual(defaultResult.excerpts.length, 1);
  assert.deepStrictEqual(defaultResult.excerpts[0].keyword_matches.map((m) => [m.chunk_char_start, m.chunk_char_end]), [[0, 6], [11, 17]]);
  assert.strictEqual(defaultResult.excerpts[0].citation, '.lares/library/cleared/trusted.md:1-2');
  assert.strictEqual(defaultResult.document_highlights?.spans.length, 2, 'highlights are independent of result limit');
  assert.ok(defaultResult.excerpts.every((excerpt) => excerpt.trust !== 'untrusted'));
  const included = await queryLibrary(store, { query: 'needle', mode: 'keyword', include_untrusted: true }, { embedText });
  assert.ok(included.excerpts.some((excerpt) => excerpt.trust === 'untrusted'));
  addText(store, document('punctuation-doc'), 'punctuation-1', 0, 'zebra-quartz-lantern-2026 says alpha"beta', 0);
  const hyphenated = await queryLibrary(store, { query: 'zebra-quartz-lantern-2026', mode: 'keyword' }, { embedText });
  assert.strictEqual(hyphenated.excerpts[0]?.chunk_id, 'punctuation-1');
  const quoted = await queryLibrary(store, { query: 'alpha"beta', mode: 'keyword' }, { embedText });
  assert.strictEqual(quoted.excerpts[0]?.chunk_id, 'punctuation-1');
  addText(store, document('overlap-doc'), 'overlap-a', 0, 'overlap window', 0);
  addText(store, document('overlap-doc'), 'overlap-b', 1, 'overlap window', 5);
  const overlap = await queryLibrary(store, { query: 'overlap', mode: 'keyword', doc_ids: ['overlap-doc'], highlight_doc_id: 'overlap-doc' }, { embedText });
  assert.strictEqual(overlap.excerpts.length, 1, 'overlapping result windows are deduplicated in rank order');
  assert.strictEqual(overlap.document_highlights?.spans.length, 2, 'result deduplication does not remove document highlights');
  const pdf = { ...document('pdf-doc'), type: 'pdf' as const, title: 'Manual\nTitle', source_rel_path: 'manual.pdf', reader_rel_path: 'manual.pdf', page_count: 4 };
  upsertLibraryDocument(store, pdf);
  insertLibraryChunk(store, { id: 'pdf-0', document_id: pdf.id, ordinal: 0, content: 'before needle after', content_char_length: 19, embedding: null,
    locator: { version: 1, kind: 'pdf', extraction: 'pdfium-page-text-v1', page_index: 3, page_number: 4,
      page_char_start: 20, page_char_end: 39, quote: { exact: 'before needle after', prefix: 'page prefix ', suffix: ' page suffix' } } });
  const pdfResult = await queryLibrary(store, { query: 'needle', mode: 'keyword', doc_ids: ['pdf-doc'], highlight_doc_id: 'pdf-doc' }, { embedText });
  assert.strictEqual(pdfResult.excerpts[0].citation, 'ManualTitle, p.4');
  assert.deepStrictEqual(pdfResult.document_highlights?.spans[0].source, {
    page_index: 3, selector: { exact: 'needle', prefix: 'page prefix before ', suffix: ' after page suffix' },
  });
  assert.strictEqual(embedCalls, 0, 'keyword-only queries must not start the embedder');
  await queryLibrary(store, { query: 'semantic', mode: 'semantic' }, { embedText });
  assert.strictEqual(embedCalls, 1, 'semantic query awaits one embedding');
  await queryLibrary(store, { query: 'hybrid', mode: 'hybrid' }, { embedText });
  assert.strictEqual(embedCalls, 2, 'hybrid query awaits one embedding');
  console.log('All 12 library query tests passed');
} finally {
  closeLibraryStore(store);
  fs.rmSync(root, { recursive: true, force: true });
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
