// Canonical pure logic for the resident memory and archive indexes.
// Keep this module portable: no filesystem or other Node-only APIs.

export const MEMORY_INDEX_BUDGET_BYTES = 25000;
export const MEMORY_INDEX_BUDGET_LINES = 200;
export const ARCHIVE_BUDGET_BYTES = 200000;
export const ARCHIVE_BUDGET_LINES = 2000;
export const STALE_ACTIVE_DAYS = 14;
export const NEVER_RECALLED_MIN_AGE_DAYS = 21;
export const CAP_PRESSURE_RATIO = 0.8;
export const RECALL_DETAIL_MAX_BYTES = 16384;
export const DISCLOSURE_FORMAT_MARKER = '<!-- disclosure-format: v2 -->';
export const ARCHIVE_FORMAT_MARKER = '<!-- memory-archive-format: v1 -->';
export const MEMORY_ID_GRAMMAR = /^mb-\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;
export const LESSON_SLUG_GRAMMAR = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MEMORY_DETAILS_DIR = '.lares/supervisor/memory/details/';
export const MEMORY_ARCHIVE_DIR = '.lares/supervisor/memory/archive/';
export const ARCHIVE_INDEX_REL = '.lares/supervisor/memory/archive/ARCHIVE.md';

export const MEMORY_STATUSES = ['active', 'archived'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type FindingSeverity = 'hard' | 'advisory';

export interface Finding {
  cls: string;
  severity: FindingSeverity;
  id: string | null;
  message: string;
  /** Concrete source range for entry-local findings. */
  blockStart?: number;
  blockEnd?: number;
}

export interface ParsedEntry {
  id: string;
  title: string;
  status: string;
  idDate: string | null;
  readIf: string | null;
  detail: string | null;
  fields: Record<string, string>;
  duplicateFields: string[];
  unexpectedContent: string[];
  blockStart: number;
  blockEnd: number;
  idMalformed: boolean;

  // Transitional reads retained until the launch-consumer package removes them.
  date: string | null;
  owner: string | null;
  consequence: string | null;
  state: string | null;
  openLoop: string | null;
  expires: string | null;
  expiresWhen: string | null;
}

export interface ParsedIndex {
  raw: string;
  normalized: string;
  byteLength: number;
  lineCount: number;
  hasMarker: boolean;
  markerMismatch: boolean;
  preamble: string;
  handoffReadFirst: string[] | null;
  handoffRange: [number, number] | null;
  entries: ParsedEntry[];
  bareScopedPkgs: Array<{ token: string }>;
}

export type DisposalKind = 'expires' | 'expires-when' | 'open-loop';
export interface ParsedDisposal {
  kind: DisposalKind;
  value: string | null;
  blockStart: number;
  blockEnd: number;
}
export type DisposalParseResult =
  | { ok: true; disposal: ParsedDisposal }
  | { ok: false; error: 'missing' | 'malformed'; message: string };

/** Matches the one permitted leading disposal block after BOM/CRLF normalization. */
export const DISPOSAL_BLOCK_RE = /^(?:[ \t]*\n)*<!-- memory-disposal:v1\n([\s\S]*?)\n-->(?:\n|$)/;

const _enc = new TextEncoder();
const _CAPSULE_HEADING = /^##\s+(mb-\S+?):\s*(.*)$/;
const _FIELD_LINE = /^-\s+([a-z][a-z-]*):\s*(.*)$/;
const _SCOPED_PKG_RE = /@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*/g;

export function utf8ByteLength(str: string): number {
  return _enc.encode(str).length;
}

export function countLines(text: string): number {
  const normalized = text.replace(/\r\n/g, '\n');
  let count = 1;
  for (let i = 0; i < normalized.length; i++) if (normalized.charCodeAt(i) === 10) count++;
  return count;
}

export function safeUtf8Truncate(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = _enc.encode(str);
  if (bytes.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder('utf-8').decode(bytes.slice(0, end));
}

export function isValidMemoryId(id: string): boolean {
  return MEMORY_ID_GRAMMAR.test(id);
}

export function detectBareScopedPkg(text: string): string[] {
  const noFenced = text.replace(/```[\s\S]*?```/g, ' ');
  const noInline = noFenced.replace(/`[^`\n]*`/g, ' ');
  const out: string[] = [];
  let match: RegExpExecArray | null;
  _SCOPED_PKG_RE.lastIndex = 0;
  while ((match = _SCOPED_PKG_RE.exec(noInline)) !== null) out.push(match[0]);
  return out;
}

function realGregorianDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.toISOString().slice(0, 10) === value;
}

/** Parse the exact memory-disposal:v1 grammar without reading the filesystem. */
export function parseDisposal(bodyText: string): DisposalParseResult {
  const normalized = bodyText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const markerCount = (normalized.match(/^<!-- memory-disposal:v1$/gm) ?? []).length;
  if (markerCount === 0) {
    return normalized.includes('<!-- memory-disposal:v1')
      ? { ok: false, error: 'malformed', message: 'memory-disposal:v1 opener must be exact' }
      : { ok: false, error: 'missing', message: 'missing leading memory-disposal:v1 block' };
  }
  if (markerCount !== 1) {
    return { ok: false, error: 'malformed', message: 'expected exactly one memory-disposal:v1 block' };
  }

  const match = DISPOSAL_BLOCK_RE.exec(normalized);
  if (!match) {
    return { ok: false, error: 'malformed', message: 'memory-disposal:v1 block must be first and exact' };
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const field = /^([a-z][a-z-]*):[ \t]*(.*)$/.exec(line);
    if (!field) return { ok: false, error: 'malformed', message: `invalid disposal content: ${line}` };
    const key = field[1];
    if (key !== 'kind' && key !== 'value') {
      return { ok: false, error: 'malformed', message: `unknown disposal key: ${key}` };
    }
    if (key in fields) return { ok: false, error: 'malformed', message: `duplicate disposal key: ${key}` };
    fields[key] = field[2].trim();
  }

  const kind = fields.kind;
  if (kind !== 'expires' && kind !== 'expires-when' && kind !== 'open-loop') {
    return { ok: false, error: 'malformed', message: `invalid disposal kind: ${kind ?? ''}` };
  }
  const hasValue = Object.prototype.hasOwnProperty.call(fields, 'value');
  if (kind === 'open-loop') {
    if (hasValue) return { ok: false, error: 'malformed', message: 'open-loop forbids value' };
  } else if (!hasValue) {
    return { ok: false, error: 'malformed', message: `${kind} requires value` };
  }
  if (kind === 'expires' && !realGregorianDate(fields.value)) {
    return { ok: false, error: 'malformed', message: 'expires value must be a real YYYY-MM-DD date' };
  }
  if (kind === 'expires-when' && !fields.value) {
    return { ok: false, error: 'malformed', message: 'expires-when value must be non-empty' };
  }

  return {
    ok: true,
    disposal: {
      kind,
      value: kind === 'open-loop' ? null : fields.value,
      blockStart: match.index,
      blockEnd: match.index + match[0].length,
    },
  };
}

function parseHandoff(preamble: string): { ids: string[] | null; range: [number, number] | null } {
  const heading = /^##\s+handoff-read-first\s*$/m.exec(preamble);
  if (!heading) return { ids: null, range: null };
  const afterHeading = heading.index + heading[0].length;
  const nextHeading = /^##\s+/m.exec(preamble.slice(afterHeading));
  const end = nextHeading ? afterHeading + nextHeading.index : preamble.length;
  const section = preamble.slice(heading.index, end);
  const ids: string[] = [];
  for (const line of section.split('\n').slice(1)) {
    const item = /^\s*\d+\.\s+(\S+)/.exec(line);
    if (item) ids.push(item[1]);
  }
  return { ids, range: [heading.index, end] };
}

function parseCatalog(text: string, marker: string, markerName: string): ParsedIndex {
  const raw = text;
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let hasMarker = false;
  let markerMismatch = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === marker) { hasMarker = true; break; }
    if (new RegExp(`^<!--\\s*${markerName}:`).test(trimmed)) markerMismatch = true;
  }

  const headings: Array<{ offset: number; lineIdx: number }> = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    if (_CAPSULE_HEADING.test(lines[i])) headings.push({ offset, lineIdx: i });
    offset += lines[i].length + 1;
  }
  const firstOffset = headings.length ? headings[0].offset : normalized.length;
  const preamble = normalized.slice(0, firstOffset);
  const handoff = parseHandoff(preamble);
  const entries: ParsedEntry[] = [];

  for (let h = 0; h < headings.length; h++) {
    const blockStart = headings[h].offset;
    const blockEnd = h + 1 < headings.length ? headings[h + 1].offset : normalized.length;
    const blockLines = normalized.slice(blockStart, blockEnd).split('\n');
    const heading = blockLines[0].match(_CAPSULE_HEADING)!;
    const id = heading[1];
    const fields: Record<string, string> = {};
    const duplicateFields: string[] = [];
    const unexpectedContent: string[] = [];
    for (const line of blockLines.slice(1)) {
      if (line.trim() === '') continue;
      const field = line.match(_FIELD_LINE);
      if (!field) {
        unexpectedContent.push(line);
        continue;
      }
      const key = field[1];
      if (key in fields) {
        if (!duplicateFields.includes(key)) duplicateFields.push(key);
      } else {
        fields[key] = field[2].trim();
      }
    }
    entries.push({
      id,
      title: heading[2].trim(),
      status: fields.status ?? 'active',
      idDate: /^mb-(\d{4}-\d{2}-\d{2})-/.exec(id)?.[1] ?? null,
      readIf: fields['read-if'] ?? null,
      detail: fields.detail ?? null,
      fields,
      duplicateFields,
      unexpectedContent,
      blockStart,
      blockEnd,
      idMalformed: !isValidMemoryId(id),
      date: fields.date ?? null,
      owner: fields.owner ?? null,
      consequence: fields.consequence ?? null,
      state: fields.state ?? null,
      openLoop: fields['open-loop'] ?? null,
      expires: fields.expires ?? null,
      expiresWhen: fields['expires-when'] ?? null,
    });
  }

  return {
    raw,
    normalized,
    byteLength: utf8ByteLength(raw),
    lineCount: countLines(raw),
    hasMarker,
    markerMismatch,
    preamble,
    handoffReadFirst: handoff.ids,
    handoffRange: handoff.range,
    entries,
    bareScopedPkgs: detectBareScopedPkg(normalized).map((token) => ({ token })),
  };
}

export function parseIndex(text: string): ParsedIndex {
  return parseCatalog(text, DISCLOSURE_FORMAT_MARKER, 'disclosure-format');
}

export function parseArchiveIndex(text: string): ParsedIndex {
  return parseCatalog(text, ARCHIVE_FORMAT_MARKER, 'memory-archive-format');
}

export interface ValidateResult { hard: Finding[]; advisory: Finding[] }

function hard(cls: string, id: string | null, message: string, entry?: ParsedEntry): Finding {
  return entry
    ? { cls, severity: 'hard', id, message, blockStart: entry.blockStart, blockEnd: entry.blockEnd }
    : { cls, severity: 'hard', id, message };
}

function advisory(cls: string, id: string | null, message: string): Finding {
  return { cls, severity: 'advisory', id, message };
}

function validateEntries(parsed: ParsedIndex, archive: boolean): Finding[] {
  const findings: Finding[] = [];
  const counts = new Map<string, number>();
  for (const entry of parsed.entries) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  for (const entry of parsed.entries) {
    if (entry.idMalformed) findings.push(hard('malformed-schema', entry.id, `malformed memory id: ${entry.id}`, entry));
    if ((counts.get(entry.id) ?? 0) > 1) findings.push(hard('duplicate-id', entry.id, `duplicate memory id: ${entry.id}`, entry));

    const allowed = archive ? new Set(['status', 'detail']) : new Set(['read-if', 'detail']);
    for (const key of Object.keys(entry.fields)) {
      if (!allowed.has(key)) findings.push(hard('unexpected-field', entry.id, `unexpected field "${key}" on ${entry.id}`, entry));
    }
    for (const key of entry.duplicateFields) {
      findings.push(hard('duplicate-field', entry.id, `duplicate field "${key}" on ${entry.id}`, entry));
    }
    if (entry.unexpectedContent.length) {
      findings.push(hard('unexpected-content', entry.id, `unexpected content in ${entry.id}`, entry));
    }

    if (archive) {
      if (entry.status !== 'archived') findings.push(hard('malformed-schema', entry.id, `archive entry ${entry.id} must have status archived`, entry));
    } else if (entry.status !== 'active') {
      findings.push(hard('malformed-schema', entry.id, `resident entry ${entry.id} must be active`, entry));
    }
    if (!entry.detail) findings.push(hard('missing-field', entry.id, `missing required field "detail" on ${entry.id}`, entry));
    if (!archive && !entry.readIf) findings.push(hard('missing-field', entry.id, `missing required field "read-if" on ${entry.id}`, entry));
  }
  return findings;
}

export function validateParsed(parsed: ParsedIndex): ValidateResult {
  const hardFindings = validateEntries(parsed, false);
  const advisoryFindings: Finding[] = [];
  if (!parsed.hasMarker) {
    hardFindings.push(hard('legacy-format', null, parsed.markerMismatch
      ? `disclosure-format marker mismatched; expected ${DISCLOSURE_FORMAT_MARKER}`
      : `missing ${DISCLOSURE_FORMAT_MARKER}`));
  }
  if (parsed.handoffReadFirst) {
    const ids = new Set(parsed.entries.map((entry) => entry.id));
    if (parsed.handoffReadFirst.length > 5) hardFindings.push(hard('invalid-handoff', null, 'handoff-read-first exceeds 5 entries'));
    for (const id of parsed.handoffReadFirst) {
      if (!isValidMemoryId(id) || !ids.has(id)) hardFindings.push(hard('invalid-handoff', id, `handoff-read-first references unknown/invalid id: ${id}`));
    }
  }
  for (const { token } of parsed.bareScopedPkgs) hardFindings.push(hard('bare-scoped-pkg', null, `unbackticked package token in prose: ${token}`));
  if (parsed.byteLength > MEMORY_INDEX_BUDGET_BYTES) hardFindings.push(hard('byte-budget', null, `index is ${parsed.byteLength} bytes (budget ${MEMORY_INDEX_BUDGET_BYTES})`));
  if (parsed.lineCount > MEMORY_INDEX_BUDGET_LINES) hardFindings.push(hard('line-budget', null, `index is ${parsed.lineCount} lines (budget ${MEMORY_INDEX_BUDGET_LINES})`));
  if (parsed.byteLength / MEMORY_INDEX_BUDGET_BYTES > CAP_PRESSURE_RATIO || parsed.lineCount / MEMORY_INDEX_BUDGET_LINES > CAP_PRESSURE_RATIO) {
    advisoryFindings.push(advisory('cap-pressure', null, `index over ${Math.round(CAP_PRESSURE_RATIO * 100)}% of a budget`));
  }
  return { hard: hardFindings, advisory: advisoryFindings };
}

export function validateArchiveParsed(parsed: ParsedIndex): ValidateResult {
  const hardFindings = validateEntries(parsed, true);
  const advisoryFindings: Finding[] = [];
  if (!parsed.hasMarker) {
    hardFindings.push(hard('legacy-archive-format', null, parsed.markerMismatch
      ? `memory archive marker mismatched; expected ${ARCHIVE_FORMAT_MARKER}`
      : `missing ${ARCHIVE_FORMAT_MARKER}`));
  }
  if (parsed.handoffReadFirst) {
    hardFindings.push(hard('unexpected-content', null, 'archive catalog forbids handoff-read-first'));
  }
  if (parsed.byteLength > ARCHIVE_BUDGET_BYTES || parsed.lineCount > ARCHIVE_BUDGET_LINES) {
    advisoryFindings.push(advisory('archive-growth', null, `archive is ${parsed.byteLength} bytes and ${parsed.lineCount} lines`));
  }
  return { hard: hardFindings, advisory: advisoryFindings };
}

export interface ProjectionBudget {
  bytes: number;
  lines: number;
  byteBudget: number;
  lineBudget: number;
  byteRatio: number;
  lineRatio: number;
  overBudget: boolean;
}

export interface ProjectionResult {
  expired: string[];
  spliced: Array<{ id: string; classes: string[] }>;
  shed: string[];
  blanked: false | { reason: string };
  degraded: boolean;
  injectText: string;
  budget: ProjectionBudget;
  /** @deprecated compatibility until launch consumers move to disposal facts. */
  hard: Finding[];
  /** @deprecated use expired. */
  dropped: string[];
  /** @deprecated supplied by the I/O disposal projection in the next package. */
  conditionReview: string[];
  /** @deprecated supplied by the I/O disposal projection in the next package. */
  staleActive: string[];
}

export interface ProjectParsedOptions {
  nowISO: string;
  entryFindings?: Finding[];
  expiredIds?: Iterable<string>;
  nonProjectionFindings?: Finding[];
}

const LOCAL_SPLICE_CLASSES = new Set([
  'malformed-schema', 'unexpected-field', 'unexpected-content', 'duplicate-field',
  'disposal-missing', 'disposal-malformed', 'detail-missing', 'detail-escape',
  'detail-unreadable', 'detail-root-mismatch', 'duplicate-id', 'missing-field',
]);
const GLOBAL_BLANK_CLASSES = new Set(['legacy-format', 'bare-scoped-pkg']);

function spliceRanges(source: string, ranges: Array<[number, number]>): string {
  if (!ranges.length) return source;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  const parts: string[] = [];
  for (const [start, end] of sorted) {
    if (start < cursor) continue;
    parts.push(source.slice(cursor, start));
    cursor = end;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}

function projectionBudget(text: string): ProjectionBudget {
  const bytes = utf8ByteLength(text);
  const lines = countLines(text);
  return {
    bytes,
    lines,
    byteBudget: MEMORY_INDEX_BUDGET_BYTES,
    lineBudget: MEMORY_INDEX_BUDGET_LINES,
    byteRatio: bytes / MEMORY_INDEX_BUDGET_BYTES,
    lineRatio: lines / MEMORY_INDEX_BUDGET_LINES,
    overBudget: bytes > MEMORY_INDEX_BUDGET_BYTES || lines > MEMORY_INDEX_BUDGET_LINES,
  };
}

export function projectParsed(parsed: ParsedIndex, opts: ProjectParsedOptions): ProjectionResult {
  void opts.nowISO;
  const validation = validateParsed(parsed);
  const allFindings = [...validation.hard, ...(opts.entryFindings ?? [])];
  const expiredSet = new Set(opts.expiredIds ?? []);
  const expired: string[] = [];
  const shed: string[] = [];
  const removedRanges: Array<[number, number]> = [];
  const removedEntries = new Set<ParsedEntry>();

  // Non-active records are never resident injection material.
  for (const entry of parsed.entries) {
    if (entry.status !== 'active') {
      removedRanges.push([entry.blockStart, entry.blockEnd]);
      removedEntries.add(entry);
    }
  }
  for (const entry of parsed.entries) {
    if (entry.status === 'active' && expiredSet.has(entry.id) && !removedEntries.has(entry)) {
      if (!expired.includes(entry.id)) expired.push(entry.id);
      removedRanges.push([entry.blockStart, entry.blockEnd]);
      removedEntries.add(entry);
    }
  }

  const classesById = new Map<string, Set<string>>();
  for (const finding of allFindings) {
    if (!finding.id || !LOCAL_SPLICE_CLASSES.has(finding.cls) || expiredSet.has(finding.id)) continue;
    const classes = classesById.get(finding.id) ?? new Set<string>();
    classes.add(finding.cls);
    classesById.set(finding.id, classes);
  }
  for (const entry of parsed.entries) {
    if (entry.status !== 'active' || removedEntries.has(entry) || !classesById.has(entry.id)) continue;
    removedRanges.push([entry.blockStart, entry.blockEnd]);
    removedEntries.add(entry);
  }
  const spliced = [...classesById.entries()]
    .filter(([id]) => parsed.entries.some((entry) => entry.id === id && entry.status === 'active'))
    .map(([id, classes]) => ({ id, classes: [...classes].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const invalidHandoff = allFindings.some((finding) => finding.cls === 'invalid-handoff');
  if (invalidHandoff && parsed.handoffRange) removedRanges.push(parsed.handoffRange);
  let candidate = spliceRanges(parsed.normalized, removedRanges);
  const protectedIds = invalidHandoff ? new Set<string>() : new Set(parsed.handoffReadFirst ?? []);
  const remaining = parsed.entries.filter((entry) => entry.status === 'active' && !removedEntries.has(entry));
  remaining.sort((a, b) => (a.idDate ?? '').localeCompare(b.idDate ?? '') || a.id.localeCompare(b.id));
  const shedOrder = [...remaining.filter((entry) => !protectedIds.has(entry.id)), ...remaining.filter((entry) => protectedIds.has(entry.id))];
  const global = allFindings.find((finding) => GLOBAL_BLANK_CLASSES.has(finding.cls));
  for (const entry of global ? [] : shedOrder) {
    if (!projectionBudget(candidate).overBudget) break;
    removedRanges.push([entry.blockStart, entry.blockEnd]);
    removedEntries.add(entry);
    if (!shed.includes(entry.id)) shed.push(entry.id);
    candidate = spliceRanges(parsed.normalized, removedRanges);
  }

  let blanked: false | { reason: string } = false;
  if (global) blanked = { reason: global.cls };
  else if (projectionBudget(candidate).overBudget) blanked = { reason: 'budget-unrecoverable' };

  const result = {
    expired,
    spliced,
    shed,
    blanked,
    degraded: spliced.length > 0 || shed.length > 0,
    injectText: blanked ? '' : candidate,
    budget: projectionBudget(candidate),
  } as ProjectionResult;

  // Keep old consumers compiling without changing the exact enumerable v2 shape.
  Object.defineProperties(result, {
    hard: { value: allFindings, enumerable: false },
    dropped: { value: expired, enumerable: false },
    conditionReview: { value: [], enumerable: false },
    staleActive: { value: [], enumerable: false },
  });
  return result;
}
