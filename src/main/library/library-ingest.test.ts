import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { LibraryProgressEvent } from '../../shared/library';
import { createLibraryIngestor, ingestLibraryDocuments } from './library-ingest';
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
  assert.deepEqual([...handlers.keys()], ['library:ingest', 'library:rescan', 'library:list-documents'],
    'REACHABILITY:registerIpcHandlers:library:ingest');
});
