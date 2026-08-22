import fs from 'node:fs';
import path from 'node:path';
import { ARC_BOUNDS_CONTRACT } from '../../shared/constants';

export type ArcSectionName = 'Decisions' | 'Work packages' | 'Deliberations' | 'Who did what';

export interface ArcBoundsMeasurements {
  artifactBytes: number;
  /** Advisory size target; exceeding it does not make validation fail. */
  artifactTargetBytes: number;
  overTarget: boolean;
  sectionRows: Record<ArcSectionName, number>;
}

export interface ArcBoundsValidationResult {
  ok: boolean;
  errors: string[];
  measurements: ArcBoundsMeasurements;
}

interface ArcRow {
  line: string;
  lineNumber: number;
}

const SECTION_CAPS: Record<ArcSectionName, number> = {
  Decisions: ARC_BOUNDS_CONTRACT.sectionRowCaps.decisions,
  'Work packages': ARC_BOUNDS_CONTRACT.sectionRowCaps.workPackages,
  Deliberations: ARC_BOUNDS_CONTRACT.sectionRowCaps.deliberations,
  'Who did what': ARC_BOUNDS_CONTRACT.sectionRowCaps.whoDidWhat,
};

/** Preferred decision-spine size. The hard rejecting cap remains 8 KiB. */
export const ARC_ARTIFACT_TARGET_BYTES = 4 * 1024;

const SECTION_NAMES = Object.keys(SECTION_CAPS) as ArcSectionName[];
const MARKDOWN_LINK_RE = /\[[^\]]*\]\(([^\s()]+\.md#[^\s()]+)\)/giu;
const BARE_LINK_RE = /(?:^|\s)([^\s()[\]<>]+\.md#[^\s()[\]<>]+)/giu;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function githubHeadingSlug(heading: string): string {
  return heading
    .replace(/<[^>]*>/gu, '')
    .replace(/[`*~]/gu, '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-');
}

function extractLinks(line: string): string[] {
  const links = new Set<string>();
  for (const match of line.matchAll(MARKDOWN_LINK_RE)) links.add(match[1]);
  for (const match of line.matchAll(BARE_LINK_RE)) links.add(match[1].replace(/[.,;:!?]+$/u, ''));
  return [...links];
}

function isRollupRow(line: string): boolean {
  return /^-\s*rollup\s*:/iu.test(line);
}

function isOverflowRow(line: string): boolean {
  return /^-\s*overflow\s*:/iu.test(line);
}

function omittedCount(line: string): number | null {
  const match = line.match(/\b(\d+)\b[^\n]*\bomitted\b/iu)
    ?? line.match(/\bomitted\b[^\n]*\b(\d+)\b/iu);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseSections(lines: string[], errors: string[]): Record<ArcSectionName, ArcRow[]> {
  const sections: Record<ArcSectionName, ArcRow[]> = {
    Decisions: [],
    'Work packages': [],
    Deliberations: [],
    'Who did what': [],
  };
  const seen = new Set<ArcSectionName>();
  let current: ArcSectionName | null = null;

  lines.forEach((line, index) => {
    const heading = line.match(/^##\s+(.+?)\s*$/u)?.[1];
    if (heading) {
      current = SECTION_NAMES.find((name) => name === heading) ?? null;
      if (current) {
        if (seen.has(current)) errors.push(`section heading cap: duplicate ## ${current}`);
        seen.add(current);
      }
      return;
    }
    if (current && /^-\s+/u.test(line)) {
      sections[current].push({ line, lineNumber: index + 1 });
    }
  });

  for (const name of SECTION_NAMES) {
    if (!seen.has(name)) errors.push(`required section cap: missing ## ${name}`);
  }
  return sections;
}

function resolveLink(planFolder: string, link: string): string | null {
  const hashIndex = link.lastIndexOf('#');
  if (hashIndex <= 0 || hashIndex === link.length - 1) return null;
  const rawRelPath = link.slice(0, hashIndex).replace(/\\/gu, '/');
  let relPath: string;
  try {
    relPath = decodeURIComponent(rawRelPath);
  } catch {
    return null;
  }
  if (path.posix.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) return null;
  if (relPath.split('/').some((part) => part === '..')) return null;
  const target = path.resolve(planFolder, ...relPath.split('/'));
  const relative = path.relative(planFolder, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return target;
}

function validateLink(planFolder: string, link: string, row: ArcRow, errors: string[]): void {
  const target = resolveLink(planFolder, link);
  if (!target) {
    errors.push(`link boundary cap at line ${row.lineNumber}: ${link} must be an in-folder relative path.md#anchor`);
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    errors.push(`link resolution cap at line ${row.lineNumber}: ${link} target does not exist`);
    return;
  }
  const realRoot = fs.realpathSync(planFolder);
  const realTarget = fs.realpathSync(target);
  const realRelative = path.relative(realRoot, realTarget);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    errors.push(`link boundary cap at line ${row.lineNumber}: ${link} resolves outside the plan folder`);
    return;
  }
  const anchor = link.slice(link.lastIndexOf('#') + 1).toLocaleLowerCase('en-US');
  const headings = fs.readFileSync(target, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/u)?.[1])
    .filter((heading): heading is string => heading !== undefined)
    .map(githubHeadingSlug);
  if (!headings.includes(anchor)) {
    errors.push(`link resolution cap at line ${row.lineNumber}: ${link} anchor does not resolve`);
  }
}

function validateOverflow(section: ArcSectionName, rows: ArcRow[], errors: string[]): void {
  const overflowRows = rows.filter((row) => isOverflowRow(row.line));
  if (overflowRows.length > 1) errors.push(`${section} overflow-row cap: expected at most 1, found ${overflowRows.length}`);
  for (const row of overflowRows) {
    const count = omittedCount(row.line);
    if (count === null || count <= 0) {
      errors.push(`${section} omitted-count cap at line ${row.lineNumber}: overflow must state a positive omitted count`);
    }
  }
}

function validateWorkPackageOmissions(rows: ArcRow[], errors: string[]): void {
  const rollup = rows.find((row) => isRollupRow(row.line));
  if (!rollup) return;
  const totalMatch = rollup.line.match(/\b\d+\s*\/\s*(\d+)\b/u);
  if (!totalMatch) return;
  const total = Number.parseInt(totalMatch[1], 10);
  const shown = rows.filter((row) => !isRollupRow(row.line) && !isOverflowRow(row.line)).length;
  const expectedOmitted = Math.max(0, total - shown);
  const overflow = rows.find((row) => isOverflowRow(row.line));
  if (expectedOmitted > 0 && !overflow) {
    errors.push(`Work packages omitted-count cap: rollup total ${total} requires an overflow row for ${expectedOmitted} omitted`);
    return;
  }
  if (overflow && omittedCount(overflow.line) !== expectedOmitted) {
    errors.push(`Work packages omitted-count cap at line ${overflow.lineNumber}: expected ${expectedOmitted} omitted from rollup total ${total}`);
  }
}

function validateDeliberationOrdering(rows: ArcRow[], errors: string[]): void {
  const indexed = rows.filter((row) => !isRollupRow(row.line) && !isOverflowRow(row.line));
  const rank = (line: string): number => /\binvalid\b/iu.test(line) ? 0 : /\bopen\b/iu.test(line) ? 1 : 2;
  let priorRank = -1;
  for (const row of indexed) {
    const currentRank = rank(row.line);
    if (currentRank < priorRank) {
      errors.push(`Deliberations invalid-then-open ordering cap at line ${row.lineNumber}: invalid rows must precede open rows, which must precede other statuses`);
      return;
    }
    priorRank = currentRank;
  }
}

function validateDeliberationOmissions(planFolder: string, rows: ArcRow[], errors: string[]): void {
  const planPath = path.join(planFolder, 'plan.md');
  if (!fs.existsSync(planPath) || !fs.statSync(planPath).isFile()) return;
  const intentIds = new Set(
    [...fs.readFileSync(planPath, 'utf8').matchAll(/"intent_id"\s*:\s*"(int_[A-Za-z0-9]+)"/gu)]
      .map((match) => match[1]),
  );
  if (intentIds.size === 0) return;
  const shownIds = new Set(
    rows
      .filter((row) => !isOverflowRow(row.line) && !isRollupRow(row.line))
      .flatMap((row) => [...row.line.matchAll(/\b(int_[A-Za-z0-9]+)\b/gu)].map((match) => match[1])),
  );
  const expectedOmitted = [...intentIds].filter((id) => !shownIds.has(id)).length;
  const overflow = rows.find((row) => isOverflowRow(row.line));
  if (expectedOmitted > 0 && !overflow) {
    errors.push(`Deliberations omitted-count cap: plan.md requires an overflow row for ${expectedOmitted} omitted intents`);
    return;
  }
  if (overflow && omittedCount(overflow.line) !== expectedOmitted) {
    errors.push(`Deliberations omitted-count cap at line ${overflow.lineNumber}: expected ${expectedOmitted} omitted intents from plan.md`);
  }
}

/** Layer-A deterministic ARC validation: synchronous file/text checks only. */
export function validateArcBounds(planFolder: string): ArcBoundsValidationResult {
  const errors: string[] = [];
  const arcPath = path.join(planFolder, 'ARC.md');
  if (!fs.existsSync(arcPath) || !fs.statSync(arcPath).isFile()) {
    return {
      ok: false,
      errors: ['artifact byte cap: ARC.md is missing'],
      measurements: {
        artifactBytes: 0,
        artifactTargetBytes: ARC_ARTIFACT_TARGET_BYTES,
        overTarget: false,
        sectionRows: { Decisions: 0, 'Work packages': 0, Deliberations: 0, 'Who did what': 0 },
      },
    };
  }

  const raw = fs.readFileSync(arcPath, 'utf8');
  const artifactBytes = byteLength(raw);
  if (artifactBytes > ARC_BOUNDS_CONTRACT.artifactMaxBytes) {
    errors.push(`artifact byte cap ${ARC_BOUNDS_CONTRACT.artifactMaxBytes}: ARC.md is ${artifactBytes} UTF-8 bytes`);
  }

  const sections = parseSections(raw.split(/\r?\n/u), errors);
  for (const section of SECTION_NAMES) {
    const rows = sections[section];
    const cap = SECTION_CAPS[section];
    const sourceRows = rows.filter((row) => !isRollupRow(row.line) && !isOverflowRow(row.line));
    if (sourceRows.length > cap) {
      errors.push(`${section} row cap ${cap}: found ${sourceRows.length} source-summary rows`);
    }
    for (const row of rows) {
      const bytes = byteLength(row.line);
      if (bytes > ARC_BOUNDS_CONTRACT.rowMaxBytes) {
        errors.push(`${section} per-row byte cap ${ARC_BOUNDS_CONTRACT.rowMaxBytes} at line ${row.lineNumber}: found ${bytes}`);
      }
      if (!isRollupRow(row.line)) {
        const links = extractLinks(row.line);
        if (links.length === 0) {
          errors.push(`${section} source-link cap at line ${row.lineNumber}: source-summary and overflow rows require path.md#anchor`);
        } else {
          for (const link of links) validateLink(planFolder, link, row, errors);
        }
      }
    }
    validateOverflow(section, rows, errors);
  }

  validateWorkPackageOmissions(sections['Work packages'], errors);
  validateDeliberationOrdering(sections.Deliberations, errors);
  validateDeliberationOmissions(planFolder, sections.Deliberations, errors);

  return {
    ok: errors.length === 0,
    errors,
    measurements: {
      artifactBytes,
      artifactTargetBytes: ARC_ARTIFACT_TARGET_BYTES,
      overTarget: artifactBytes > ARC_ARTIFACT_TARGET_BYTES,
      sectionRows: Object.fromEntries(SECTION_NAMES.map((name) => [name, sections[name].length])) as Record<ArcSectionName, number>,
    },
  };
}
