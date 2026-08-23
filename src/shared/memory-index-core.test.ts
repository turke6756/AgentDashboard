import assert from 'assert';
import {
  ARCHIVE_FORMAT_MARKER,
  DISCLOSURE_FORMAT_MARKER,
  MEMORY_INDEX_BUDGET_BYTES,
  parseArchiveIndex,
  parseDisposal,
  parseIndex,
  projectParsed,
  validateArchiveParsed,
  validateParsed,
  type Finding,
} from './memory-index-core';

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void): void { tests.push({ name, fn }); }

function card(id: string, readIf = 'before changing memory behavior', detail = `memory/details/${id}.md`): string {
  return `## ${id}: Title\n- read-if: ${readIf}\n- detail: ${detail}\n`;
}

function resident(...cards: string[]): string {
  return `${DISCLOSURE_FORMAT_MARKER}\n\n${cards.join('\n')}`;
}

const disposalCases: Array<{ name: string; body: string; ok: boolean; kind?: string; value?: string | null }> = [
  {
    name: 'expires',
    body: '<!-- memory-disposal:v1\nkind: expires\nvalue: 2026-10-01\n-->\nBody',
    ok: true,
    kind: 'expires',
    value: '2026-10-01',
  },
  {
    name: 'BOM, leading blanks, and CRLF',
    body: '\uFEFF\r\n\t\r\n<!-- memory-disposal:v1\r\nkind: expires-when\r\nvalue: migration lands\r\n-->\r\nBody',
    ok: true,
    kind: 'expires-when',
    value: 'migration lands',
  },
  {
    name: 'open-loop without value',
    body: '<!-- memory-disposal:v1\nkind: open-loop\n-->\nBody',
    ok: true,
    kind: 'open-loop',
    value: null,
  },
  { name: '2026-02-30', body: '<!-- memory-disposal:v1\nkind: expires\nvalue: 2026-02-30\n-->\n', ok: false },
  { name: '2026-13-01', body: '<!-- memory-disposal:v1\nkind: expires\nvalue: 2026-13-01\n-->\n', ok: false },
  { name: 'duplicate keys', body: '<!-- memory-disposal:v1\nkind: open-loop\nkind: open-loop\n-->\n', ok: false },
  { name: 'open-loop with value', body: '<!-- memory-disposal:v1\nkind: open-loop\nvalue: nope\n-->\n', ok: false },
  { name: 'unknown key', body: '<!-- memory-disposal:v1\nkind: open-loop\nowner: agent\n-->\n', ok: false },
  { name: 'second block', body: '<!-- memory-disposal:v1\nkind: open-loop\n-->\n<!-- memory-disposal:v1\nkind: open-loop\n-->\n', ok: false },
  { name: 'not first content', body: 'prose\n<!-- memory-disposal:v1\nkind: open-loop\n-->\n', ok: false },
  { name: 'expires-when empty', body: '<!-- memory-disposal:v1\nkind: expires-when\nvalue:   \n-->\n', ok: false },
];

for (const row of disposalCases) {
  test(`REACHABILITY:parse-disposal: ${row.name}`, () => {
    const result = parseDisposal(row.body);
    assert.equal(result.ok, row.ok);
    if (result.ok) {
      assert.equal(result.disposal.kind, row.kind);
      assert.equal(result.disposal.value, row.value);
    }
  });
}

test('resident cards default active and derive idDate', () => {
  const parsed = parseIndex(resident(card('mb-2026-08-22-alpha')));
  assert.equal(parsed.entries[0].status, 'active');
  assert.equal(parsed.entries[0].idDate, '2026-08-22');
  assert.deepEqual(validateParsed(parsed).hard, []);
});

test('exact resident grammar rejects explicit status, duplicate fields, and prose with concrete ranges', () => {
  const id = 'mb-2026-08-22-legacy';
  const source = resident(
    `## ${id}: Legacy\n- status: active\n- read-if: before work\nlegacy prose must never inject\n- detail: memory/details/${id}.md\n- detail: memory/details/other.md\n`,
  );
  const parsed = parseIndex(source);
  const findings = validateParsed(parsed).hard;
  assert.deepEqual(new Set(findings.map((finding) => finding.cls)), new Set([
    'unexpected-field', 'duplicate-field', 'unexpected-content',
  ]));
  for (const finding of findings) {
    assert.equal(finding.blockStart, parsed.entries[0].blockStart);
    assert.equal(finding.blockEnd, parsed.entries[0].blockEnd);
  }
  const projection = projectParsed(parsed, { nowISO: '2026-08-22T00:00:00Z' });
  assert.equal(projection.injectText.includes('legacy prose must never inject'), false);
  assert.deepEqual(projection.spliced, [{
    id,
    classes: ['duplicate-field', 'unexpected-content', 'unexpected-field'],
  }]);
});

test('legacy consequence/state prose cannot reach injectText', () => {
  const id = 'mb-2026-08-22-old-fields';
  const source = resident(
    `## ${id}: Old\n- read-if: before work\n- detail: memory/details/${id}.md\n- consequence: SECRET LEGACY CONSEQUENCE\n- state: SECRET LEGACY STATE\n`,
  );
  const projection = projectParsed(parseIndex(source), { nowISO: '2026-08-22' });
  assert.equal(projection.injectText.includes('SECRET LEGACY'), false);
  assert.deepEqual(projection.spliced[0].classes, ['unexpected-field']);
});

test('archive profile accepts only status archived plus detail', () => {
  const id = 'mb-2026-08-22-archived';
  const good = `${ARCHIVE_FORMAT_MARKER}\n\n## ${id}: Archived\n- status: archived\n- detail: archive/${id}.md\n`;
  assert.deepEqual(validateArchiveParsed(parseArchiveIndex(good)).hard, []);
  const residentResult = validateParsed(parseIndex(good));
  assert.ok(residentResult.hard.some((finding) => finding.cls === 'legacy-format'));
});

test('projection outcomes are disjoint and expiry alone is not degradation', () => {
  const id = 'mb-2026-08-22-expired';
  const projection = projectParsed(parseIndex(resident(card(id))), {
    nowISO: '2026-08-22',
    expiredIds: [id],
    entryFindings: [{
      cls: 'disposal-malformed', severity: 'hard', id, message: 'bad disposal',
      blockStart: resident().length, blockEnd: resident(card(id)).length,
    }],
  });
  assert.deepEqual(projection.expired, [id]);
  assert.deepEqual(projection.spliced, []);
  assert.deepEqual(projection.shed, []);
  assert.equal(projection.degraded, false);
  assert.equal(projection.injectText.includes(id), false);
});

test('non-active blocks never reach resident injectText', () => {
  const id = 'mb-2026-08-22-archived-in-resident';
  const archived = `## ${id}: Archived\n- status: archived\n- detail: archive/${id}.md\n`;
  const projection = projectParsed(parseIndex(resident(archived, card('mb-2026-08-22-live'))), {
    nowISO: '2026-08-22',
  });
  assert.equal(projection.injectText.includes(id), false);
  assert.equal(projection.injectText.includes('mb-2026-08-22-live'), true);
  assert.deepEqual(projection.spliced, []);
  assert.equal(projection.degraded, false);
});

test('budget shedding is deterministic: idDate then id, with handoff protected last', () => {
  const filler = 'x'.repeat(7000);
  const a = card('mb-2026-08-01-a', filler);
  const b = card('mb-2026-08-01-b', filler);
  const oldProtected = card('mb-2026-07-01-protected', filler);
  const newest = card('mb-2026-08-20-newest', filler);
  const source = `${DISCLOSURE_FORMAT_MARKER}\n\n## handoff-read-first\n1. mb-2026-07-01-protected\n\n${a}\n${b}\n${oldProtected}\n${newest}`;
  const first = projectParsed(parseIndex(source), { nowISO: '2026-08-22' });
  const second = projectParsed(parseIndex(source), { nowISO: '2026-08-22' });
  assert.deepEqual(first.shed, ['mb-2026-08-01-a']);
  assert.equal(first.injectText, second.injectText);
  assert.deepEqual(first.shed, second.shed);
  assert.ok(first.budget.bytes <= MEMORY_INDEX_BUDGET_BYTES);
  assert.equal(first.injectText.includes('mb-2026-07-01-protected'), true);
});

test('global legacy format blanks instead of turning entry-local', () => {
  const projection = projectParsed(parseIndex(card('mb-2026-08-22-a')), { nowISO: '2026-08-22' });
  assert.deepEqual(projection.blanked, { reason: 'legacy-format' });
  assert.equal(projection.injectText, '');
});

test('an over-budget preamble is budget-unrecoverable after all entries are shed', () => {
  const preamble = `${DISCLOSURE_FORMAT_MARKER}\n${'p'.repeat(MEMORY_INDEX_BUDGET_BYTES + 1)}\n`;
  const projection = projectParsed(parseIndex(`${preamble}${card('mb-2026-08-22-only')}`), {
    nowISO: '2026-08-22',
  });
  assert.deepEqual(projection.shed, ['mb-2026-08-22-only']);
  assert.deepEqual(projection.blanked, { reason: 'budget-unrecoverable' });
  assert.equal(projection.injectText, '');
  assert.equal(projection.degraded, true);
});

test('projection exposes the exact enumerable v2 result fields', () => {
  const projection = projectParsed(parseIndex(resident(card('mb-2026-08-22-shape'))), { nowISO: '2026-08-22' });
  assert.deepEqual(Object.keys(projection).sort(), [
    'blanked', 'budget', 'degraded', 'expired', 'injectText', 'shed', 'spliced',
  ]);
});

let failed = 0;
for (const row of tests) {
  try {
    row.fn();
  } catch (error) {
    failed++;
    console.error(`FAIL ${row.name}`);
    console.error(error instanceof Error ? error.stack : error);
  }
}
console.log(`memory-index shared core: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
