import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
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
  [`${CHUNKER_VERSION}\0${TOKENIZER_VERSION}`]: '48f7c6901ee51bb8b0a1a0434594cccb305806535a17b2de801a8fbc1c4fc9c7',
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
  assert.equal(CHUNKER_VERSION, 'paragraph-window-v1');
  assert.equal(TOKENIZER_VERSION, 'cl100k_base-js-tiktoken-1.0.21');
  assert.equal(
    deriveChunkId('doc-a', 'hash-a', 0),
    '7049e635dd2970be0301053fd578023448f3ca11ec456351b4f49349251238c8',
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
