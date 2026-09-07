import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LIBRARY_EMBEDDING_DIMENSIONS } from './library-embedder';
import { LIBRARY_CHANNELS, registerProductionLibraryIpc } from './library-ipc';
import { rescanLibraryReports } from './library-rescan';

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
  registerProductionLibraryIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    (workspaceId) => workspaceId === 'workspace-1' ? { id: workspaceId, path: workspaceRoot } : null,
    () => undefined,
    (deps) => rescanLibraryReports({ ...deps, embedTexts }),
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
});
