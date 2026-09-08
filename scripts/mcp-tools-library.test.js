const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_RESULT_BYTE_CAP,
  LIST_RESULT_BYTE_CAP,
  QUERY_RESULT_BYTE_CAP,
  getLibraryToolDefinitions,
  handleLibraryToolCall,
} = require('./mcp-tools-library');

(async () => {
  const names = getLibraryToolDefinitions().map((definition) => definition.name);
  assert.deepStrictEqual(names, ['list_workspace_library', 'query_workspace_library']);
  assert.strictEqual(DEFAULT_RESULT_BYTE_CAP, LIST_RESULT_BYTE_CAP);

  const calls = [];
  const corpus = Array.from({ length: 8 }, (_, index) => ({
    chunk_id: `chunk-${index}`, doc_id: `doc-${index}`, document_hash: `hash-${index}`,
    title: `Document ${index}`, type: 'md', trust: index === 7 ? 'untrusted' : 'cleared',
    source_rel_path: `.lares/library/cleared/doc-${index}.md`,
    quote: index === 0
      ? `00000needle-0${'0'.repeat(1187)}`
      : index === 1
        ? `${'a'.repeat(121)}😀${'b'.repeat(116)}needle${'c'.repeat(116)}😀${'d'.repeat(836)}`
        : index === 2
          ? `START${'2'.repeat(595)}MIDDLE${'2'.repeat(595)}`
          : `${String(index).repeat(850)}needle-${index}${String(index).repeat(342)}`,
    citation: `.lares/library/cleared/doc-${index}.md:1-4`,
    keyword_matches: index === 2 ? [] : [{
      kind: 'exact',
      chunk_char_start: index === 0 ? 5 : index === 1 ? 239 : 850,
      chunk_char_end: index === 0 ? 13 : index === 1 ? 245 : 858,
      text: `needle-${index}`,
    }],
    similar_passage: index === 2 ? { kind: 'similar', chunk_char_start: 0, chunk_char_end: 1201 } : null,
    locator: { kind: 'text', line_start: 1, line_end: 4 }, scores: { fused_score: 1 },
  }));
  const queryResult = await handleLibraryToolCall('query_workspace_library', {
    query: 'needle', limit: 99, include_untrusted: true,
  }, async (method, route, body) => {
    calls.push({ method, route, body });
    return { excerpts: corpus };
  });
  assert.deepStrictEqual(calls, [{ method: 'POST', route: '/api/library/query', body: {
    query: 'needle', mode: undefined, doc_ids: undefined, types: undefined, topics: undefined,
    limit: 8, include_untrusted: true,
  } }]);
  const text = queryResult.content[0].text;
  assert.ok(Buffer.byteLength(text, 'utf8') <= QUERY_RESULT_BYTE_CAP);
  assert.ok(text.startsWith('[BEGIN UNTRUSTED LIBRARY DATA]'));
  assert.ok(text.includes(corpus[0].citation), 'citation survives quote truncation');
  assert.ok(!text.includes('"locator"') && !text.includes('"scores"'), 'renderer-only fields are omitted');
  const jsonText = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const projected = JSON.parse(jsonText);
  assert.ok(projected.excerpts.length >= 3, 'fair query cap retains multiple independently citable excerpts');
  assert.deepStrictEqual(projected.excerpts.map((excerpt) => excerpt.chunk_id), corpus.slice(0, projected.excerpts.length).map((excerpt) => excerpt.chunk_id));
  for (const [index, excerpt] of projected.excerpts.entries()) {
    assert.ok(excerpt.quote.length > 0, `excerpt ${index} has a non-empty quote`);
    assert.strictEqual(excerpt.citation, corpus[index].citation, `excerpt ${index} keeps its citation`);
    assert.ok(!/[\uD800-\uDBFF]$/.test(excerpt.quote) && !/^[\uDC00-\uDFFF]/.test(excerpt.quote), 'no quote splits a surrogate pair');
  }
  assert.ok(projected.excerpts[0].quote.startsWith('00000') && projected.excerpts[0].quote.endsWith('...'), 'REACHABILITY:library:mcp-window near-start match has only a trailing omission marker');
  assert.ok(projected.excerpts[1].quote.includes('😀') && projected.excerpts[1].quote.includes('needle'), 'astral characters at both cut regions remain intact');
  assert.ok(projected.excerpts[2].quote.startsWith('...') && projected.excerpts[2].quote.endsWith('...'), 'semantic-only evidence selects a middle window');
  assert.ok(projected.excerpts[2].quote.includes('MIDDLE') && !projected.excerpts[2].quote.includes('START'), 'semantic-only quote comes from the span midpoint, not character zero');
  assert.ok(projected.excerpts[3].quote.includes('needle-3'), 'REACHABILITY:library:mcp-window deep keyword match remains visible');

  const metadataHeavy = corpus.map((excerpt, index) => ({
    ...excerpt,
    chunk_id: `metadata-${index}`,
    title: 'metadata'.repeat(240),
  }));
  const metadataResult = await handleLibraryToolCall('query_workspace_library', {
    query: 'needle', limit: 8, include_untrusted: false,
  }, async () => ({ excerpts: metadataHeavy }));
  const metadataText = metadataResult.content[0].text;
  const metadataJson = JSON.parse(metadataText.slice(metadataText.indexOf('{'), metadataText.lastIndexOf('}') + 1));
  assert.ok(metadataJson.excerpts.length < metadataHeavy.length, 'metadata overflow drops whole lowest-ranked rows');
  assert.ok(metadataJson.excerpts.every((excerpt) => excerpt.citation && typeof excerpt.quote === 'string'), 'admitted metadata is complete');

  const listCalls = [];
  const listResult = await handleLibraryToolCall('list_workspace_library', { types: ['pdf'] }, async (method, route, body) => {
    listCalls.push({ method, route, body });
    return { documents: Array.from({ length: 20 }, (_, index) => ({ id: index, title: 'x'.repeat(300) })) };
  });
  assert.ok(Buffer.byteLength(listResult.content[0].text, 'utf8') <= LIST_RESULT_BYTE_CAP);
  assert.deepStrictEqual(listCalls[0], { method: 'POST', route: '/api/library/list', body: {
    types: ['pdf'], topics: undefined, include_untrusted: false,
  } });

  const source = fs.readFileSync(path.join(__dirname, 'mcp-tools-library.js'), 'utf8');
  assert.ok(!/better-sqlite3|library\.db/.test(source), 'proxy must not open the Library database');
  console.log('All 18 library MCP multi-excerpt/window tests passed');
})().catch((error) => { console.error(error); process.exit(1); });
