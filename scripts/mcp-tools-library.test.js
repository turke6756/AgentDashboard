const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DEFAULT_RESULT_BYTE_CAP, getLibraryToolDefinitions, handleLibraryToolCall } = require('./mcp-tools-library');

(async () => {
  const names = getLibraryToolDefinitions().map((definition) => definition.name);
  assert.deepStrictEqual(names, ['list_workspace_library', 'query_workspace_library']);

  const calls = [];
  const corpus = Array.from({ length: 50 }, (_, index) => ({
    chunk_id: `chunk-${index}`, doc_id: `doc-${index}`, document_hash: `hash-${index}`,
    title: `Document ${index}`, type: 'md', trust: index === 49 ? 'untrusted' : 'cleared',
    source_rel_path: `.lares/library/cleared/doc-${index}.md`, quote: `😀${'needle '.repeat(120)}`,
    citation: `.lares/library/cleared/doc-${index}.md:1-4`,
    keyword_matches: [{ kind: 'exact', chunk_char_start: 2, chunk_char_end: 8, text: 'needle' }],
    similar_passage: null,
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
  assert.ok(Buffer.byteLength(text, 'utf8') <= DEFAULT_RESULT_BYTE_CAP);
  assert.ok(text.startsWith('[BEGIN UNTRUSTED LIBRARY DATA]'));
  assert.ok(text.includes(corpus[0].citation), 'citation survives quote truncation');
  assert.ok(!text.includes('"locator"') && !text.includes('"scores"'), 'renderer-only fields are omitted');
  const jsonText = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const projected = JSON.parse(jsonText);
  const finalQuote = projected.excerpts[projected.excerpts.length - 1].quote;
  assert.ok(!/[\uD800-\uDBFF]$/.test(finalQuote), 'UTF-8 truncation never leaves a split surrogate');

  const listCalls = [];
  await handleLibraryToolCall('list_workspace_library', { types: ['pdf'] }, async (method, route, body) => {
    listCalls.push({ method, route, body });
    return { documents: [] };
  });
  assert.deepStrictEqual(listCalls[0], { method: 'POST', route: '/api/library/list', body: {
    types: ['pdf'], topics: undefined, include_untrusted: false,
  } });

  const source = fs.readFileSync(path.join(__dirname, 'mcp-tools-library.js'), 'utf8');
  assert.ok(!/better-sqlite3|library\.db/.test(source), 'proxy must not open the Library database');
  console.log('All 8 library MCP tool tests passed');
})().catch((error) => { console.error(error); process.exit(1); });
