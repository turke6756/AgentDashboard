import { beforeEach, describe, expect, it } from 'vitest';
import type { ShelfRow } from '../../../shared/library';
import { buildMatchPreview, groupLibraryResults, normalizeMatchRanges } from './library-result-groups';
import type { LibraryQueryExcerptView } from './library-result-navigation';

const document = (id: string): ShelfRow => ({ id, type: 'research', title: id, created: '', topics_json: '[]', trust: 'cleared', source_rel_path: `${id}.md`, reader_rel_path: `${id}.md`, source_hash: `hash-${id}`, size: 1, page_count: null, provider: null, agent_id: null, summary: null, status: 'ready', error_reason: null, index_generation: 1, chunker_version: 'v1', tokenizer_version: 'v1', shelf_status: 'ready' });
const excerpt = (docId: string, chunkId: string, quote = 'alpha punctuation, beta'): LibraryQueryExcerptView => ({ chunk_id: chunkId, doc_id: docId, document_hash: `hash-${docId}`, title: docId, type: 'research', trust: 'cleared', source_rel_path: `${docId}.md`, reader_rel_path: `${docId}.md`, quote, citation: `${docId}.md:1`, locator: { version: 1, kind: 'text', encoding: 'utf-8', line_start: 1, line_end: 1, start: { line: 1, utf16_column: 0 }, end: { line: 1, utf16_column: quote.length }, canonical_char_start: 0, canonical_char_end: quote.length, quote: { exact: quote, prefix: '', suffix: '' } }, keyword_matches: [], similar_passage: { kind: 'similar', chunk_char_start: 0, chunk_char_end: quote.length }, scores: { keyword_rank: null, semantic_rank: 1, semantic_score: 0.8, fused_score: 0.1 } });

describe('groupLibraryResults', () => {
  beforeEach(() => undefined);
  it('preserves first-response order, best excerpt, returned counts, and reports orphans', () => {
    const a1 = excerpt('a', 'a1'); const b1 = excerpt('b', 'b1'); const a2 = excerpt('a', 'a2');
    const grouped = groupLibraryResults([document('a'), document('b')], [b1, a1, a2, excerpt('gone', 'x')]);
    expect(grouped.groups.map((group) => group.document.id), 'REACHABILITY:groupLibraryResults production constructor must group results').toEqual(['b', 'a']);
    expect(grouped.groups[1]).toMatchObject({ bestExcerpt: a1, matchCount: 2, excerpts: [a1, a2] });
    expect(grouped.orphanDocumentIds).toEqual(['gone']);
    expect(grouped.groups.length).toBe(2);
  });
});

describe('preview ranges', () => {
  it('rejects invalid offsets and sorts/merges overlap while retaining repeated terms and UTF-16 offsets', () => {
    const text = '😀 alpha, alpha!';
    expect(normalizeMatchRanges([
      { chunk_char_start: 10, chunk_char_end: 15 }, { chunk_char_start: 3, chunk_char_end: 8 },
      { chunk_char_start: 7, chunk_char_end: 11 }, { chunk_char_start: -1, chunk_char_end: 2 },
      { chunk_char_start: 99, chunk_char_end: 100 }, { chunk_char_start: 4.5, chunk_char_end: 6 },
    ], text.length)).toEqual([{ start: 3, end: 15 }]);
  });

  it('centres a deep exact match, adjusts its mark, and keeps ellipses unmarked', () => {
    const quote = `${'x'.repeat(800)}NEEDLE${'z'.repeat(300)}`;
    const segments = buildMatchPreview(quote, [{ start: 800, end: 806 }]);
    expect(segments.map((segment) => segment.text).join('')).toContain('NEEDLE');
    expect(segments.find((segment) => segment.marked)?.text).toBe('NEEDLE');
    expect(segments[0]).toEqual({ text: '…', marked: false });
    expect(segments.at(-1)).toEqual({ text: '…', marked: false });
    expect(segments.reduce((sum, segment) => sum + (segment.text === '…' ? 0 : segment.text.length), 0)).toBe(220);
  });

  it('starts semantic-only previews at zero without manufacturing marks or HTML', () => {
    const quote = '<img src=x onerror=alert(1)> semantic';
    expect(buildMatchPreview(quote, [])).toEqual([{ text: quote, marked: false }]);
  });
});
