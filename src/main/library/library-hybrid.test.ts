import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { embedLibraryTexts, encodeLibraryEmbedding } from './library-embedder';
import {
  closeLibraryStore,
  insertLibraryChunk,
  openLibraryStore,
  queryLibrary,
  upsertLibraryDocument,
  type LibraryDocumentRow,
} from './library-store';

interface QualityCase { id: string; passage: string; query: string }

(async () => {
  const fixturePath = path.join(process.cwd(), 'examples', 'library-fixtures', 'hybrid-queries.json');
  const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as QualityCase[];
  assert.strictEqual(cases.length, 20);
  const modelRoot = path.join(process.cwd(), 'assets', 'models');
  const embedded = await embedLibraryTexts([
    ...cases.map((item) => item.passage),
    ...cases.map((item) => item.query),
  ], modelRoot);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-library-hybrid-'));
  const store = openLibraryStore(root);
  try {
    cases.forEach((item, index) => {
      const document: LibraryDocumentRow = {
        id: item.id, type: 'md', title: item.id, created: '2026-09-06', topics_json: '[]', trust: 'cleared',
        source_rel_path: `manuals/${item.id}.md`, reader_rel_path: `manuals/${item.id}.md`, source_hash: `${item.id}-hash`,
        size: item.passage.length, page_count: null, provider: null, agent_id: null, summary: null, status: 'ready',
        error_reason: null, index_generation: 0, chunker_version: 'paragraph-window-v1', tokenizer_version: 'cl100k_base-js-tiktoken-1.0.21',
      };
      upsertLibraryDocument(store, document);
      insertLibraryChunk(store, {
        id: `${item.id}-0`, document_id: item.id, ordinal: 0, content: item.passage,
        content_char_length: item.passage.length, embedding: encodeLibraryEmbedding(embedded.vectors[index]),
        locator: { version: 1, kind: 'text', encoding: 'utf-8', line_start: 1, line_end: 1,
          start: { line: 1, utf16_column: 0 }, end: { line: 1, utf16_column: item.passage.length },
          canonical_char_start: 0, canonical_char_end: item.passage.length,
          quote: { exact: item.passage, prefix: '', suffix: '' } },
      });
    });

    let hits = 0;
    const misses: string[] = [];
    cases.forEach((item, index) => {
      const query = item.query.replace(/[?]/g, '');
      const result = queryLibrary(store, {
        query, mode: 'hybrid', limit: 3, query_embedding: embedded.vectors[cases.length + index],
      });
      if (result.excerpts.some((excerpt) => excerpt.doc_id === item.id)) hits += 1;
      else misses.push(`${item.id}->${result.excerpts.map((excerpt) => excerpt.doc_id).join(',')}`);
      assert.ok(result.excerpts.every((excerpt) => excerpt.scores.semantic_rank !== null),
        'REACHABILITY:queryLibrary:hybrid every hybrid candidate must carry a semantic rank');
    });
    assert.ok(hits >= 18, `REACHABILITY:queryLibrary:hybrid expected at least 18/20 top-3 hits, observed ${hits}/20 (${misses.join('; ')})`);

    const highlighted = queryLibrary(store, {
      query: cases[0].query.replace(/[?]/g, ''), mode: 'hybrid', limit: 3,
      query_embedding: embedded.vectors[cases.length], highlight_doc_id: cases[0].id,
    });
    assert.strictEqual(highlighted.excerpts.find((excerpt) => excerpt.doc_id === cases[0].id)?.similar_passage?.kind, 'similar');
    assert.ok(highlighted.document_highlights?.spans.some((span) => span.kind === 'similar'));
    console.log(`LIBRARY_HYBRID_QUALITY ${hits} of 20 expected passages in top-3`);
    console.log('All 4 library hybrid tests passed');
  } finally {
    closeLibraryStore(store);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
