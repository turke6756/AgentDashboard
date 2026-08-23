// Crash-safe resident-memory -> archive mover (plan_1fe663ce WP-5).
//
// The two index renames cannot be one filesystem transaction. MEMORY.md is
// therefore the authority until its card is removed; that removal is the
// logical commit point. classifyArchiveState runs under the shared scaffold
// lock before the ordinary CAS so retries after that point finish cleanup
// instead of incorrectly reporting cas_mismatch.

import crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ARCHIVE_FORMAT_MARKER,
  ARCHIVE_INDEX_REL,
  MEMORY_ARCHIVE_DIR,
  MEMORY_DETAILS_DIR,
  parseArchiveIndex,
  parseDisposal,
  parseIndex,
  validateArchiveParsed,
  type ParsedEntry,
} from '../../shared/memory-index-core';
import {
  acquireWorkspaceLock,
  atomicWriteScaffoldText,
  commitStagedRename,
  deleteScaffoldFile,
  listScaffoldDir,
  readScaffoldText,
  scaffoldFileExists,
  stageTextFile,
} from '../scaffold-writer';
import { readValidateProject } from './io';
import { upsertFindings } from './review-store';
import type { BundleErrorCode } from './bundle-migration';

const INDEX_REL = MEMORY_DETAILS_DIR.replace(/details\/?$/, 'MEMORY.md');
const ACTIVE_POINTER_PREFIX = 'memory/details/';
const ARCHIVE_POINTER_PREFIX = 'memory/archive/';
const INDEX_TMP_REL = `${INDEX_REL}.archive-mover.tmp`;
const ARCHIVE_INDEX_TMP_REL = `${ARCHIVE_INDEX_REL}.archive-mover.tmp`;

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface ArchiveMemoryInput {
  id: string;
  expectedPriorHash: string;
  expectedBodyHash: string;
}

export type ArchiveMemoryResult =
  | { ok: true; code?: 'cleanup_pending' }
  | {
      ok: false;
      code: BundleErrorCode;
      message: string;
      findings?: Array<{ cls: string; id: string | null; message: string }>;
    };

type ArchiveState =
  | {
      kind: 'active';
      residentSource: string;
      archiveSource: string | null;
      entry: ParsedEntry;
      body: string;
      archiveBodyPreexisted: boolean;
    }
  | {
      kind: 'committed';
      residentSource: string;
      archiveSource: string;
      archiveBody: string;
      cleanupBody: string | null;
    }
  | { kind: 'conflict'; message: string };

function bodyRel(dir: string, id: string): string {
  return `${dir}${id}.md`;
}

function exactArchiveEntry(entry: ParsedEntry, id: string): boolean {
  return entry.id === id &&
    entry.status === 'archived' &&
    entry.detail === `${ARCHIVE_POINTER_PREFIX}${id}.md` &&
    Object.keys(entry.fields).length === 2 &&
    entry.fields.status === 'archived' &&
    entry.duplicateFields.length === 0 &&
    entry.unexpectedContent.length === 0;
}

/**
 * Classify the only two recoverable states. The caller must hold the shared
 * scaffold lock. An archive target with differing bytes is always a conflict;
 * it is never overwritten.
 */
export function classifyArchiveState(
  workDir: string,
  pathType: string,
  input: ArchiveMemoryInput,
): ArchiveState {
  const residentSource = readScaffoldText(workDir, INDEX_REL, pathType);
  if (residentSource === null) return { kind: 'conflict', message: 'resident MEMORY.md is missing or unreadable' };

  const archiveSource = readScaffoldText(workDir, ARCHIVE_INDEX_REL, pathType);
  const activeMatches = parseIndex(residentSource).entries.filter((entry) => entry.id === input.id);
  const archivedMatches = archiveSource === null
    ? []
    : parseArchiveIndex(archiveSource).entries.filter((entry) => entry.id === input.id);
  if (activeMatches.length > 1 || archivedMatches.length > 1) {
    return { kind: 'conflict', message: `duplicate catalog record for ${input.id}` };
  }

  const active = activeMatches[0];
  const archived = archivedMatches[0];
  const sourceRel = bodyRel(MEMORY_DETAILS_DIR, input.id);
  const targetRel = bodyRel(MEMORY_ARCHIVE_DIR, input.id);
  const sourceBody = readScaffoldText(workDir, sourceRel, pathType);
  const archiveBody = readScaffoldText(workDir, targetRel, pathType);

  if (archived && !exactArchiveEntry(archived, input.id)) {
    return { kind: 'conflict', message: `archive record for ${input.id} is not the exact archived record` };
  }

  if (active) {
    if (active.status !== 'active' || active.detail !== `${ACTIVE_POINTER_PREFIX}${input.id}.md`) {
      return { kind: 'conflict', message: `resident record for ${input.id} is not an exact active record` };
    }
    if (sourceBody === null) {
      return { kind: 'conflict', message: `resident body for ${input.id} is missing or unreadable` };
    }
    if (archiveBody !== null && sha256Hex(archiveBody) !== sha256Hex(sourceBody)) {
      return { kind: 'conflict', message: `archive body for ${input.id} differs; refusing to overwrite` };
    }
    // A matching body without a record is the safe crash state after copy
    // (step 2) but before ARCHIVE.md add (step 3). A record without its body is
    // incomplete/corrupt and cannot be resumed safely.
    if (archived !== undefined && archiveBody === null) {
      return { kind: 'conflict', message: `incomplete archive intermediate for ${input.id}` };
    }
    return {
      kind: 'active', residentSource, archiveSource, entry: active, body: sourceBody,
      archiveBodyPreexisted: archiveBody !== null,
    };
  }

  if (archived && archiveBody !== null && sha256Hex(archiveBody) === input.expectedBodyHash) {
    if (sourceBody !== null && sha256Hex(sourceBody) !== input.expectedBodyHash) {
      return { kind: 'conflict', message: `post-commit cleanup body for ${input.id} diverged` };
    }
    return {
      kind: 'committed', residentSource, archiveSource: archiveSource!, archiveBody,
      cleanupBody: sourceBody,
    };
  }

  return { kind: 'conflict', message: `no recoverable archive state for ${input.id}` };
}

function withoutEntry(source: string, entry: ParsedEntry): string {
  return source.slice(0, entry.blockStart) + source.slice(entry.blockEnd);
}

function archivedRecord(entry: ParsedEntry, id: string): string {
  return [
    `## ${id}: ${entry.title}`,
    '- status: archived',
    `- detail: ${ARCHIVE_POINTER_PREFIX}${id}.md`,
  ].join('\n');
}

function withArchiveEntry(source: string | null, entry: ParsedEntry, id: string): string {
  const base = source ?? `${ARCHIVE_FORMAT_MARKER}\n`;
  const separator = base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n';
  return `${base}${separator}${archivedRecord(entry, id)}\n`;
}

interface ValidationFinding { cls: string; id: string | null; message: string }

/**
 * Materialize the proposed final resident+archive catalogs and both body
 * inventories in one temp workspace, then validate the complete bundle before
 * any live mutation. This deliberately validates the final state (the id occurs
 * in exactly one catalog), not the recoverable both-catalog intermediate.
 */
function validateFinalBundle(
  workDir: string,
  pathType: string,
  input: ArchiveMemoryInput,
  residentSource: string,
  archiveSource: string,
  body: string,
  nowISO: string,
): ValidationFinding[] {
  let tmpRoot: string | null = null;
  try {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-mover-validate-'));
    const writeMirror = (rel: string, content: string): void => {
      const dest = path.join(tmpRoot!, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content, 'utf8');
    };

    writeMirror(INDEX_REL, residentSource);
    writeMirror(ARCHIVE_INDEX_REL, archiveSource);
    for (const name of listScaffoldDir(workDir, MEMORY_DETAILS_DIR, pathType)) {
      if (name.endsWith('.tmp') || name === `${input.id}.md`) continue;
      const content = readScaffoldText(workDir, `${MEMORY_DETAILS_DIR}${name}`, pathType);
      if (content !== null) writeMirror(`${MEMORY_DETAILS_DIR}${name}`, content);
    }
    for (const name of listScaffoldDir(workDir, MEMORY_ARCHIVE_DIR, pathType)) {
      if (name === 'ARCHIVE.md' || name.endsWith('.tmp') || name === `${input.id}.md`) continue;
      const content = readScaffoldText(workDir, `${MEMORY_ARCHIVE_DIR}${name}`, pathType);
      if (content !== null) writeMirror(`${MEMORY_ARCHIVE_DIR}${name}`, content);
    }
    writeMirror(bodyRel(MEMORY_ARCHIVE_DIR, input.id), body);

    const findings: ValidationFinding[] = readValidateProject(tmpRoot, nowISO).hard
      .map((finding) => ({ cls: finding.cls, id: finding.id, message: finding.message }));
    const resident = parseIndex(residentSource);
    const archive = parseArchiveIndex(archiveSource);
    findings.push(...validateArchiveParsed(archive).hard
      .map((finding) => ({ cls: finding.cls, id: finding.id, message: finding.message })));

    const residentIds = new Set(resident.entries.map((entry) => entry.id));
    for (const entry of archive.entries) {
      if (residentIds.has(entry.id)) findings.push({ cls: 'duplicate-id', id: entry.id, message: `memory id occurs in both catalogs: ${entry.id}` });
      if (entry.detail !== `${ARCHIVE_POINTER_PREFIX}${entry.id}.md`) {
        findings.push({ cls: 'detail-root-mismatch', id: entry.id, message: `archived detail must be under ${ARCHIVE_POINTER_PREFIX}` });
      }
      if (!scaffoldFileExists(tmpRoot, bodyRel(MEMORY_ARCHIVE_DIR, entry.id), 'windows')) {
        findings.push({ cls: 'detail-missing', id: entry.id, message: `archive body is missing for ${entry.id}` });
      }
    }
    for (const entry of resident.entries) {
      if (entry.detail !== `${ACTIVE_POINTER_PREFIX}${entry.id}.md`) {
        findings.push({ cls: 'detail-root-mismatch', id: entry.id, message: `active detail must be under ${ACTIVE_POINTER_PREFIX}` });
        continue;
      }
      const activeBody = readScaffoldText(tmpRoot, bodyRel(MEMORY_DETAILS_DIR, entry.id), 'windows');
      if (activeBody !== null) {
        const disposal = parseDisposal(activeBody);
        if (!disposal.ok) findings.push({ cls: disposal.error === 'missing' ? 'disposal-missing' : 'disposal-malformed', id: entry.id, message: disposal.message });
      }
    }

    const archiveIds = new Set(archive.entries.map((entry) => `${entry.id}.md`));
    const archiveDir = path.join(tmpRoot, ...MEMORY_ARCHIVE_DIR.split('/').filter(Boolean));
    for (const name of fs.readdirSync(archiveDir, { withFileTypes: true })) {
      if (!name.isFile() || name.name === 'ARCHIVE.md') continue;
      if (!archiveIds.has(name.name)) findings.push({ cls: 'archive-orphan', id: null, message: `archive body has no catalog record: ${name.name}` });
    }
    return findings;
  } catch (err) {
    return [{ cls: 'validation-error', id: null, message: err instanceof Error ? err.message : String(err) }];
  } finally {
    if (tmpRoot) {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function persistCleanupPending(ws: string, input: ArchiveMemoryInput, nowISO: string): void {
  upsertFindings(ws, [{
    kind: 'archive-cleanup-pending',
    entryId: input.id,
    sourceHash: input.expectedBodyHash,
    reason: `archived ${input.id}, but ${MEMORY_DETAILS_DIR}${input.id}.md could not be removed`,
    exitCondition: 'remove the redundant resident detail body after verifying the archive copy',
  }], nowISO);
}

function finishCleanup(
  ws: string,
  workDir: string,
  pathType: string,
  input: ArchiveMemoryInput,
  nowISO: string,
  cleanupBody: string | null,
): ArchiveMemoryResult {
  if (cleanupBody === null) return { ok: true };
  try {
    deleteScaffoldFile(workDir, bodyRel(MEMORY_DETAILS_DIR, input.id), pathType);
    if (!scaffoldFileExists(workDir, bodyRel(MEMORY_DETAILS_DIR, input.id), pathType)) return { ok: true };
  } catch { /* committed transitions are never rolled back for cleanup failure */ }
  try { persistCleanupPending(ws, input, nowISO); } catch { /* caller still needs the truthful committed outcome */ }
  return { ok: true, code: 'cleanup_pending' };
}

function restorePrecommit(
  workDir: string,
  pathType: string,
  priorArchiveSource: string | null,
  archiveBodyPreexisted: boolean,
  id: string,
): void {
  try {
    if (priorArchiveSource === null) deleteScaffoldFile(workDir, ARCHIVE_INDEX_REL, pathType);
    else atomicWriteScaffoldText(workDir, ARCHIVE_INDEX_REL, priorArchiveSource, false, pathType);
  } catch { /* best effort, retry classification understands the intermediate */ }
  if (!archiveBodyPreexisted) {
    try { deleteScaffoldFile(workDir, bodyRel(MEMORY_ARCHIVE_DIR, id), pathType); } catch { /* best effort */ }
  }
}

function cleanupTemps(workDir: string, pathType: string, id: string): void {
  for (const rel of [INDEX_TMP_REL, ARCHIVE_INDEX_TMP_REL, `${bodyRel(MEMORY_ARCHIVE_DIR, id)}.archive-mover.tmp`]) {
    try { deleteScaffoldFile(workDir, rel, pathType); } catch { /* best effort */ }
  }
}

/** Archive one resident memory. Never throws and never consults migration approval. */
export function archiveMemoryEntry(
  ws: string,
  workDir: string,
  pathType: string,
  input: ArchiveMemoryInput,
  nowISO: string,
): ArchiveMemoryResult {
  let release: (() => void) | null = null;
  let logicalCommitted = false;
  let state: Extract<ArchiveState, { kind: 'active' }> | null = null;
  try {
    release = acquireWorkspaceLock(workDir, pathType);
    const classified = classifyArchiveState(workDir, pathType, input);
    if (classified.kind === 'conflict') return { ok: false, code: 'conflict', message: classified.message };
    if (classified.kind === 'committed') {
      return finishCleanup(ws, workDir, pathType, input, nowISO, classified.cleanupBody);
    }
    state = classified;

    // Ordinary caller CAS applies only to the active/pre-commit state and is
    // re-read under the lock immediately before validation/mutation.
    const lockedIndex = readScaffoldText(workDir, INDEX_REL, pathType);
    const lockedBody = readScaffoldText(workDir, bodyRel(MEMORY_DETAILS_DIR, input.id), pathType);
    if (lockedIndex === null || sha256Hex(lockedIndex) !== input.expectedPriorHash) {
      return { ok: false, code: 'cas_mismatch', message: 'live memory index changed (expected_prior_hash mismatch)' };
    }
    if (lockedBody === null || sha256Hex(lockedBody) !== input.expectedBodyHash) {
      return { ok: false, code: 'cas_mismatch', message: 'live memory body changed (expected_body_hash mismatch)' };
    }

    const proposedResident = withoutEntry(lockedIndex, state.entry);
    const proposedArchive = state.archiveSource && parseArchiveIndex(state.archiveSource).entries.some((entry) => entry.id === input.id)
      ? state.archiveSource
      : withArchiveEntry(state.archiveSource, state.entry, input.id);
    const findings = validateFinalBundle(workDir, pathType, input, proposedResident, proposedArchive, lockedBody, nowISO);
    if (findings.length > 0) {
      return { ok: false, code: 'hard_invalid', message: `proposed archive bundle has ${findings.length} hard finding(s)`, findings };
    }

    const targetRel = bodyRel(MEMORY_ARCHIVE_DIR, input.id);
    if (!state.archiveBodyPreexisted) {
      stageTextFile(workDir, `${targetRel}.archive-mover.tmp`, lockedBody, false, pathType);
      commitStagedRename(workDir, `${targetRel}.archive-mover.tmp`, targetRel, pathType);
    }
    if (state.archiveSource !== proposedArchive) {
      stageTextFile(workDir, ARCHIVE_INDEX_TMP_REL, proposedArchive, false, pathType);
      commitStagedRename(workDir, ARCHIVE_INDEX_TMP_REL, ARCHIVE_INDEX_REL, pathType);
    }
    stageTextFile(workDir, INDEX_TMP_REL, proposedResident, false, pathType);
    commitStagedRename(workDir, INDEX_TMP_REL, INDEX_REL, pathType);
    logicalCommitted = true;

    return finishCleanup(ws, workDir, pathType, input, nowISO, lockedBody);
  } catch (err) {
    if (!logicalCommitted && state) {
      restorePrecommit(workDir, pathType, state.archiveSource, state.archiveBodyPreexisted, input.id);
    }
    return { ok: false, code: 'write_error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    cleanupTemps(workDir, pathType, input.id);
    try { release?.(); } catch { /* never throw */ }
  }
}
