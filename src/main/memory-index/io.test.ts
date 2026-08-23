import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ARCHIVE_FORMAT_MARKER, DISCLOSURE_FORMAT_MARKER } from '../../shared/memory-index-core';
import { readValidateProject, validateProjectSource } from './io';

const tests: Array<{ name: string; fn: () => void }> = [];
const roots: string[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, fn }); }

function active(id: string, detail = `memory/details/${id}.md`): string {
  return `## ${id}: Title\n- read-if: before changing memory\n- detail: ${detail}`;
}

function archived(id: string, detail = `memory/archive/${id}.md`): string {
  return `## ${id}: Archived title\n- status: archived\n- detail: ${detail}`;
}

function resident(...blocks: string[]): string {
  return `${DISCLOSURE_FORMAT_MARKER}\n\n${blocks.join('\n\n')}\n`;
}

function archive(...blocks: string[]): string {
  return `${ARCHIVE_FORMAT_MARKER}\n\n${blocks.join('\n\n')}\n`;
}

function disposal(kind: 'open-loop' | 'expires' | 'expires-when', value?: string): string {
  return `<!-- memory-disposal:v1\nkind: ${kind}${value === undefined ? '' : `\nvalue: ${value}`}\n-->\n\nbody\n`;
}

function workspace(): {
  root: string;
  memoryDir: string;
  detailsDir: string;
  archiveDir: string;
  memoryMd: string;
  archiveMd: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-wp2-'));
  roots.push(root);
  const memoryDir = path.join(root, '.lares', 'supervisor', 'memory');
  const detailsDir = path.join(memoryDir, 'details');
  const archiveDir = path.join(memoryDir, 'archive');
  fs.mkdirSync(detailsDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  return {
    root,
    memoryDir,
    detailsDir,
    archiveDir,
    memoryMd: path.join(memoryDir, 'MEMORY.md'),
    archiveMd: path.join(archiveDir, 'ARCHIVE.md'),
  };
}

function writeBody(dir: string, id: string, body: string): string {
  const file = path.join(dir, `${id}.md`);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function classes(result: { hard: Array<{ cls: string }> }): string[] {
  return result.hard.map((finding) => finding.cls);
}

test('disposal-missing is entry-local HARD and the healthy block still projects', () => {
  const ws = workspace();
  const bad = 'mb-2026-08-01-missing';
  const good = 'mb-2026-08-02-good';
  writeBody(ws.detailsDir, bad, '# no disposal block\n');
  writeBody(ws.detailsDir, good, disposal('open-loop'));
  const result = validateProjectSource(resident(active(bad), active(good)), ws.root, '2026-08-22T00:00:00Z');
  assert.ok(result.hard.some((finding) => finding.cls === 'disposal-missing' && finding.id === bad));
  assert.deepEqual(result.disposal.get(bad), { error: 'disposal-missing' });
  assert.ok(!result.injectText.includes(bad));
  assert.ok(result.injectText.includes(good));
});

test('disposal-malformed is entry-local HARD and is retained in the disposal map', () => {
  const ws = workspace();
  const id = 'mb-2026-08-03-malformed';
  writeBody(ws.detailsDir, id, '<!-- memory-disposal:v1\nkind: open-loop\nvalue: forbidden\n-->\n');
  const result = validateProjectSource(resident(active(id)), ws.root, '2026-08-22T00:00:00Z');
  assert.ok(result.hard.some((finding) => finding.cls === 'disposal-malformed' && finding.id === id));
  assert.deepEqual(result.disposal.get(id), { error: 'disposal-malformed' });
});

test('detail-unreadable does not throw a launch-wide RUNTIME and only splices that entry', () => {
  const ws = workspace();
  const bad = 'mb-2026-08-04-unreadable';
  const good = 'mb-2026-08-05-readable';
  fs.mkdirSync(path.join(ws.detailsDir, `${bad}.md`)); // realpath succeeds; readFileSync throws EISDIR
  writeBody(ws.detailsDir, good, disposal('open-loop'));
  fs.writeFileSync(ws.memoryMd, resident(active(bad), active(good)), 'utf8');
  let result: ReturnType<typeof readValidateProject> | undefined;
  assert.doesNotThrow(() => { result = readValidateProject(ws.root, '2026-08-22T00:00:00Z'); });
  assert.ok(result);
  assert.ok(result.hard.some((finding) => finding.cls === 'detail-unreadable' && finding.id === bad));
  assert.ok(!result.injectText.includes(bad));
  assert.ok(result.injectText.includes(good));
});

test('detail-root-mismatch rejects an active record pointing into archive', () => {
  const ws = workspace();
  const id = 'mb-2026-08-06-wrong-root';
  writeBody(ws.archiveDir, id, disposal('open-loop'));
  const result = validateProjectSource(resident(active(id, `memory/archive/${id}.md`)), ws.root, '2026-08-22T00:00:00Z');
  assert.ok(result.hard.some((finding) => finding.cls === 'detail-root-mismatch' && finding.id === id), classes(result).join(','));
  assert.deepEqual(result.disposal.get(id), { error: 'detail-root-mismatch' });
});

test('archive-orphan is HARD but non-projection and ARCHIVE.md is excluded from the scan', () => {
  const ws = workspace();
  const activeId = 'mb-2026-08-07-active';
  writeBody(ws.detailsDir, activeId, disposal('open-loop'));
  fs.writeFileSync(ws.archiveMd, archive(), 'utf8');
  writeBody(ws.archiveDir, 'mb-2026-08-01-orphan', disposal('open-loop'));
  const result = validateProjectSource(resident(active(activeId)), ws.root, '2026-08-22T00:00:00Z');
  assert.ok(result.hard.some((finding) => finding.cls === 'archive-orphan'));
  assert.ok(!result.hard.some((finding) => finding.cls === 'archive-orphan' && /ARCHIVE\.md/.test(finding.message)));
  assert.ok(result.injectText.includes(activeId), 'non-projection archive damage must not blank resident memory');
});

test('archive-growth is advisory and does not affect resident projection', () => {
  const ws = workspace();
  const id = 'mb-2026-08-08-active';
  writeBody(ws.detailsDir, id, disposal('open-loop'));
  fs.writeFileSync(ws.archiveMd, `${ARCHIVE_FORMAT_MARKER}\n${'x'.repeat(200_001)}\n`, 'utf8');
  const result = validateProjectSource(resident(active(id)), ws.root, '2026-08-22T00:00:00Z');
  assert.ok(result.advisory.some((finding) => finding.cls === 'archive-growth'));
  assert.ok(result.injectText.includes(id));
});

test('archived records are disposal-exempt and their body blocks remain byte-identical', () => {
  const ws = workspace();
  const activeId = 'mb-2026-08-09-active';
  const archivedId = 'mb-2026-07-01-archived';
  writeBody(ws.detailsDir, activeId, disposal('open-loop'));
  const archivedBody = '<!-- memory-disposal:v1\nkind: expires\nvalue: 2026-07-02\n-->\n\narchived history\n';
  const archivedPath = writeBody(ws.archiveDir, archivedId, archivedBody);
  fs.writeFileSync(ws.archiveMd, archive(archived(archivedId)), 'utf8');
  const result = validateProjectSource(resident(active(activeId)), ws.root, '2026-08-22T00:00:00Z');
  assert.ok(!result.hard.some((finding) => finding.id === archivedId && finding.cls.startsWith('disposal-')));
  assert.equal(result.disposal.has(archivedId), false, 'only live disposal conditions belong in the map');
  assert.equal(fs.readFileSync(archivedPath, 'utf8'), archivedBody);
});

test('REACHABILITY:validate-project-source passes io lifecycle facts into graded projection', () => {
  const ws = workspace();
  const expiredId = 'mb-2026-08-10-expired';
  const liveId = 'mb-2026-08-11-live';
  writeBody(ws.detailsDir, expiredId, disposal('expires', '2026-08-20'));
  writeBody(ws.detailsDir, liveId, disposal('open-loop'));
  const result = validateProjectSource(resident(active(expiredId), active(liveId)), ws.root, '2026-08-22T00:00:00Z');
  assert.deepEqual(result.expiredIds, [expiredId]);
  assert.deepEqual(result.projection.expired, [expiredId]);
  assert.ok(!result.injectText.includes(expiredId));
  assert.ok(result.injectText.includes(liveId));
});

let failed = 0;
for (const item of tests) {
  try {
    item.fn();
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${item.name}`);
    console.error(error instanceof Error ? error.stack : error);
  }
}
for (const root of roots) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(`memory-index io WP-2: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
