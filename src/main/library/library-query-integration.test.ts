import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { closeLibraryStore, insertLibraryChunk, openLibraryStore, upsertLibraryDocument } from './library-store';
import { LIBRARY_CHANNELS, registerLibraryIpc } from './library-ipc';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-library-route-'));
const appData = path.join(root, 'appdata');
const workspacePath = path.join(root, 'workspace');
fs.mkdirSync(appData, { recursive: true });
fs.mkdirSync(workspacePath, { recursive: true });
process.env.APPDATA = appData;

const db = require('../database') as typeof import('../database');
const { registerLibraryRoutes } = require('../api-server') as typeof import('../api-server');

function request(body: unknown): import('http').IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]) as import('http').IncomingMessage;
  stream.headers = {};
  return stream;
}

(async () => {
  db.initDatabase();
  const workspace = db.createWorkspace({ title: 'Library route', path: workspacePath, pathType: 'windows' });
  const store = openLibraryStore(workspacePath);
  upsertLibraryDocument(store, {
    id: 'manual', type: 'md', title: 'Manual', created: '2026-09-06', topics_json: '[]', trust: 'cleared',
    source_rel_path: 'manual.md', reader_rel_path: 'manual.md', source_hash: 'hash', size: 12, page_count: null,
    provider: null, agent_id: null, summary: null, status: 'ready', error_reason: null, index_generation: 0,
    chunker_version: 'library-chunker-v1', tokenizer_version: 'unicode-codepoint-v1',
  });
  insertLibraryChunk(store, {
    id: 'manual-0', document_id: 'manual', ordinal: 0, content: 'needle', content_char_length: 6, embedding: null,
    locator: { version: 1, kind: 'text', encoding: 'utf-8', line_start: 1, line_end: 1,
      start: { line: 1, utf16_column: 0 }, end: { line: 1, utf16_column: 6 }, canonical_char_start: 0, canonical_char_end: 6,
      quote: { exact: 'needle', prefix: '', suffix: '' } },
  });
  upsertLibraryDocument(store, {
    id: 'secret', type: 'md', title: 'Secret', created: '2026-09-06', topics_json: '[]', trust: 'untrusted',
    source_rel_path: 'secret.md', reader_rel_path: 'secret.md', source_hash: 'secret-hash', size: 12, page_count: null,
    provider: null, agent_id: null, summary: null, status: 'ready', error_reason: null, index_generation: 0,
    chunker_version: 'library-chunker-v1', tokenizer_version: 'unicode-codepoint-v1',
  });
  insertLibraryChunk(store, {
    id: 'secret-0', document_id: 'secret', ordinal: 0, content: 'needle secret', content_char_length: 13, embedding: null,
    locator: { version: 1, kind: 'text', encoding: 'utf-8', line_start: 1, line_end: 1,
      start: { line: 1, utf16_column: 0 }, end: { line: 1, utf16_column: 13 }, canonical_char_start: 0, canonical_char_end: 13,
      quote: { exact: 'needle secret', prefix: '', suffix: '' } },
  });
  closeLibraryStore(store);

  const entered = await registerLibraryRoutes({
    method: 'POST', path: '/api/library/query', request: request({ query: 'needle', mode: 'keyword' }),
    capability: { agentId: 'worker-1', workspaceId: workspace.id, privilegeLane: 'worker' },
  });
  assert.ok(entered, 'REACHABILITY:api-server:library:query');
  assert.strictEqual((entered.value as any).excerpts[0].citation, 'manual.md:1-1');
  assert.ok((entered?.value as any).excerpts.every((excerpt: any) => excerpt.trust !== 'untrusted'));

  const handlers = new Map<string, (...args: any[]) => any>();
  registerLibraryIpc({ handle: (channel, listener) => handlers.set(channel, listener) },
    (id) => id === workspace.id ? workspace : null, () => {});
  const ipcResult = await handlers.get(LIBRARY_CHANNELS.query)?.({}, workspace.id, { query: 'needle', mode: 'keyword' });
  assert.ok(ipcResult.excerpts.every((excerpt: any) => excerpt.trust !== 'untrusted'));

  const libraryTools = require(path.join(process.cwd(), 'scripts', 'mcp-tools-library.js'));
  const mcpResult = await libraryTools.handleLibraryToolCall('query_workspace_library', { query: 'needle' },
    async (method: string, route: string, body: unknown) => (await registerLibraryRoutes({
      method, path: route, request: request(body), capability: { agentId: 'worker-1', workspaceId: workspace.id, privilegeLane: 'worker' },
    }))?.value);
  assert.ok(!mcpResult.content[0].text.includes('secret'), 'MCP default omits the untrusted fixture document');

  let denied: any;
  try {
    await registerLibraryRoutes({
      method: 'POST', path: '/api/library/query', request: request({ query: 'needle' }),
      capability: { agentId: 'legacy-1', workspaceId: workspace.id, privilegeLane: 'legacy' },
    });
  } catch (error) { denied = error; }
  assert.strictEqual(denied?.statusCode, 403);
  assert.strictEqual(denied?.code, 'library-read-grant-required');
  assert.strictEqual(await registerLibraryRoutes({ method: 'POST', path: '/api/other', request: request({}) }), undefined);
  console.log('All 8 library query integration tests passed');
})().finally(() => {
  db.closeDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
}).catch((error) => { console.error(error); process.exit(1); });
