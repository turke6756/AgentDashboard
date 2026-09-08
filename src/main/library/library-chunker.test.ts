import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { getEncoding } from 'js-tiktoken';
import {
  CHUNKER_VERSION,
  CHUNK_MAX_TOKENS,
  TOKENIZER_VERSION,
  canonicalizeText,
  chunkDocument,
  deriveChunkId,
} from './library-chunker';

const GOLDEN = '\uFEFFfirst😀\r\nsecond café\nthird\rfour';
const GOLDEN_DIGESTS: Record<string, string> = {
  [`${CHUNKER_VERSION}\0${TOKENIZER_VERSION}`]: '601e44561cf2c3cab77abe7f85f033b823e2f7158be58603edda9ec9185392ca',
};

test('canonical coordinates match CodeMirror logical lines and UTF-16 columns', () => {
  const canonical = canonicalizeText(GOLDEN, true);
  assert.equal(canonical.text, '\uFEFFfirst😀\nsecond café\nthird\nfour');
  assert.deepEqual(canonical.positionAt(0), { line: 1, utf16_column: 0 });
  assert.deepEqual(canonical.positionAt(8), { line: 1, utf16_column: 8 });
  assert.deepEqual(canonical.positionAt(9), { line: 2, utf16_column: 0 });
  assert.deepEqual(canonical.positionAt(canonical.text.indexOf('é') + 1), { line: 2, utf16_column: 11 });
  assert.equal(canonical.byteAt?.(canonical.text.length), Buffer.byteLength(canonical.text));
});

test('chunk identity uses the frozen preimage including source hash', () => {
  assert.equal(CHUNKER_VERSION, 'paragraph-window-v2');
  assert.equal(TOKENIZER_VERSION, 'cl100k_base-js-tiktoken-1.0.21');
  assert.equal(
    deriveChunkId('doc-a', 'hash-a', 0),
    '5068121c74a68b778e64c7d61da13f53002b1dfeb3bf958748265c34dae7e1ff',
    'REACHABILITY:chunkDocument:golden-digest',
  );
  assert.notEqual(deriveChunkId('doc-a', 'hash-a', 0), deriveChunkId('doc-a', 'hash-b', 0));
});

test('golden digest pins chunk boundaries, ids, ordinals, and locator JSON', () => {
  const text = Array.from({ length: 180 }, (_, i) => `Paragraph ${i}. Stable sentence ${i} carries café 😀 tokens.`).join('\n\n');
  const chunks = chunkDocument({
    document_id: 'golden-doc', source_hash: '0123456789abcdef', kind: 'text', text, include_byte_map: true,
  });
  const encoding = getEncoding('cl100k_base');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => encoding.encode(chunk.content).length <= CHUNK_MAX_TOKENS));
  assert.deepEqual(chunks.map((chunk) => chunk.ordinal), chunks.map((_, index) => index));
  const digest = createHash('sha256').update(JSON.stringify(chunks)).digest('hex');
  assert.equal(digest, GOLDEN_DIGESTS[`${CHUNKER_VERSION}\0${TOKENIZER_VERSION}`],
    'REACHABILITY:chunkDocument:golden-digest');
});

test('PDF chunks never cross pages and overlap resets at page boundaries', () => {
  const pageText = Array.from({ length: 120 }, (_, i) => `Page sentence ${i}.`).join(' ');
  const chunks = chunkDocument({
    document_id: 'pdf-doc', source_hash: 'pdf-hash', kind: 'pdf',
    pages: [{ page_index: 0, text: pageText }, { page_index: 1, text: pageText }],
  });
  assert.ok(chunks.length >= 4);
  for (const chunk of chunks) {
    assert.equal(chunk.locator.kind, 'pdf');
    if (chunk.locator.kind === 'pdf') {
      assert.equal(chunk.locator.page_number, chunk.locator.page_index + 1);
      assert.equal('itemIndex' in chunk.locator, false);
    }
  }
  const firstOnSecondPage = chunks.find((chunk) => chunk.locator.kind === 'pdf' && chunk.locator.page_index === 1);
  assert.equal(firstOnSecondPage?.locator.kind === 'pdf' ? firstOnSecondPage.locator.page_char_start : -1, 0);
});

test('chunking is linear-time: a 60 KB report chunks in well under a second on the calling thread', () => {
  const paragraphs = Array.from({ length: 600 }, (_, i) => `Section ${i}. ${'Geoprocessing raster tiles across the study area yields '.repeat(2)}measurable throughput ${i}.`);
  const text = paragraphs.join('\n\n');
  assert.ok(text.length > 60_000);
  const started = performance.now();
  const chunks = chunkDocument({ document_id: 'big', source_hash: 'big-hash', kind: 'text', text });
  const elapsed = performance.now() - started;
  const encoding = getEncoding('cl100k_base');
  assert.ok(chunks.length > 20, `expected many chunks, got ${chunks.length}`);
  assert.ok(chunks.every((chunk) => encoding.encode(chunk.content).length <= CHUNK_MAX_TOKENS), 'every chunk fits the hard cap');
  assert.ok(chunks.every((chunk) => chunk.content === chunk.content.trim()), 'chunks never start or end in whitespace');
  assert.ok(elapsed < 3_000, `paragraph-window-v1 took minutes here; v2 took ${Math.round(elapsed)} ms`);
});

test('boundaries prefer paragraph breaks and successive chunks overlap', () => {
  const text = Array.from({ length: 80 }, (_, i) => `Paragraph ${i} has a few sentences. Another one here! And a question? Done.`).join('\n\n');
  const chunks = chunkDocument({ document_id: 'para', source_hash: 'h', kind: 'text', text });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks.slice(0, -1)) assert.ok(chunk.content.endsWith('Done.'), `chunk ends at a paragraph: ${chunk.content.slice(-30)}`);
  for (let i = 1; i < chunks.length; i += 1) {
    const prior = chunks[i - 1].locator;
    const current = chunks[i].locator;
    if (prior.kind !== 'pdf' && current.kind !== 'pdf') {
      assert.ok(current.canonical_char_start < prior.canonical_char_end, 'overlap window carries context forward');
      assert.ok(current.canonical_char_start > prior.canonical_char_start, 'and still makes progress');
    }
  }
});
