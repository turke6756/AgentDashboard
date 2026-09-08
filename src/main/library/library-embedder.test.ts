import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import { embedLibraryTexts, LIBRARY_EMBEDDING_DIMENSIONS, shutdownLibraryEmbedder } from './library-embedder';
import { createLibraryIngestor } from './library-ingest';
import { closeLibraryStore, getLibraryDocument, openLibraryStore } from './library-store';

(async () => {
  if (app) await app.whenReady();
  const modelRoot = path.join(process.cwd(), 'assets', 'models');
  const tenPages = Array.from({ length: 10 }, (_, page) =>
    `Page ${page + 1}. A local workspace library retrieves passages without sending private documents over the network.`,
  );
  const started = performance.now();
  const batch = await embedLibraryTexts(tenPages, modelRoot);
  const totalMs = performance.now() - started;
  assert.strictEqual(batch.vectors.length, 10);
  assert.ok(batch.vectors.every((vector) => vector.length === LIBRARY_EMBEDDING_DIMENSIONS));
  assert.ok(batch.load_ms < 2_000, `offline model load must stay under 2s, observed ${batch.load_ms.toFixed(2)}ms`);
  assert.ok(totalMs < 5_000, `10-page embedding must stay under 5s, observed ${totalMs.toFixed(2)}ms`);
  assert.ok(batch.vectors.every((vector) => vector.every(Number.isFinite)));
  const secondBatch = await embedLibraryTexts(['The same helper serves a second batch.'], modelRoot);
  assert.strictEqual(secondBatch.vectors.length, 1);
  const failureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-library-embed-failure-'));
  const source = path.join(failureRoot, 'manual.txt');
  fs.writeFileSync(source, 'keyword survives embedding failure');
  const store = openLibraryStore(failureRoot);
  try {
    await assert.rejects(createLibraryIngestor({
      workspaceRoot: failureRoot,
      store,
      embedTexts: async () => { throw new Error('fixture embed failure'); },
    })({ source_path: source, trigger: 'add' }), /fixture embed failure/);
    const document = store.database.prepare(`SELECT id FROM library_documents LIMIT 1`).get() as { id: string };
    assert.strictEqual(getLibraryDocument(store, document.id)?.status, 'error');
    const keyword = store.database.prepare(`
      SELECT c.content FROM library_chunks_fts f
      JOIN library_chunks c ON c.rowid = f.rowid
      WHERE library_chunks_fts MATCH 'keyword'
    `).get() as { content: string } | undefined;
    assert.strictEqual(keyword?.content, 'keyword survives embedding failure');
  } finally {
    closeLibraryStore(store);
    fs.rmSync(failureRoot, { recursive: true, force: true });
  }
  console.log(`LIBRARY_EMBEDDER_OFFLINE load=${batch.load_ms.toFixed(2)}ms total_10_pages=${totalMs.toFixed(2)}ms dimensions=${LIBRARY_EMBEDDING_DIMENSIONS}`);
  console.log('All 8 library embedder tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await shutdownLibraryEmbedder();
  app?.quit();
});
