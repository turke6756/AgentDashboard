// Pure memory-index core regression suite run by scripts/run-main-tests.mjs.
//
// Retired with the v3 card/body inversion (§3.1-3.2): card-level expires and
// expires-when projection, expires-today handling, conditionReview/staleActive,
// required consequence/state, and the active-card exit requirement. Disposal
// grammar now lives in the shared core suite; I/O lifecycle facts enter through
// projectParsed options and receive filesystem coverage in the I/O package.

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  CAP_PRESSURE_RATIO,
  DISCLOSURE_FORMAT_MARKER,
  MEMORY_INDEX_BUDGET_BYTES,
  MEMORY_INDEX_BUDGET_LINES,
  countLines,
  detectBareScopedPkg,
  isValidMemoryId,
  parseIndex,
  projectParsed,
  safeUtf8Truncate,
  utf8ByteLength,
  validateParsed,
  type Finding,
} from '../../shared/memory-index-core';

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void): void { tests.push({ name, fn }); }

function card(id: string, over: Record<string, string> = {}): string {
  const fields = {
    'read-if': 'before editing the memory schema',
    detail: `memory/details/${id}.md`,
    ...over,
  };
  return [`## ${id}: Title`, ...Object.entries(fields).map(([key, value]) => `- ${key}: ${value}`)].join('\n');
}

function index(...blocks: string[]): string {
  return `${DISCLOSURE_FORMAT_MARKER}\n\n${blocks.join('\n\n')}\n`;
}

const clsSet = (findings: Finding[]): Set<string> => new Set(findings.map((finding) => finding.cls));

test('projection: lifecycle facts expire only the named entry without degradation', () => {
  const expired = 'mb-2026-07-01-expired';
  const live = 'mb-2026-07-02-live';
  const projection = projectParsed(parseIndex(index(card(expired), card(live))), {
    nowISO: '2026-08-22',
    expiredIds: [expired],
  });
  assert.deepEqual(projection.expired, [expired]);
  assert.deepEqual(projection.spliced, []);
  assert.deepEqual(projection.shed, []);
  assert.equal(projection.degraded, false);
  assert.equal(projection.injectText.includes(expired), false);
  assert.equal(projection.injectText.includes(live), true);
});

test('projection: deterministic and input-preserving', () => {
  const source = index(card('mb-2026-07-01-a'), card('mb-2026-07-02-b'));
  const parsed = parseIndex(source);
  const before = parsed.normalized;
  const first = projectParsed(parsed, { nowISO: '2026-08-22', expiredIds: ['mb-2026-07-01-a'] });
  const second = projectParsed(parsed, { nowISO: '2026-08-22', expiredIds: ['mb-2026-07-01-a'] });
  assert.equal(first.injectText, second.injectText);
  assert.deepEqual(first.expired, second.expired);
  assert.equal(parsed.normalized, before);
});

test('projection: local malformed status is spliced and degraded', () => {
  const id = 'mb-2026-07-28-status';
  const projection = projectParsed(parseIndex(index(card(id, { status: 'wibble' }))), { nowISO: '2026-08-22' });
  assert.deepEqual(projection.spliced, [{ id, classes: ['malformed-schema', 'unexpected-field'] }]);
  assert.equal(projection.degraded, true);
  assert.equal(projection.injectText.includes(id), false);
});

test('projection: duplicate ids withhold every matching block', () => {
  const id = 'mb-2026-07-28-dup';
  const projection = projectParsed(parseIndex(index(card(id), card(id, { 'read-if': 'another trigger' }))), {
    nowISO: '2026-08-22',
  });
  assert.deepEqual(projection.spliced, [{ id, classes: ['duplicate-id'] }]);
  assert.equal(projection.injectText.includes(id), false);
});

test('hard: legacy-format when marker is missing or mismatched', () => {
  const missing = validateParsed(parseIndex(card('mb-2026-07-28-a')));
  assert.ok(clsSet(missing.hard).has('legacy-format'));
  const mismatched = parseIndex(`<!-- disclosure-format: v1 -->\n\n${card('mb-2026-07-28-a')}\n`);
  assert.equal(mismatched.markerMismatch, true);
  assert.ok(clsSet(validateParsed(mismatched).hard).has('legacy-format'));
});

test('hard: malformed memory id', () => {
  const result = validateParsed(parseIndex(index(card('mb-BADID'))));
  assert.ok(clsSet(result.hard).has('malformed-schema'));
});

test('hard: exact resident grammar requires read-if and detail', () => {
  const noReadIf = `## mb-2026-07-28-a: T\n- detail: memory/details/mb-2026-07-28-a.md`;
  const noDetail = `## mb-2026-07-28-b: T\n- read-if: before work`;
  const result = validateParsed(parseIndex(index(noReadIf, noDetail)));
  assert.equal(result.hard.filter((finding) => finding.cls === 'missing-field').length, 2);
});

test('hard: retired card fields are unexpected and their block is not injectable', () => {
  const id = 'mb-2026-07-28-legacy';
  const source = index(card(id, { consequence: 'legacy secret', state: 'legacy state', 'open-loop': 'legacy exit' }));
  const result = validateParsed(parseIndex(source));
  assert.equal(result.hard.filter((finding) => finding.cls === 'unexpected-field').length, 3);
  const projection = projectParsed(parseIndex(source), { nowISO: '2026-08-22' });
  assert.equal(projection.injectText.includes('legacy secret'), false);
});

test('hard: duplicate fields and non-field prose have concrete block ranges', () => {
  const id = 'mb-2026-07-28-content';
  const source = index(`## ${id}: T\n- read-if: one\nlegacy prose\n- detail: memory/details/${id}.md\n- detail: other.md`);
  const parsed = parseIndex(source);
  const findings = validateParsed(parsed).hard;
  assert.ok(clsSet(findings).has('duplicate-field'));
  assert.ok(clsSet(findings).has('unexpected-content'));
  for (const finding of findings) {
    assert.equal(finding.blockStart, parsed.entries[0].blockStart);
    assert.equal(finding.blockEnd, parsed.entries[0].blockEnd);
  }
});

test('hard: invalid handoff when unknown or over five', () => {
  const unknown = `${DISCLOSURE_FORMAT_MARKER}\n\n## handoff-read-first\n1. mb-2026-07-28-nope\n\n${card('mb-2026-07-28-a')}\n`;
  assert.ok(clsSet(validateParsed(parseIndex(unknown)).hard).has('invalid-handoff'));
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map((suffix) => `mb-2026-07-28-${suffix}`);
  const handoff = ids.map((id, i) => `${i + 1}. ${id}`).join('\n');
  const overFive = `${DISCLOSURE_FORMAT_MARKER}\n\n## handoff-read-first\n${handoff}\n\n${ids.map((id) => card(id)).join('\n\n')}\n`;
  assert.ok(clsSet(validateParsed(parseIndex(overFive)).hard).has('invalid-handoff'));
});

test('valid handoff is clean and preserves order', () => {
  const source = `${DISCLOSURE_FORMAT_MARKER}\n\n## handoff-read-first\n1. mb-2026-07-28-b\n2. mb-2026-07-28-a\n\n${card('mb-2026-07-28-a')}\n\n${card('mb-2026-07-28-b')}\n`;
  const parsed = parseIndex(source);
  assert.deepEqual(parsed.handoffReadFirst, ['mb-2026-07-28-b', 'mb-2026-07-28-a']);
  assert.equal(validateParsed(parsed).hard.length, 0);
});

test('hard: byte and line budgets', () => {
  const byteHeavy = index(card('mb-2026-07-28-a', { 'read-if': 'x'.repeat(MEMORY_INDEX_BUDGET_BYTES + 100) }));
  assert.ok(clsSet(validateParsed(parseIndex(byteHeavy)).hard).has('byte-budget'));
  const lineHeavy = `${DISCLOSURE_FORMAT_MARKER}\n${Array.from({ length: MEMORY_INDEX_BUDGET_LINES + 5 }, () => 'preamble').join('\n')}\n${card('mb-2026-07-28-a')}\n`;
  assert.ok(clsSet(validateParsed(parseIndex(lineHeavy)).hard).has('line-budget'));
});

test('advisory: cap pressure and clean small index', () => {
  const pressured = index(card('mb-2026-07-28-a', {
    'read-if': 'y'.repeat(Math.ceil(MEMORY_INDEX_BUDGET_BYTES * CAP_PRESSURE_RATIO) + 200),
  }));
  const result = validateParsed(parseIndex(pressured));
  assert.equal(result.hard.length, 0);
  assert.ok(clsSet(result.advisory).has('cap-pressure'));
  const clean = validateParsed(parseIndex(index(card('mb-2026-07-28-clean'))));
  assert.equal(clean.hard.length, 0);
  assert.equal(clean.advisory.length, 0);
});

test('scoped package detection respects code spans and fences', () => {
  assert.deepEqual(detectBareScopedPkg('```\n@acme/widgets\n```'), []);
  assert.deepEqual(detectBareScopedPkg('use `@acme/widgets` here'), []);
  assert.deepEqual(detectBareScopedPkg('bare @acme/widgets here'), ['@acme/widgets']);
  const bad = validateParsed(parseIndex(index(card('mb-2026-07-28-a', { 'read-if': 'install @acme/widgets' }))));
  assert.ok(clsSet(bad.hard).has('bare-scoped-pkg'));
});

test('UTF-8 and line helpers retain their contract', () => {
  assert.equal(utf8ByteLength('é'), 2);
  assert.equal(utf8ByteLength('😀'), 4);
  assert.equal(countLines(''), 1);
  assert.equal(countLines('a\r\nb\r\nc'), 3);
  assert.equal(safeUtf8Truncate('a😀', 2), 'a');
  assert.equal(safeUtf8Truncate('a😀', 5), 'a😀');
  assert.equal(safeUtf8Truncate('hello', 0), '');
});

test('memory id grammar remains frozen', () => {
  assert.ok(isValidMemoryId('mb-2026-07-28-a-b-9'));
  assert.ok(!isValidMemoryId('mb-2026-7-28-slug'));
  assert.ok(!isValidMemoryId('mb-2026-07-28-Slug'));
  assert.ok(!isValidMemoryId('memory-2026-07-28-slug'));
});

test('core module imports no fs / realpath', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/shared/memory-index-core.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/\bfrom ['"](node:)?fs['"]/.test(code));
  assert.ok(!/\brequire\((['"])(node:)?fs\1\)/.test(code));
  assert.ok(!/realpath/i.test(code));
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
console.log(`memory-index core: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
