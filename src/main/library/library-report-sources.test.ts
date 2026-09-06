import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listLibraryReportSources } from './library-report-sources';

test('inventory includes real directories and eligible reports while skipping symlinks and root _legacy', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-report-sources-')); t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const inbox = path.join(workspace, '.lares', 'library', 'inbox'); const nested = path.join(inbox, 'nested');
  fs.mkdirSync(path.join(inbox, '_legacy'), { recursive: true }); fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'ROOT.MD'), 'root'); fs.writeFileSync(path.join(nested, 'report.md'), 'nested'); fs.writeFileSync(path.join(nested, 'ignore.txt'), 'no'); fs.writeFileSync(path.join(inbox, '_legacy', 'old.md'), 'old');
  try { fs.symlinkSync(path.join(nested, 'report.md'), path.join(inbox, 'linked.md'), 'file'); } catch { t.diagnostic('symlink creation unavailable on this host'); }
  const result = await listLibraryReportSources(workspace);
  assert.deepEqual(result.inbox.files.map((file) => file.rel_path), ['nested/report.md', 'ROOT.MD']);
  assert.deepEqual(result.inbox.directories.map((directory) => directory.abs_path).sort(), [inbox, nested].sort());
  assert.equal(result.inbox.health, 'complete');
});

test('an unreadable subtree marks only that root inventory incomplete', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-report-health-')); t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const inbox = path.join(workspace, '.lares', 'library', 'inbox'); const blocked = path.join(inbox, 'blocked');
  fs.mkdirSync(blocked, { recursive: true }); fs.mkdirSync(path.join(workspace, '.lares', 'library', 'cleared'), { recursive: true });
  const result = await listLibraryReportSources(workspace, { readdir: ((directory: fs.PathLike, options?: unknown) => directory.toString() === blocked ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) : fs.promises.readdir(directory, options as { withFileTypes: true })) as typeof fs.promises.readdir });
  assert.equal(result.inbox.health, 'incomplete'); assert.equal(result.cleared.health, 'complete');
  assert.ok(result.inbox.directories.some((directory) => directory.abs_path === blocked));
});
