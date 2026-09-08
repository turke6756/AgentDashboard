import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { registerLibraryRoutes } from '../api-server';
import { LIBRARY_CHANNELS, registerProductionLibraryIpc, resetLibraryBroadcastForTests } from './library-ipc';
import {
  closeLibraryStore,
  insertLibraryChunk,
  openLibraryStore,
  queryLibrary,
  upsertLibraryDocument,
  type LibraryStore,
} from './library-store';

function request(body: unknown): import('http').IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]) as import('http').IncomingMessage;
  stream.headers = {};
  return stream;
}

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-library-async-'));
  const store = openLibraryStore(root);
  upsertLibraryDocument(store, {
    id: 'doc', type: 'md', title: 'Document', created: '2026-09-08', topics_json: '[]', trust: 'cleared',
    source_rel_path: 'doc.md', reader_rel_path: 'doc.md', source_hash: 'hash', size: 6, page_count: null,
    provider: null, agent_id: null, summary: null, status: 'ready', error_reason: null, index_generation: 0,
    chunker_version: 'library-chunker-v1', tokenizer_version: 'unicode-codepoint-v1',
  });
  insertLibraryChunk(store, {
    id: 'chunk', document_id: 'doc', ordinal: 0, content: 'needle', content_char_length: 6, embedding: null,
    locator: { version: 1, kind: 'text', encoding: 'utf-8', line_start: 1, line_end: 1,
      start: { line: 1, utf16_column: 0 }, end: { line: 1, utf16_column: 6 },
      canonical_char_start: 0, canonical_char_end: 6, quote: { exact: 'needle', prefix: '', suffix: '' } },
  });
  closeLibraryStore(store);
  return root;
}

function workspaceRecord(root: string) {
  return {
    id: 'workspace', title: 'Workspace', description: '', path: root, pathType: 'windows' as const,
    defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: '',
  };
}

test('production IPC query yields to the main loop and awaits query completion', async () => {
  const root = workspace();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  try {
    registerProductionLibraryIpc(
      { handle: (channel, listener) => handlers.set(channel, listener) },
      (workspaceId) => workspaceId === 'workspace' ? { id: workspaceId, path: root } : null,
      () => undefined,
      undefined,
      async (store, args) => {
        await delayed;
        return queryLibrary(store, { ...args, mode: 'keyword' });
      },
    );
    const handler = handlers.get(LIBRARY_CHANNELS.query);
    assert.ok(handler, 'REACHABILITY:library:query-async production registration must expose library:query');
    let tickRan = false;
    setTimeout(() => { tickRan = true; release(); }, 0);
    const result = await handler!({}, 'workspace', { query: 'needle', mode: 'semantic' }) as Awaited<ReturnType<typeof queryLibrary>>;
    assert.equal(tickRan, true, 'REACHABILITY:library:query-async unresolved embedding must yield to the main loop');
    assert.equal(result.excerpts[0]?.chunk_id, 'chunk');
  } finally {
    resetLibraryBroadcastForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP route keeps its store open until async success and closes exactly once', async () => {
  const root = workspace();
  let opened: LibraryStore | undefined;
  let closeCalls = 0;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  try {
    const pending = registerLibraryRoutes({
      method: 'POST',
      path: '/api/library/query',
      request: request({ query: 'needle', mode: 'semantic' }),
      capability: { agentId: 'worker', workspaceId: 'workspace', privilegeLane: 'worker' },
    }, {
      getWorkspace: () => workspaceRecord(root),
      openStore: (workspaceRoot) => opened = openLibraryStore(workspaceRoot),
      closeStore: (store) => { closeCalls += 1; closeLibraryStore(store); },
      query: async (store, args) => {
        assert.equal(store.database.open, true);
        await delayed;
        assert.equal(store.database.open, true, 'REACHABILITY:library:query-route store stays open across await');
        return queryLibrary(store, { ...args, mode: 'keyword' });
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(opened?.database.open, true, 'REACHABILITY:library:query-route store remains open while query is pending');
    assert.equal(closeCalls, 0);
    release();
    const result = await pending;
    assert.equal((result?.value as any).excerpts[0]?.chunk_id, 'chunk');
    assert.equal(closeCalls, 1, 'REACHABILITY:library:query-route closes exactly once after settle');
    assert.equal(opened?.database.open, false);
  } finally {
    if (opened?.database.open) closeLibraryStore(opened);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP route closes exactly once after an async query rejection', async () => {
  const root = workspace();
  let closeCalls = 0;
  await assert.rejects(registerLibraryRoutes({
    method: 'POST',
    path: '/api/library/query',
    request: request({ query: 'needle', mode: 'semantic' }),
    capability: { agentId: 'worker', workspaceId: 'workspace', privilegeLane: 'worker' },
  }, {
    getWorkspace: () => workspaceRecord(root),
    openStore: openLibraryStore,
    closeStore: (store) => { closeCalls += 1; closeLibraryStore(store); },
    query: async () => { await Promise.resolve(); throw new Error('delayed query failure'); },
  }), /delayed query failure/);
  assert.equal(closeCalls, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
