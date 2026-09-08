import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { LibraryProgressEvent } from '../../shared/library';
import { createLibraryIngestor, ingestLibraryDocuments } from './library-ingest';
import { LIBRARY_EMBEDDING_DIMENSIONS } from './library-embedder';
import { registerProductionLibraryIpc } from './library-ipc';
import { closeLibraryStore, listLibraryChunks, openLibraryStore } from './library-store';

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-ingest-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'a.txt'), 'Alpha source. '.repeat(80));
  fs.writeFileSync(path.join(root, 'docs', 'b.md'), '# Beta\n\nBeta source. '.repeat(60));
  fs.copyFileSync(path.resolve('examples/pdf-fixtures/selectable-text.pdf'), path.join(root, 'docs', 'selectable-text.pdf'));
  fs.copyFileSync(path.resolve('examples/library-fixtures/deterministic.docx'), path.join(root, 'docs', 'deterministic.docx'));
  return root;
}

function fakeEmbeddings(texts: string[]) {
  return Promise.resolve({
    vectors: texts.map(() => new Float32Array(LIBRARY_EMBEDDING_DIMENSIONS)),
    load_ms: 0,
    embed_ms: 0,
  });
}

test('resolved report folders derive trust and research type unless the request is explicit', async () => {
  const root = workspace();
  const sources = {
    inbox: path.join(root, '.lares', 'library', 'inbox', 'nested', 'inbox.md'),
    cleared: path.join(root, '.lares', 'library', 'cleared', 'cleared.md'),
    other: path.join(root, 'docs', 'b.md'),
    explicit: path.join(root, '.lares', 'library', 'inbox', 'explicit.md'),
  };
  for (const source of Object.values(sources)) {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    if (!fs.existsSync(source)) fs.writeFileSync(source, '# Report\n\nBody.');
  }
  const store = openLibraryStore(root);
  try {
    const ingest = createLibraryIngestor({ workspaceRoot: root, store, embedTexts: fakeEmbeddings });
    const inbox = await ingest({ source_path: sources.inbox, trigger: 'report-arrival' });
    const cleared = await ingest({ source_path: sources.cleared, trigger: 'report-arrival' });
    const other = await ingest({ source_path: sources.other, trigger: 'add' });
    const explicit = await ingest({
      source_path: sources.explicit,
      trigger: 'report-arrival',
      type: 'note',
      trust: 'user-trusted',
    });

    assert.deepEqual([inbox.document.type, inbox.document.trust], ['research', 'untrusted'],
      'REACHABILITY:ingest:trust-from-folder');
    assert.deepEqual([cleared.document.type, cleared.document.trust], ['research', 'cleared']);
    assert.deepEqual([other.document.type, other.document.trust], ['md', 'user-trusted']);
    assert.deepEqual([explicit.document.type, explicit.document.trust], ['note', 'user-trusted']);
  } finally { closeLibraryStore(store); }
});

test('fresh stores and shuffled enumeration produce identical chunk ids', async () => {
  const roots = [workspace(), workspace()];
  const ids: string[][] = [];
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    const store = openLibraryStore(root);
    try {
      const paths = ['docs/a.txt', 'docs/b.md', 'docs/selectable-text.pdf', 'docs/deterministic.docx']
        .map((rel) => path.join(root, rel));
      if (index) paths.reverse();
      await ingestLibraryDocuments({ workspaceRoot: root, store }, paths.map((source_path) => ({
        source_path, trigger: 'add' as const,
      })));
      ids.push(listLibraryChunks(store, { include_untrusted: true }).map((chunk) => chunk.id));
      const counts = store.database.prepare(`
        SELECT d.type, count(*) AS count FROM library_chunks c
        JOIN library_documents d ON d.id = c.document_id
        WHERE d.type IN ('pdf', 'docx') GROUP BY d.type ORDER BY d.type
      `).all() as Array<{ type: string; count: number }>;
      assert.deepEqual(counts, [{ type: 'docx', count: 1 }, { type: 'pdf', count: 1 }]);
    } finally { closeLibraryStore(store); }
  }
  assert.deepEqual(ids[0], ids[1]);
});

test('rescan reuses unchanged rows and invalidates changed source rows', async () => {
  const root = workspace();
  const source = path.join(root, 'docs', 'a.txt');
  const store = openLibraryStore(root);
  try {
    const ingest = createLibraryIngestor({ workspaceRoot: root, store });
    const first = await ingest({ source_path: source, trigger: 'add' });
    const unchanged = await ingest({ source_path: source, trigger: 'rescan' });
    assert.equal(unchanged.reused, true);
    assert.deepEqual(unchanged.chunk_ids, first.chunk_ids);
    fs.appendFileSync(source, 'changed');
    const changed = await ingest({ source_path: source, trigger: 'rescan' });
    assert.equal(changed.reused, false);
    assert.notDeepEqual(changed.chunk_ids, first.chunk_ids);
    const current = new Set(listLibraryChunks(store, { include_untrusted: true }).map((chunk) => chunk.id));
    assert.ok(first.chunk_ids.every((id) => !current.has(id)));
  } finally { closeLibraryStore(store); }
});

test('report-arrival reuses unchanged ready rows without embedding while user ingest still reindexes', async () => {
  const root = workspace();
  const source = path.join(root, '.lares', 'library', 'inbox', 'arrival.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '# Arrival\n\nUnchanged report content. '.repeat(20));
  const store = openLibraryStore(root);
  let embedCalls = 0;
  const embedTexts = async (texts: string[]) => {
    embedCalls += 1;
    return fakeEmbeddings(texts);
  };
  try {
    const ingest = createLibraryIngestor({ workspaceRoot: root, store, embedTexts });
    const first = await ingest({ source_path: source, trigger: 'report-arrival' });
    const unchanged = await ingest({ source_path: source, trigger: 'report-arrival' });
    assert.equal(unchanged.reused, true);
    assert.deepEqual(unchanged.chunk_ids, first.chunk_ids);
    assert.equal(embedCalls, 1);

    const userIngest = await ingest({ source_path: source, trigger: 'drop' });
    assert.equal(userIngest.reused, false);
    assert.equal(embedCalls, 2);
  } finally { closeLibraryStore(store); }
});

test('all explicit triggers use the visible state machine', async () => {
  for (const trigger of ['report-arrival', 'add', 'drop', 'rescan'] as const) {
    const root = workspace();
    const store = openLibraryStore(root);
    const events: LibraryProgressEvent[] = [];
    try {
      await createLibraryIngestor({ workspaceRoot: root, store, publish: (event) => events.push(event) })({
        source_path: path.join(root, 'docs', 'b.md'), trigger,
      });
      assert.deepEqual(events.map((event) => event.status), ['queued', 'extracting', 'chunking', 'embedding', 'ready']);
      assert.ok(events.every((event) => event.source_rel_path === 'docs/b.md'));
    } finally { closeLibraryStore(store); }
  }
});

test('production IPC entry registers ingest, rescan, list, and progress-capable handlers', () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  registerProductionLibraryIpc(
    { handle: (channel, listener) => { handlers.set(channel, listener); } },
    () => null,
    () => undefined,
  );
  const registered = new Set(handlers.keys());
  for (const channel of ['library:ingest', 'library:rescan', 'library:list-documents', 'library:query', 'library:save-note']) {
    assert.ok(registered.has(channel), `REACHABILITY:registerIpcHandlers:library:ingest missing ${channel}`);
  }
});

test('report-arrival leaves an unchanged error row alone; rescan remains the retry path', async () => {
  const root = workspace();
  const source = path.join(root, '.lares', 'library', 'inbox', 'flaky.md');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '# Flaky\n\nContent that fails to embed once. '.repeat(10));
  const store = openLibraryStore(root);
  let fail = true;
  let embedCalls = 0;
  const embedTexts = async (texts: string[]) => {
    embedCalls += 1;
    if (fail) throw new Error('embedder down');
    return fakeEmbeddings(texts);
  };
  try {
    const ingest = createLibraryIngestor({ workspaceRoot: root, store, embedTexts });
    await assert.rejects(ingest({ source_path: source, trigger: 'report-arrival' }), /embedder down/);
    fail = false;
    const skipped = await ingest({ source_path: source, trigger: 'report-arrival' });
    assert.equal(skipped.skipped_error, true);
    assert.equal(skipped.document.status, 'error');
    assert.equal(embedCalls, 1, 'the passive watcher must not re-run a known-failing ingest');
    const retried = await ingest({ source_path: source, trigger: 'rescan' });
    assert.equal(retried.document.status, 'ready');
    assert.equal(embedCalls, 2);
    fs.appendFileSync(source, ' changed');
    fail = true;
    await assert.rejects(ingest({ source_path: source, trigger: 'report-arrival' }), /embedder down/, 'changed content is always retried');
  } finally { closeLibraryStore(store); }
});
