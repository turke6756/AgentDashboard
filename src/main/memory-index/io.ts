// Memory-index filesystem validation and the canonical validate/project seam.

import * as fs from 'fs';
import * as path from 'path';
import {
  ARCHIVE_INDEX_REL,
  MEMORY_ARCHIVE_DIR,
  MEMORY_DETAILS_DIR,
  parseArchiveIndex,
  parseDisposal,
  parseIndex,
  projectParsed,
  validateArchiveParsed,
  validateParsed,
  type DisposalKind,
  type Finding,
  type ParsedEntry,
  type ParsedIndex,
  type ProjectionResult,
} from '../../shared/memory-index-core';

export type DisposalErrorClass =
  | 'detail-missing'
  | 'detail-escape'
  | 'detail-unreadable'
  | 'detail-root-mismatch'
  | 'disposal-missing'
  | 'disposal-malformed';

export type ValidatedDisposal =
  | { kind: DisposalKind; value: string | null }
  | { error: DisposalErrorClass };

export interface IOValidateResult {
  hard: Finding[];
  advisory: Finding[];
  entryFindings: Finding[];
  nonProjectionFindings: Finding[];
  /** Validated lifecycle facts for resident (active) entries, keyed by id. */
  disposal: Map<string, ValidatedDisposal>;
  expiredIds: string[];
  conditionReview: string[];
  archiveParsed: ParsedIndex | null;
}

interface ValidateIOOptions {
  nowISO?: string;
  /** Avoid a second archive read when the canonical seam already parsed it. */
  archiveParsed?: ParsedIndex | null;
}

function hard(cls: string, id: string | null, message: string, entry?: ParsedEntry): Finding {
  return entry
    ? { cls, severity: 'hard', id, message, blockStart: entry.blockStart, blockEnd: entry.blockEnd }
    : { cls, severity: 'hard', id, message };
}

function isInsideDir(target: string, dir: string): boolean {
  const rel = path.relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function memoryDirs(workspaceRoot: string): {
  supervisorDir: string;
  detailsDir: string;
  archiveDir: string;
  memoryMd: string;
  archiveMd: string;
} {
  const detailsDir = path.join(workspaceRoot, ...MEMORY_DETAILS_DIR.split('/').filter(Boolean));
  const archiveDir = path.join(workspaceRoot, ...MEMORY_ARCHIVE_DIR.split('/').filter(Boolean));
  const supervisorDir = path.resolve(detailsDir, '..', '..');
  return {
    supervisorDir,
    detailsDir,
    archiveDir,
    memoryMd: path.join(supervisorDir, 'memory', 'MEMORY.md'),
    archiveMd: path.join(workspaceRoot, ...ARCHIVE_INDEX_REL.split('/').filter(Boolean)),
  };
}

function tryRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function readArchiveIfPresent(archiveMd: string): ParsedIndex | null {
  try {
    return parseArchiveIndex(fs.readFileSync(archiveMd, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function epochDay(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? NaN : Math.floor(ms / 86_400_000);
}

/**
 * Validate the live body store for the resident source and optional archive.
 * Body read failures are deliberately entry-local HARD findings; they never
 * escape this function as a launch-wide runtime error.
 */
export function validateIO(
  parsed: ParsedIndex,
  workspaceRoot: string,
  options: ValidateIOOptions = {},
): IOValidateResult {
  const hardFindings: Finding[] = [];
  const advisoryFindings: Finding[] = [];
  const entryFindings: Finding[] = [];
  const disposal = new Map<string, ValidatedDisposal>();
  const expiredIds: string[] = [];
  const conditionReview: string[] = [];
  const { supervisorDir, detailsDir, archiveDir, archiveMd } = memoryDirs(workspaceRoot);
  const canonicalDetailsDir = tryRealpath(detailsDir);
  const canonicalArchiveDir = tryRealpath(archiveDir);
  const archiveParsed = options.archiveParsed === undefined
    ? readArchiveIfPresent(archiveMd)
    : options.archiveParsed;
  const referencedDetails = new Set<string>();
  const referencedArchive = new Set<string>();

  const catalogs: Array<{ parsed: ParsedIndex; archived: boolean }> = [
    { parsed, archived: false },
    ...(archiveParsed ? [{ parsed: archiveParsed, archived: true }] : []),
  ];

  for (const catalog of catalogs) {
    for (const entry of catalog.parsed.entries) {
      const pointer = entry.detail;
      if (!pointer) continue;
      const candidate = path.resolve(supervisorDir, pointer);
      const real = tryRealpath(candidate);
      if (real === null) {
        const finding = hard('detail-missing', entry.id, `detail file for ${entry.id} does not exist: ${pointer}`, entry);
        hardFindings.push(finding);
        if (!catalog.archived) entryFindings.push(finding);
        if (!catalog.archived) disposal.set(entry.id, { error: 'detail-missing' });
        continue;
      }

      const inDetails = canonicalDetailsDir !== null && isInsideDir(real, canonicalDetailsDir);
      const inArchive = canonicalArchiveDir !== null && isInsideDir(real, canonicalArchiveDir);
      const expectedContained = catalog.archived ? inArchive : inDetails;
      if (!expectedContained) {
        const inKnownWrongRoot = catalog.archived ? inDetails : inArchive;
        const cls: DisposalErrorClass = inKnownWrongRoot ? 'detail-root-mismatch' : 'detail-escape';
        const expectedRoot = catalog.archived ? MEMORY_ARCHIVE_DIR : MEMORY_DETAILS_DIR;
        const finding = hard(cls, entry.id, `detail pointer for ${entry.id} does not resolve beneath ${expectedRoot}: ${pointer}`, entry);
        hardFindings.push(finding);
        if (!catalog.archived) entryFindings.push(finding);
        if (!catalog.archived) disposal.set(entry.id, { error: cls });
        continue;
      }

      (catalog.archived ? referencedArchive : referencedDetails).add(real);
      let body: string;
      try {
        body = fs.readFileSync(real, 'utf8');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const finding = hard('detail-unreadable', entry.id, `detail file for ${entry.id} could not be read: ${message}`, entry);
        hardFindings.push(finding);
        if (!catalog.archived) entryFindings.push(finding);
        if (!catalog.archived) disposal.set(entry.id, { error: 'detail-unreadable' });
        continue;
      }

      // Archived bodies have reached an end state. They are read to prove the
      // pointer is usable, but their preserved disposal block is not revalidated.
      if (catalog.archived) continue;
      const parsedDisposal = parseDisposal(body);
      if (!parsedDisposal.ok) {
        const cls = parsedDisposal.error === 'missing' ? 'disposal-missing' : 'disposal-malformed';
        const finding = hard(cls, entry.id, parsedDisposal.message, entry);
        hardFindings.push(finding);
        entryFindings.push(finding);
        disposal.set(entry.id, { error: cls });
        continue;
      }

      const fact = { kind: parsedDisposal.disposal.kind, value: parsedDisposal.disposal.value };
      disposal.set(entry.id, fact);
      if (fact.kind === 'expires' && fact.value && options.nowISO) {
        const expiry = epochDay(fact.value);
        const today = epochDay(options.nowISO.slice(0, 10));
        if (!Number.isNaN(expiry) && !Number.isNaN(today) && expiry < today) expiredIds.push(entry.id);
      } else if (fact.kind === 'expires-when') {
        conditionReview.push(entry.id);
      }
    }
  }

  const scanOrphans = (
    dir: string,
    canonicalDir: string | null,
    referenced: Set<string>,
    cls: 'orphan-details' | 'archive-orphan',
  ): void => {
    if (canonicalDir === null) return;
    let dirents: fs.Dirent[] = [];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
      if (cls === 'archive-orphan' && dirent.name === 'ARCHIVE.md') continue;
      const real = tryRealpath(path.join(dir, dirent.name));
      if (real !== null && !referenced.has(real)) {
        hardFindings.push(hard(cls, null, `${cls === 'archive-orphan' ? 'archive' : 'detail'} body has no catalog entry: ${dirent.name}`));
      }
    }
  };
  scanOrphans(detailsDir, canonicalDetailsDir, referencedDetails, 'orphan-details');
  scanOrphans(archiveDir, canonicalArchiveDir, referencedArchive, 'archive-orphan');

  if (archiveParsed) {
    const archiveValidation = validateArchiveParsed(archiveParsed);
    hardFindings.push(...archiveValidation.hard);
    advisoryFindings.push(...archiveValidation.advisory);
  }

  return {
    hard: hardFindings,
    advisory: advisoryFindings,
    entryFindings,
    nonProjectionFindings: hardFindings.filter((finding) => !entryFindings.includes(finding)),
    disposal,
    expiredIds: [...new Set(expiredIds)].sort(),
    conditionReview: [...new Set(conditionReview)].sort(),
    archiveParsed,
  };
}

export interface ReadValidateProjectResult {
  parsed: ParsedIndex;
  archiveParsed: ParsedIndex | null;
  hard: Finding[];
  advisory: Finding[];
  entryFindings: Finding[];
  nonProjectionFindings: Finding[];
  disposal: Map<string, ValidatedDisposal>;
  expiredIds: string[];
  conditionReview: string[];
  projection: ProjectionResult;
  injectText: string;
}

/** The one canonical validate + graded-project path over resident source text. */
export function validateProjectSource(
  sourceText: string,
  workspaceRoot: string,
  nowISO: string,
): ReadValidateProjectResult {
  const parsed = parseIndex(sourceText);
  const pure = validateParsed(parsed);
  const { archiveMd } = memoryDirs(workspaceRoot);
  const archiveParsed = readArchiveIfPresent(archiveMd);
  const io = validateIO(parsed, workspaceRoot, { nowISO, archiveParsed });
  const projection = projectParsed(parsed, {
    nowISO,
    entryFindings: io.entryFindings,
    expiredIds: io.expiredIds,
    nonProjectionFindings: io.nonProjectionFindings,
  });
  return {
    parsed,
    archiveParsed,
    hard: [...pure.hard, ...io.hard],
    advisory: [...pure.advisory, ...io.advisory],
    entryFindings: io.entryFindings,
    nonProjectionFindings: io.nonProjectionFindings,
    disposal: io.disposal,
    expiredIds: io.expiredIds,
    conditionReview: io.conditionReview,
    projection,
    injectText: projection.injectText,
  };
}

/** Thin live-disk wrapper around validateProjectSource. */
export function readValidateProject(workspaceRoot: string, nowISO: string): ReadValidateProjectResult {
  const { memoryMd } = memoryDirs(workspaceRoot);
  return validateProjectSource(fs.readFileSync(memoryMd, 'utf8'), workspaceRoot, nowISO);
}

export function deriveWorkspaceRootFromIndexPath(indexPath: string): string | null {
  const dir = path.dirname(path.resolve(indexPath));
  const suffix = path.join('.lares', 'supervisor', 'memory');
  const tail = path.sep + suffix;
  return dir.toLowerCase().endsWith(tail.toLowerCase())
    ? dir.slice(0, dir.length - tail.length)
    : null;
}
