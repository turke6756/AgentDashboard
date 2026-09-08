import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LIBRARY_EMBEDDING_DIMENSIONS } from './library-embedder';
import { LIBRARY_CHANNELS, registerProductionLibraryIpc } from './library-ipc';
import { LibraryRescanCoordinator } from './library-rescan-coordinator';
import { rescanLibraryReports, rescanLibraryReportsDetailed } from './library-rescan';
import { closeLibraryStore, listLibraryDocuments, openLibraryStore, upsertLibraryDocument } from './library-store';

test('rescan walks both report roots serially and is idempotent on an unchanged tree', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-library-rescan-'));
  const inbox = path.join(workspaceRoot, '.lares', 'library', 'inbox');
  const cleared = path.join(workspaceRoot, '.lares', 'library', 'cleared');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(cleared, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'alpha.md'), '# Alpha');
  fs.writeFileSync(path.join(cleared, 'beta.md'), '# Beta');
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  let active = 0;
  let maxActive = 0;
  let releaseFirst!: () => void;
  let markFirstEntered!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
  let embedCalls = 0;
  const embedTexts = async (texts: string[]) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    embedCalls += 1;
    if (embedCalls === 1) { markFirstEntered(); await firstGate; }
    active -= 1;
    return { vectors: texts.map(() => new Float32Array(LIBRARY_EMBEDDING_DIMENSIONS)), load_ms: 0, embed_ms: 0 };
  };

  const handlers = new Map<string, (...args: any[]) => unknown>();
  let opens = 0;
  let closes = 0;
  const coordinator = new LibraryRescanCoordinator({
    resolveWorkspace: (workspaceId) => workspaceId === 'workspace-1' ? { id: workspaceId, path: workspaceRoot } : null,
    openStore: (root) => { opens += 1; return openLibraryStore(root); },
    closeStore: (store) => { closes += 1; closeLibraryStore(store); },
    rescan: (deps) => rescanLibraryReportsDetailed({ ...deps, embedTexts }),
  });
  registerProductionLibraryIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    (workspaceId) => workspaceId === 'workspace-1' ? { id: workspaceId, path: workspaceRoot } : null,
    () => undefined,
    (deps) => rescanLibraryReports({ ...deps, embedTexts }),
    undefined,
    coordinator,
  );
  const handler = handlers.get(LIBRARY_CHANNELS.rescan);
  assert.ok(handler, 'REACHABILITY:library:rescan production registration missing');

  const firstPromise = handler({} as never, 'workspace-1');
  await firstEntered;
  const secondPromise = handler({} as never, 'workspace-1');
  await Promise.resolve();
  assert.equal(embedCalls, 1, 'a concurrent Rescan must wait behind the workspace ingest mutex');
  releaseFirst();
  const first = await firstPromise;
  assert.deepEqual(first, { scanned: 2, ingested: 2, skipped: 0, failed: 0 }, 'REACHABILITY:library:rescan did not walk and ingest both report roots');
  assert.equal(maxActive, 1, 'rescan ingests must be serial');

  const second = await secondPromise;
  assert.deepEqual(second, { scanned: 2, ingested: 0, skipped: 2, failed: 0 });
  assert.deepEqual({ opens, closes }, { opens: 2, closes: 2 }, 'each production coordinator run must pair one store open and close');

  const store = openLibraryStore(workspaceRoot);
  try {
    const stale = listLibraryDocuments(store, { include_untrusted: true })
      .find((row) => row.source_rel_path === '.lares/library/inbox/alpha.md');
    assert.ok(stale);
    upsertLibraryDocument(store, { ...stale, chunker_version: 'paragraph-window-v1' });
  } finally {
    closeLibraryStore(store);
  }
  const third = await handler({} as never, 'workspace-1');
  assert.deepEqual(third, { scanned: 2, ingested: 1, skipped: 1, failed: 0 }, 'Rescan must ingest a row whose chunker contract is stale');
});

test('automatic rescan honors the cap while manual rescan clears and retries from attempt one', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-library-rescan-error-'));
  const inbox = path.join(workspaceRoot, '.lares', 'library', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'retry.md'), '# Retry');
  const store = openLibraryStore(workspaceRoot);
  t.after(() => {
    closeLibraryStore(store);
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });
  let fail = true;
  let embedCalls = 0;
  const embedTexts = async (texts: string[]) => {
    embedCalls += 1;
    if (fail) throw new Error('persistent provider failure');
    return { vectors: texts.map(() => new Float32Array(LIBRARY_EMBEDDING_DIMENSIONS)), load_ms: 0, embed_ms: 0 };
  };

  const first = await rescanLibraryReportsDetailed({ workspaceRoot, store, embedTexts, initiator: 'automatic' });
  assert.deepEqual(first, {
    scanned: 1, ingested: 0, skipped: 0, failed: 1,
    retryable_failures: [{
      document_id: first.retryable_failures[0]?.document_id,
      source_rel_path: '.lares/library/inbox/retry.md',
      attempt_count: 1,
    }],
  });
  const second = await rescanLibraryReportsDetailed({ workspaceRoot, store, embedTexts, initiator: 'automatic' });
  assert.equal(second.retryable_failures[0]?.attempt_count, 2);
  const third = await rescanLibraryReportsDetailed({ workspaceRoot, store, embedTexts, initiator: 'automatic' });
  assert.deepEqual(third.retryable_failures, []);
  const capped = await rescanLibraryReportsDetailed({ workspaceRoot, store, embedTexts, initiator: 'automatic' });
  assert.deepEqual(capped, { scanned: 1, ingested: 0, skipped: 1, failed: 0, retryable_failures: [] });
  assert.equal(embedCalls, 3);

  const manualFailure = await rescanLibraryReports({ workspaceRoot, store, embedTexts });
  assert.deepEqual(manualFailure, { scanned: 1, ingested: 0, skipped: 0, failed: 1 });
  assert.equal((store.database.prepare(`SELECT attempt_count FROM library_documents`).get() as { attempt_count: number }).attempt_count, 1,
    'a failed manual attempt must display as attempt one after the clear');
  fail = false;
  const recovered = await rescanLibraryReports({ workspaceRoot, store, embedTexts });
  assert.deepEqual(recovered, { scanned: 1, ingested: 1, skipped: 0, failed: 0 }, 'manual Rescan must remain the explicit recovery path');
  assert.equal((store.database.prepare(`SELECT attempt_count, status FROM library_documents`).get() as { attempt_count: number; status: string }).attempt_count, 0,
    'successful manual recovery resets the consecutive-failure ledger');
});
