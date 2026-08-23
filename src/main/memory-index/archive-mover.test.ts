// WP-5 archive mover behavioural tests. Every transition enters through the
// production archiveMemoryEntry seam and uses a real temporary filesystem.
//
//   npm run build:main
//   node dist/main/main/memory-index/archive-mover.test.js

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ARCHIVE_FORMAT_MARKER, DISCLOSURE_FORMAT_MARKER } from '../../shared/memory-index-core';
import { archiveMemoryEntry, type ArchiveMemoryInput } from './archive-mover';
import * as scaffoldWriter from '../scaffold-writer';
import * as reviewStore from './review-store';
import * as database from '../database';

interface TestCase { name: string; run(): void }
const tests: TestCase[] = [];
function test(name: string, run: () => void): void { tests.push({ name, run }); }

const NOW = '2026-08-22T12:00:00.000Z';
const PT = 'windows';
const ID = 'mb-2026-08-22-finished';
const INDEX_REL = '.lares/supervisor/memory/MEMORY.md';
const DETAILS_REL = '.lares/supervisor/memory/details/';
const ARCHIVE_REL = '.lares/supervisor/memory/archive/';
const ARCHIVE_INDEX_REL = `${ARCHIVE_REL}ARCHIVE.md`;

const writerExports = scaffoldWriter as unknown as {
  commitStagedRename: typeof scaffoldWriter.commitStagedRename;
  deleteScaffoldFile: typeof scaffoldWriter.deleteScaffoldFile;
};
const storeExports = reviewStore as unknown as {
  upsertFindings: typeof reviewStore.upsertFindings;
};
const databaseExports = database as unknown as { getDb: typeof database.getDb };
// The mover calls the real persistence seams; tests replace only their backing
// store so filesystem behaviour remains real without initializing app SQLite.
storeExports.upsertFindings = (ws, findings) => findings.map((finding) => reviewStore.computeFindingId(ws, finding));
databaseExports.getDb = (() => ({ prepare: () => ({ run: () => ({ changes: 1 }) }) })) as unknown as typeof database.getDb;

function sha(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}
function full(workDir: string, rel: string): string { return path.join(workDir, ...rel.split('/')); }
function writeAt(workDir: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(full(workDir, rel)), { recursive: true });
  fs.writeFileSync(full(workDir, rel), content, 'utf8');
}
function readAt(workDir: string, rel: string): string | null {
  try { return fs.readFileSync(full(workDir, rel), 'utf8'); } catch { return null; }
}
function residentCard(id = ID): string {
  return [
    `## ${id}: Finished memory`,
    '- read-if: the finished constraint becomes relevant again',
    `- detail: memory/details/${id}.md`,
  ].join('\n');
}
function residentIndex(...cards: string[]): string {
  return `${DISCLOSURE_FORMAT_MARKER}\n\n${cards.join('\n\n')}${cards.length ? '\n' : ''}`;
}
function archiveCard(id = ID): string {
  return [
    `## ${id}: Finished memory`,
    '- status: archived',
    `- detail: memory/archive/${id}.md`,
  ].join('\n');
}
function archiveIndex(...cards: string[]): string {
  return `${ARCHIVE_FORMAT_MARKER}\n\n${cards.join('\n\n')}${cards.length ? '\n' : ''}`;
}
function body(id = ID): string {
  return `<!-- memory-disposal:v1\nkind: expires-when\nvalue: the constraint is permanently incorporated\n-->\n\n# ${id}\n\nFull retained body.\n`;
}
function mkWorkDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-mover-test-')); }
function seedActive(workDir: string): { prior: string; bodyText: string; input: ArchiveMemoryInput } {
  const prior = residentIndex(residentCard());
  const bodyText = body();
  writeAt(workDir, INDEX_REL, prior);
  writeAt(workDir, `${DETAILS_REL}${ID}.md`, bodyText);
  return { prior, bodyText, input: { id: ID, expectedPriorHash: sha(prior), expectedBodyHash: sha(bodyText) } };
}
function assertArchived(workDir: string, bodyText: string): void {
  assert.equal(readAt(workDir, INDEX_REL)?.includes(`## ${ID}:`), false, 'resident card is removed at the logical commit');
  assert.equal(readAt(workDir, ARCHIVE_INDEX_REL)?.includes(archiveCard()), true, 'archive catalog has the exact record');
  assert.equal(readAt(workDir, `${ARCHIVE_REL}${ID}.md`), bodyText, 'archive body preserves the source bytes');
}

test('archives copy -> ARCHIVE add -> MEMORY remove -> cleanup without migration approval', () => {
  const workDir = mkWorkDir();
  const seeded = seedActive(workDir);
  // A mover that accidentally inherited bundle migration approval would call
  // this throwing sentinel and fail the behavioural happy path.
  const store = reviewStore as unknown as { getMigrationApproval?: (...args: unknown[]) => unknown };
  const priorApproval = store.getMigrationApproval;
  store.getMigrationApproval = () => { throw new Error('getMigrationApproval must not be called'); };
  try {
    const result = archiveMemoryEntry('ws-happy', workDir, PT, seeded.input, NOW);
    assert.deepEqual(result, { ok: true }, 'REACHABILITY:archive-mover');
  } finally {
    store.getMigrationApproval = priorApproval;
  }
  assertArchived(workDir, seeded.bodyText);
  assert.equal(readAt(workDir, `${DETAILS_REL}${ID}.md`), null, 'resident body is cleaned after commit');
});

test('CRLF resident removal maps normalized parser offsets back to byte-correct raw offsets', () => {
  const workDir = mkWorkDir();
  const second = 'mb-2026-08-22-still-active';
  const prior = residentIndex(residentCard(ID), residentCard(second)).replace(/\n/g, '\r\n');
  const expectedResident = residentIndex(residentCard(second)).replace(/\n/g, '\r\n');
  const firstBody = body(ID);
  writeAt(workDir, INDEX_REL, prior);
  writeAt(workDir, `${DETAILS_REL}${ID}.md`, firstBody);
  writeAt(workDir, `${DETAILS_REL}${second}.md`, body(second));
  const result = archiveMemoryEntry('ws-crlf', workDir, PT, {
    id: ID, expectedPriorHash: sha(prior), expectedBodyHash: sha(firstBody),
  }, NOW);
  assert.deepEqual(result, { ok: true });
  assert.equal(readAt(workDir, INDEX_REL), expectedResident, 'remaining CRLF bytes are preserved exactly');
});

test('wrong resident index CAS returns cas_mismatch before mutation', () => {
  const workDir = mkWorkDir();
  const seeded = seedActive(workDir);
  const result = archiveMemoryEntry('ws-cas', workDir, PT, { ...seeded.input, expectedPriorHash: sha('stale') }, NOW);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.code, 'cas_mismatch');
  assert.equal(readAt(workDir, INDEX_REL), seeded.prior);
  assert.equal(readAt(workDir, ARCHIVE_INDEX_REL), null);
});

test('wrong resident body CAS returns cas_mismatch before mutation', () => {
  const workDir = mkWorkDir();
  const seeded = seedActive(workDir);
  const result = archiveMemoryEntry('ws-body-cas', workDir, PT, { ...seeded.input, expectedBodyHash: sha('stale body') }, NOW);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.code, 'cas_mismatch');
  assert.equal(readAt(workDir, INDEX_REL), seeded.prior);
  assert.equal(readAt(workDir, ARCHIVE_INDEX_REL), null);
});

test('divergent existing archive body is a conflict and is never overwritten', () => {
  const workDir = mkWorkDir();
  const seeded = seedActive(workDir);
  const divergent = 'foreign archive bytes\n';
  writeAt(workDir, `${ARCHIVE_REL}${ID}.md`, divergent);
  const result = archiveMemoryEntry('ws-collision', workDir, PT, seeded.input, NOW);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.code, 'conflict');
  assert.equal(readAt(workDir, `${ARCHIVE_REL}${ID}.md`), divergent, 'collision bytes remain untouched');
  assert.equal(readAt(workDir, INDEX_REL), seeded.prior, 'resident state remains authoritative');
});

test('cross-catalog temp-mirror validation refuses an archive orphan before mutation', () => {
  const workDir = mkWorkDir();
  const seeded = seedActive(workDir);
  writeAt(workDir, ARCHIVE_INDEX_REL, archiveIndex());
  writeAt(workDir, `${ARCHIVE_REL}mb-2026-08-21-orphan.md`, 'orphan archive body\n');
  const result = archiveMemoryEntry('ws-hard', workDir, PT, seeded.input, NOW);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.code, 'hard_invalid');
  assert.ok(!result.ok && result.findings?.some((finding) => finding.cls === 'archive-orphan'));
  assert.equal(readAt(workDir, INDEX_REL), seeded.prior);
  assert.equal(readAt(workDir, `${ARCHIVE_REL}${ID}.md`), null, 'validation happens before copy');
});

test('retry recovers the safe crash state after body copy but before archive add', () => {
  const workDir = mkWorkDir();
  const seeded = seedActive(workDir);
  writeAt(workDir, `${ARCHIVE_REL}${ID}.md`, seeded.bodyText);
  const result = archiveMemoryEntry('ws-copy-crash', workDir, PT, seeded.input, NOW);
  assert.deepEqual(result, { ok: true });
  assertArchived(workDir, seeded.bodyText);
});

test('retry recovers the both-catalog precommit intermediate', () => {
  const workDir = mkWorkDir();
  const seeded = seedActive(workDir);
  writeAt(workDir, `${ARCHIVE_REL}${ID}.md`, seeded.bodyText);
  writeAt(workDir, ARCHIVE_INDEX_REL, archiveIndex(archiveCard()));
  const result = archiveMemoryEntry('ws-both', workDir, PT, seeded.input, NOW);
  assert.deepEqual(result, { ok: true });
  assertArchived(workDir, seeded.bodyText);
});

test('a committed entry awaiting cleanup does not wedge archiving another entry', () => {
  const workDir = mkWorkDir();
  const second = 'mb-2026-08-22-second';
  const secondBody = body(second);
  const resident = residentIndex(residentCard(second));
  writeAt(workDir, INDEX_REL, resident);
  writeAt(workDir, ARCHIVE_INDEX_REL, archiveIndex(archiveCard(ID)));
  writeAt(workDir, `${ARCHIVE_REL}${ID}.md`, body(ID));
  writeAt(workDir, `${DETAILS_REL}${ID}.md`, body(ID)); // A: committed, cleanup pending
  writeAt(workDir, `${DETAILS_REL}${second}.md`, secondBody);
  const result = archiveMemoryEntry('ws-two-entry', workDir, PT, {
    id: second, expectedPriorHash: sha(resident), expectedBodyHash: sha(secondBody),
  }, NOW);
  assert.deepEqual(result, { ok: true });
  assert.equal(readAt(workDir, `${DETAILS_REL}${ID}.md`), body(ID), 'A cleanup remains independently pending');
  assert.equal(readAt(workDir, `${ARCHIVE_REL}${second}.md`), secondBody, 'B archives successfully');
});

test('a details body present in neither catalog remains an orphan-details HARD', () => {
  const workDir = mkWorkDir();
  const seeded = seedActive(workDir);
  const orphan = 'mb-2026-08-22-uncatalogued';
  writeAt(workDir, `${DETAILS_REL}${orphan}.md`, body(orphan));
  const result = archiveMemoryEntry('ws-true-orphan', workDir, PT, seeded.input, NOW);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.code, 'hard_invalid');
  assert.ok(!result.ok && result.findings?.some((finding) => finding.cls === 'orphan-details'));
  assert.equal(readAt(workDir, INDEX_REL), seeded.prior, 'true orphan refuses before logical commit');
  assert.equal(readAt(workDir, `${ARCHIVE_REL}${ID}.md`), null, 'true orphan refuses before archive copy');
});

test('post-commit retry classifies before CAS and returns ok, never cas_mismatch', () => {
  const workDir = mkWorkDir();
  const seeded = seedActive(workDir);
  writeAt(workDir, INDEX_REL, residentIndex());
  writeAt(workDir, ARCHIVE_INDEX_REL, archiveIndex(archiveCard()));
  writeAt(workDir, `${ARCHIVE_REL}${ID}.md`, seeded.bodyText);
  // The original expectedPriorHash intentionally no longer matches MEMORY.md.
  const result = archiveMemoryEntry('ws-postcommit', workDir, PT, seeded.input, NOW);
  assert.deepEqual(result, { ok: true });
  assert.equal(readAt(workDir, `${DETAILS_REL}${ID}.md`), null, 'retry finishes step 5 cleanup');
});

test('first-pass cleanup failure returns cleanup_pending and persists before delete', () => {
  const workDir = mkWorkDir();
  const seeded = seedActive(workDir);
  const priorDelete = writerExports.deleteScaffoldFile;
  const priorUpsert = storeExports.upsertFindings;
  const persisted: Array<{ ws: string; findings: reviewStore.FindingInput[]; nowISO: string }> = [];
  const events: string[] = [];
  writerExports.deleteScaffoldFile = (wd, rel, pathType) => {
    if (wd === workDir && rel === `${DETAILS_REL}${ID}.md`) events.push('delete');
    if (wd === workDir && rel === `${DETAILS_REL}${ID}.md`) throw new Error('simulated cleanup denial');
    priorDelete(wd, rel, pathType);
  };
  storeExports.upsertFindings = (ws, findings, nowISO) => {
    events.push('persist');
    persisted.push({ ws, findings, nowISO });
    return ['finding-id'];
  };
  try {
    const result = archiveMemoryEntry('ws-pending', workDir, PT, seeded.input, NOW);
    assert.deepEqual(result, { ok: true, code: 'cleanup_pending', persisted: true });
  } finally {
    writerExports.deleteScaffoldFile = priorDelete;
    storeExports.upsertFindings = priorUpsert;
  }
  assert.deepEqual(events, ['persist', 'delete'], 'cleanup marker is durable before deletion begins');
  assert.equal(readAt(workDir, `${DETAILS_REL}${ID}.md`), seeded.bodyText, 'committed transition is not rolled back');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].ws, 'ws-pending');
  assert.equal(persisted[0].findings[0].kind, 'archive-cleanup-pending');
  assert.equal(persisted[0].findings[0].entryId, ID);
  assert.equal(persisted[0].findings[0].sourceHash, seeded.input.expectedBodyHash);
});

test('persistence failure is surfaced and cleanup is not attempted', () => {
  const workDir = mkWorkDir();
  const seeded = seedActive(workDir);
  writeAt(workDir, INDEX_REL, residentIndex());
  writeAt(workDir, ARCHIVE_INDEX_REL, archiveIndex(archiveCard()));
  writeAt(workDir, `${ARCHIVE_REL}${ID}.md`, seeded.bodyText);
  const priorUpsert = storeExports.upsertFindings;
  storeExports.upsertFindings = () => { throw new Error('database unavailable'); };
  try {
    const result = archiveMemoryEntry('ws-persist-fail', workDir, PT, seeded.input, NOW);
    assert.deepEqual(result, { ok: true, code: 'cleanup_pending', persisted: false });
  } finally {
    storeExports.upsertFindings = priorUpsert;
  }
  assert.equal(readAt(workDir, `${DETAILS_REL}${ID}.md`), seeded.bodyText, 'retry body remains when persistence fails');
});

test('fresh calls recover faults after each commit rename boundary', () => {
  const priorCommit = writerExports.commitStagedRename;
  const priorUpsert = storeExports.upsertFindings;
  for (const failAfter of [1, 2, 3]) {
    const workDir = mkWorkDir();
    const seeded = seedActive(workDir);
    let commits = 0;
    const events: string[] = [];
    storeExports.upsertFindings = (ws, findings, nowISO) => {
      events.push('persist');
      return priorUpsert(ws, findings, nowISO);
    };
    writerExports.commitStagedRename = (wd, tempRel, finalRel, pathType) => {
      priorCommit(wd, tempRel, finalRel, pathType);
      commits++;
      events.push(`commit:${commits}`);
      if (commits === failAfter) throw new Error(`simulated crash after rename ${failAfter}`);
    };
    let first;
    try {
      first = archiveMemoryEntry(`ws-rename-${failAfter}`, workDir, PT, seeded.input, NOW);
    } finally {
      writerExports.commitStagedRename = priorCommit;
      storeExports.upsertFindings = priorUpsert;
    }
    if (failAfter < 3) {
      assert.equal(first.ok, false, `rename ${failAfter} fault is restored precommit`);
      assert.equal(first.ok ? '' : first.code, 'write_error');
    } else {
      assert.deepEqual(first, { ok: true, code: 'cleanup_pending', persisted: true }, 'logical commit is never rolled back');
      assert.ok(events.indexOf('persist') < events.indexOf('commit:3'), 'cleanup marker precedes the logical-commit rename');
      assert.equal(readAt(workDir, `${DETAILS_REL}${ID}.md`), seeded.bodyText);
    }
    const recovered = archiveMemoryEntry(`ws-rename-${failAfter}`, workDir, PT, seeded.input, NOW);
    assert.deepEqual(recovered, { ok: true }, `fresh call recovers rename boundary ${failAfter}`);
    assertArchived(workDir, seeded.bodyText);
  }
});

test('a leftover archive-mover tmp does not break retry', () => {
  const workDir = mkWorkDir();
  const seeded = seedActive(workDir);
  writeAt(workDir, `${ARCHIVE_REL}${ID}.md.archive-mover.tmp`, 'stale partial bytes');
  const result = archiveMemoryEntry('ws-stale-tmp', workDir, PT, seeded.input, NOW);
  assert.deepEqual(result, { ok: true });
  assertArchived(workDir, seeded.bodyText);
  assert.equal(readAt(workDir, `${ARCHIVE_REL}${ID}.md.archive-mover.tmp`), null);
});

let passed = 0;
let failed = 0;
for (const item of tests) {
  try {
    item.run();
    console.log(`  ok  ${item.name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${item.name}`);
    console.error('       ', err instanceof Error ? err.stack || err.message : err);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
