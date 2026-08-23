import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ARCHIVE_FORMAT_MARKER,
  ARCHIVE_INDEX_REL,
  DISCLOSURE_FORMAT_MARKER,
  MEMORY_ARCHIVE_DIR,
  MEMORY_DETAILS_DIR,
} from '../../shared/memory-index-core';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, run: () => void): void { tests.push({ name, run }); }

// recall.ts imports telemetry, but these entering tests exercise the pure production
// seam and do not need a native database binding.
const reviewStorePath = require.resolve('./review-store');
require.cache[reviewStorePath] = {
  id: reviewStorePath,
  filename: reviewStorePath,
  loaded: true,
  exports: { bumpRecall: () => undefined },
} as unknown as NodeJS.Module;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { recallMemoryDetail } = require('./recall') as typeof import('./recall');

const roots: string[] = [];
function workspace(): { root: string; detailsDir: string; archiveDir: string; memoryMd: string; archiveMd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp4-recall-'));
  roots.push(root);
  const detailsDir = path.join(root, ...MEMORY_DETAILS_DIR.split('/').filter(Boolean));
  const archiveDir = path.join(root, ...MEMORY_ARCHIVE_DIR.split('/').filter(Boolean));
  const memoryMd = path.resolve(detailsDir, '..', 'MEMORY.md');
  const archiveMd = path.join(root, ...ARCHIVE_INDEX_REL.split('/').filter(Boolean));
  fs.mkdirSync(detailsDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(memoryMd, `${DISCLOSURE_FORMAT_MARKER}\n`, 'utf8');
  fs.writeFileSync(archiveMd, `${ARCHIVE_FORMAT_MARKER}\n`, 'utf8');
  return { root, detailsDir, archiveDir, memoryMd, archiveMd };
}

function activeCard(id: string, detail: string): string {
  return `\n## ${id}: active\n- read-if: relevant now\n- detail: ${detail}\n`;
}

function archivedCard(id: string, detail: string, status = 'archived'): string {
  return `\n## ${id}: archived\n- status: ${status}\n- detail: ${detail}\n`;
}

test('recallMemoryDetail gives MEMORY.md precedence over an archive record with the same id', () => {
  const id = 'mb-2026-08-22-precedence';
  const w = workspace();
  fs.appendFileSync(w.memoryMd, activeCard(id, 'memory/details/live.md'));
  fs.appendFileSync(w.archiveMd, archivedCard(id, 'memory/archive/old.md'));
  fs.writeFileSync(path.join(w.detailsDir, 'live.md'), 'LIVE BODY');
  fs.writeFileSync(path.join(w.archiveDir, 'old.md'), 'ARCHIVE BODY');

  const result = recallMemoryDetail(w.root, id);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.status, 'active');
    assert.equal(result.archived, false);
    assert.equal(result.body, 'LIVE BODY');
  }
});

test('recallMemoryDetail consults ARCHIVE.md when MEMORY.md has no matching id', () => {
  const id = 'mb-2026-08-22-archived';
  const w = workspace();
  fs.appendFileSync(w.archiveMd, archivedCard(id, 'memory/archive/history.md'));
  fs.writeFileSync(path.join(w.archiveDir, 'history.md'), 'ARCHIVED BODY');

  const result = recallMemoryDetail(w.root, id);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.status, 'archived');
    assert.equal(result.archived, true);
    assert.equal(result.body, 'ARCHIVED BODY');
  }
});

test('duplicate ids in the selected catalog are diagnosed internally and refused as not_found', () => {
  const id = 'mb-2026-08-22-duplicate';
  const w = workspace();
  fs.appendFileSync(w.memoryMd, activeCard(id, 'memory/details/a.md') + activeCard(id, 'memory/details/b.md'));
  fs.appendFileSync(w.archiveMd, archivedCard(id, 'memory/archive/fallback.md'));
  fs.writeFileSync(path.join(w.detailsDir, 'a.md'), 'A');
  fs.writeFileSync(path.join(w.detailsDir, 'b.md'), 'B');
  fs.writeFileSync(path.join(w.archiveDir, 'fallback.md'), 'MUST NOT WIN');
  const diagnostics: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => { diagnostics.push(String(message)); };
  try {
    assert.deepEqual(recallMemoryDetail(w.root, id), { ok: false, code: 'not_found' });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /ambiguous id .*2 records in MEMORY\.md/);
});

test('duplicate archive ids are diagnosed internally and refused as not_found', () => {
  const id = 'mb-2026-08-22-archive-duplicate';
  const w = workspace();
  fs.appendFileSync(w.archiveMd,
    archivedCard(id, 'memory/archive/a.md') + archivedCard(id, 'memory/archive/b.md'));
  const diagnostics: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => { diagnostics.push(String(message)); };
  try {
    assert.deepEqual(recallMemoryDetail(w.root, id), { ok: false, code: 'not_found' });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /2 records in ARCHIVE\.md/);
});

test('catalog status and body root must agree', () => {
  const activeId = 'mb-2026-08-22-active-root';
  const archivedId = 'mb-2026-08-22-archive-root';
  const wrongStatusId = 'mb-2026-08-22-wrong-status';
  const w = workspace();
  fs.appendFileSync(w.memoryMd, activeCard(activeId, 'memory/archive/active.md'));
  fs.appendFileSync(w.archiveMd,
    archivedCard(archivedId, 'memory/details/archived.md')
    + archivedCard(wrongStatusId, 'memory/archive/wrong-status.md', 'active'));
  fs.writeFileSync(path.join(w.archiveDir, 'active.md'), 'WRONG ROOT');
  fs.writeFileSync(path.join(w.detailsDir, 'archived.md'), 'WRONG ROOT');
  fs.writeFileSync(path.join(w.archiveDir, 'wrong-status.md'), 'WRONG STATUS');

  assert.deepEqual(recallMemoryDetail(w.root, activeId), { ok: false, code: 'not_found' });
  assert.deepEqual(recallMemoryDetail(w.root, archivedId), { ok: false, code: 'not_found' });
  assert.deepEqual(recallMemoryDetail(w.root, wrongStatusId), { ok: false, code: 'not_found' });
});

test('successful recall strips only the leading disposal block without changing disk bytes', () => {
  const id = 'mb-2026-08-22-disposal';
  const w = workspace();
  fs.appendFileSync(w.memoryMd, activeCard(id, 'memory/details/disposal.md'));
  const onDisk = '\uFEFF<!-- memory-disposal:v1\r\nkind: expires\r\nvalue: 2026-09-01\r\n-->\r\n# Useful body\r\n<!-- memory-disposal:v1 stays if not leading -->';
  const detailPath = path.join(w.detailsDir, 'disposal.md');
  fs.writeFileSync(detailPath, onDisk, 'utf8');
  const before = fs.readFileSync(detailPath);

  const result = recallMemoryDetail(w.root, id);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.body, '# Useful body\r\n<!-- memory-disposal:v1 stays if not leading -->');
  }
  assert.deepEqual(fs.readFileSync(detailPath), before, 'recall must leave on-disk bytes unchanged');
});

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok  ${t.name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${t.name}`);
    console.error(error);
  }
}
for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
