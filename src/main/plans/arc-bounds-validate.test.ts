import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ARC_BOUNDS_CONTRACT } from '../../shared/constants';
import { validateArcBounds } from './arc-bounds-validate';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const OWN_PLAN = path.join(
  REPO_ROOT,
  '.lares',
  'plans',
  '2026-08-08-planning-surface-human-experience-overhaul-37cf5261',
);

interface Fixture {
  root: string;
  writeArc(content: string): void;
  dispose(): void;
}

function baseArc(overrides: Partial<Record<'Decisions' | 'Work packages' | 'Deliberations' | 'Who did what', string[]>> = {}): string {
  const sections = {
    Decisions: ['- Decision source.md#decisions'],
    'Work packages': ['- Rollup: 1/1 complete.', '- WP-1 complete. source.md#wp-1'],
    Deliberations: ['- int_a · folded-in · gloss. source.md#int-a'],
    'Who did what': ['- Agent completed work. source.md#who'],
    ...overrides,
  };
  return [
    '# ARC — Fixture',
    '<!--ARC-META {} -->',
    ...Object.entries(sections).flatMap(([heading, rows]) => [`## ${heading}`, ...rows]),
    '',
  ].join('\n');
}

function fixture(arc = baseArc()): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-bounds-'));
  fs.writeFileSync(path.join(root, 'source.md'), [
    '# Source',
    '## decisions',
    '## wp-1',
    '## int-a',
    '## int-b',
    '## who',
    '## overflow',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'plan.md'), '<!--PLAN-INTENT\n{"intent_id":"int_a"}\n-->\n');
  fs.writeFileSync(path.join(root, 'ARC.md'), arc);
  return {
    root,
    writeArc: (content) => fs.writeFileSync(path.join(root, 'ARC.md'), content),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function expectError(result: ReturnType<typeof validateArcBounds>, fragment: string): void {
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes(fragment)), result.errors.join('\n'));
}

test('REACHABILITY:wp11-arc-bounds enters validateArcBounds through this plan own ARC fixture', () => {
  const result = validateArcBounds(OWN_PLAN);
  assert.equal(result.ok, true, `REACHABILITY:wp11-arc-bounds\n${result.errors.join('\n')}`);
  assert.ok(result.measurements.artifactBytes <= ARC_BOUNDS_CONTRACT.artifactMaxBytes);
});

test('§R2 hard-bound prose is verbatim-identical to the shared contract constant', () => {
  const supportingPath = path.join(
    REPO_ROOT,
    '.lares',
    'proposals',
    'supporting',
    '2026-08-01-planning-surface-p0-p2-rescope.md',
  );
  const supporting = fs.readFileSync(supportingPath, 'utf8');
  const start = supporting.indexOf('<!-- ARC-BOUNDS-CONTRACT:START -->');
  const endMarker = '<!-- ARC-BOUNDS-CONTRACT:END -->';
  const end = supporting.indexOf(endMarker, start);
  assert.ok(start >= 0 && end >= start, '§R2 must contain the bounded-contract markers');
  assert.equal(supporting.slice(start, end + endMarker.length), ARC_BOUNDS_CONTRACT.markdown);
});

test('names the 8 KiB artifact byte cap', () => {
  const f = fixture();
  try {
    f.writeArc(`${baseArc()}${'x'.repeat(ARC_BOUNDS_CONTRACT.artifactMaxBytes)}`);
    expectError(validateArcBounds(f.root), 'artifact byte cap 8192');
  } finally {
    f.dispose();
  }
});

test('names the 200-byte per-row cap', () => {
  const f = fixture(baseArc({ Decisions: [`- ${'x'.repeat(210)} source.md#decisions`] }));
  try {
    expectError(validateArcBounds(f.root), 'Decisions per-row byte cap 200');
  } finally {
    f.dispose();
  }
});

test('names every per-section row cap', () => {
  const cases: Array<['Decisions' | 'Work packages' | 'Deliberations' | 'Who did what', number]> = [
    ['Decisions', ARC_BOUNDS_CONTRACT.sectionRowCaps.decisions],
    ['Work packages', ARC_BOUNDS_CONTRACT.sectionRowCaps.workPackages],
    ['Deliberations', ARC_BOUNDS_CONTRACT.sectionRowCaps.deliberations],
    ['Who did what', ARC_BOUNDS_CONTRACT.sectionRowCaps.whoDidWhat],
  ];
  for (const [section, cap] of cases) {
    const rows = Array.from({ length: cap + 1 }, (_, index) =>
      section === 'Deliberations'
        ? `- int_${index} · folded-in · gloss. source.md#int-a`
        : `- row ${index}. source.md#decisions`);
    const f = fixture(baseArc({ [section]: rows }));
    try {
      expectError(validateArcBounds(f.root), `${section} row cap ${cap}`);
    } finally {
      f.dispose();
    }
  }
});

test('rejects traversal, absolute paths, and unresolved anchors', () => {
  const cases = [
    ['../outside.md#decisions', 'link boundary cap'],
    ['C:/outside.md#decisions', 'link boundary cap'],
    ['source.md#missing', 'anchor does not resolve'],
  ];
  for (const [link, message] of cases) {
    const f = fixture(baseArc({ Decisions: [`- Decision ${link}`] }));
    try {
      expectError(validateArcBounds(f.root), message);
    } finally {
      f.dispose();
    }
  }
});

test('requires source and overflow links but exempts rollup metadata', () => {
  const f = fixture(baseArc({ Decisions: ['- Decision without a source'] }));
  try {
    expectError(validateArcBounds(f.root), 'Decisions source-link cap');
  } finally {
    f.dispose();
  }
});

test('enforces invalid-then-open deliberation index ordering', () => {
  const f = fixture(baseArc({
    Deliberations: [
      '- int_a · open · gloss. source.md#int-a',
      '- int_b · invalid · gloss. source.md#int-b',
    ],
  }));
  try {
    expectError(validateArcBounds(f.root), 'Deliberations invalid-then-open ordering cap');
  } finally {
    f.dispose();
  }
});

test('checks work-package overflow omitted count against the rollup total', () => {
  const f = fixture(baseArc({
    'Work packages': [
      '- Rollup: 1/3 complete.',
      '- WP-1 complete. source.md#wp-1',
      '- Overflow: 1 row omitted. source.md#overflow',
    ],
  }));
  try {
    expectError(validateArcBounds(f.root), 'Work packages omitted-count cap');
  } finally {
    f.dispose();
  }
});

test('checks deliberation overflow omitted count against plan.md intents', () => {
  const f = fixture(baseArc({
    Deliberations: [
      '- int_a · open · gloss. source.md#int-a',
      '- Overflow: 2 intents omitted. source.md#overflow',
    ],
  }));
  try {
    fs.writeFileSync(path.join(f.root, 'plan.md'), [
      '<!--PLAN-INTENT {"intent_id":"int_a"} -->',
      '<!--PLAN-INTENT {"intent_id":"int_b"} -->',
    ].join('\n'));
    expectError(validateArcBounds(f.root), 'Deliberations omitted-count cap');
  } finally {
    f.dispose();
  }
});
