import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isEligibleLibraryReport, listLibraryReportSources, normalizeLibraryReportKey } from './library-report-sources';

function createJunctionOrSkip(t: test.TestContext, target: string, link: string): boolean {
  try { fs.symlinkSync(target, link, 'junction'); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('junction creation requires permission on this host'); return false; }
    throw error;
  }
}

test('inventory includes real directories and eligible reports while skipping root _legacy', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-report-sources-')); t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const inbox = path.join(workspace, '.lares', 'library', 'inbox'); const nested = path.join(inbox, 'nested');
  fs.mkdirSync(path.join(inbox, '_legacy'), { recursive: true }); fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'ROOT.MD'), 'root'); fs.writeFileSync(path.join(inbox, '..draft.md'), 'draft'); fs.writeFileSync(path.join(nested, 'report.md'), 'nested'); fs.writeFileSync(path.join(nested, 'ignore.txt'), 'no'); fs.writeFileSync(path.join(inbox, '_legacy', 'old.md'), 'old');
  const result = await listLibraryReportSources(workspace);
  const expected = ['..draft.md', 'nested/report.md', 'ROOT.MD'].map(normalizeLibraryReportKey).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(result.inbox.files.map((file) => file.rel_path), expected);
  assert.deepEqual(result.inbox.directories.map((directory) => directory.abs_path).sort(), [inbox, nested].sort());
  assert.equal(result.inbox.health, 'complete');
});

test('win32 inventory case-folds the root _legacy exclusion', async (t) => {
  if (process.platform !== 'win32') { t.skip('win32 case-folding contract'); return; }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-report-legacy-case-')); t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const inbox = path.join(workspace, '.lares', 'library', 'inbox'); fs.mkdirSync(path.join(inbox, '_LeGaCy'), { recursive: true }); fs.writeFileSync(path.join(inbox, '_LeGaCy', 'old.md'), 'old');
  const result = await listLibraryReportSources(workspace);
  assert.deepEqual(result.inbox.files, []); assert.deepEqual(result.inbox.directories.map((directory) => directory.abs_path), [inbox]); assert.equal(result.inbox.health, 'complete');
});

test('inventory never follows an in-root junction to an outside report', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-report-junction-')); const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-report-outside-'));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const inbox = path.join(workspace, '.lares', 'library', 'inbox'); fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(outside, 'escape.md'), 'escape');
  if (!createJunctionOrSkip(t, outside, path.join(inbox, 'linked'))) return;
  const result = await listLibraryReportSources(workspace);
  assert.equal(result.inbox.directories.some((directory) => directory.abs_path === path.join(inbox, 'linked')), false);
  assert.equal(result.inbox.files.some((file) => file.abs_path === path.join(outside, 'escape.md') || file.rel_path.endsWith('escape.md')), false);
});

test('inventory rejects report roots redirected outside the real workspace', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-report-confined-')); const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-report-redirect-'));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(workspace, '.lares'), { recursive: true }); fs.mkdirSync(path.join(outside, 'inbox'), { recursive: true }); fs.mkdirSync(path.join(outside, 'cleared'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'inbox', 'escape.md'), 'escape');
  if (!createJunctionOrSkip(t, outside, path.join(workspace, '.lares', 'library'))) return;
  const result = await listLibraryReportSources(workspace);
  assert.deepEqual(result.inbox.files, []); assert.deepEqual(result.cleared.files, []);
  assert.equal(result.inbox.health, 'incomplete'); assert.equal(result.cleared.health, 'incomplete');
});

test('junction and missing report roots remain incomplete so empty scans cannot authorize deletion', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-report-root-health-')); const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-report-root-target-'));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const library = path.join(workspace, '.lares', 'library'); fs.mkdirSync(library, { recursive: true }); fs.writeFileSync(path.join(outside, 'escape.md'), 'escape');
  if (!createJunctionOrSkip(t, outside, path.join(library, 'inbox'))) return;
  const result = await listLibraryReportSources(workspace);
  assert.deepEqual(result.inbox.files, []); assert.equal(result.inbox.health, 'incomplete');
  assert.deepEqual(result.cleared.files, []); assert.equal(result.cleared.health, 'incomplete');
});

test('the exported eligibility predicate enforces extension, root _legacy, and realpath containment', () => {
  const root = path.resolve('workspace', 'inbox'); const inside = path.join(root, 'report.md');
  const regular = { isFile: () => true, isSymbolicLink: () => false } as fs.Stats;
  assert.equal(isEligibleLibraryReport(inside, regular, { rootPath: root, rootRealPath: root, realPath: inside }), true);
  assert.equal(isEligibleLibraryReport(path.join(root, '_legacy', 'old.md'), regular, { rootPath: root, rootRealPath: root, realPath: path.join(root, '_legacy', 'old.md') }), false);
  assert.equal(isEligibleLibraryReport(inside, regular, { rootPath: root, rootRealPath: root, realPath: path.resolve('outside', 'report.md') }), false);
});

test('an unreadable subtree marks only that root inventory incomplete', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-report-health-')); t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const inbox = path.join(workspace, '.lares', 'library', 'inbox'); const blocked = path.join(inbox, 'blocked');
  fs.mkdirSync(blocked, { recursive: true }); fs.mkdirSync(path.join(workspace, '.lares', 'library', 'cleared'), { recursive: true });
  const result = await listLibraryReportSources(workspace, { readdir: ((directory: fs.PathLike, options?: unknown) => directory.toString() === blocked ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) : fs.promises.readdir(directory, options as { withFileTypes: true })) as typeof fs.promises.readdir });
  assert.equal(result.inbox.health, 'incomplete'); assert.equal(result.cleared.health, 'complete');
  assert.ok(result.inbox.directories.some((directory) => directory.abs_path === blocked));
});
