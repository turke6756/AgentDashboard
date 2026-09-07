import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LIBRARY_CHANNELS, publishLibraryBroadcast, registerProductionLibraryIpc, resetLibraryBroadcastForTests } from './library-ipc';

test('progress published before the production broadcaster is installed is delivered on registration', () => {
  resetLibraryBroadcastForTests();
  const progress = { workspace_id: 'workspace-1', document_id: 'doc-1', status: 'embedding' as const };
  publishLibraryBroadcast(progress);
  const delivered: unknown[] = [];
  registerProductionLibraryIpc({ handle: () => undefined }, () => null, (event) => delivered.push(event));
  assert.deepEqual(delivered, [progress]);
});

test('production library:list-shelf IPC enters the disk-to-index shelf join and returns untrusted pending reports', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-library-ipc-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const inbox = path.join(workspace, '.lares', 'library', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'new-report.md'), '# New report');

  const handlers = new Map<string, (...args: any[]) => unknown>();
  registerProductionLibraryIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    (workspaceId) => workspaceId === 'workspace-1' ? { id: workspaceId, path: workspace } : null,
    () => undefined,
  );
  const handler = handlers.get(LIBRARY_CHANNELS.listShelf);
  assert.ok(handler, 'REACHABILITY:library:list-shelf production registration missing');
  const rows = await handler({} as never, 'workspace-1') as Array<{ id: string; trust: string; type: string; shelf_status: string }>;
  assert.deepEqual(rows.map(({ id, trust, type, shelf_status }) => ({ id, trust, type, shelf_status })), [{
    id: 'shelf:.lares/library/inbox/new-report.md', trust: 'untrusted', type: 'research', shelf_status: 'pending',
  }], 'REACHABILITY:listLibraryShelf did not return the disk-owned report through production IPC');
});

test('production library:rescan IPC takes only workspaceId and returns walk counts', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-library-rescan-ipc-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, '.lares', 'library', 'inbox'), { recursive: true });

  const handlers = new Map<string, (...args: any[]) => unknown>();
  registerProductionLibraryIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    (workspaceId) => workspaceId === 'workspace-1' ? { id: workspaceId, path: workspace } : null,
    () => undefined,
  );
  const handler = handlers.get(LIBRARY_CHANNELS.rescan);
  assert.ok(handler);
  assert.deepEqual(await handler({} as never, 'workspace-1'), { scanned: 0, ingested: 0, skipped: 0, failed: 0 });
});
