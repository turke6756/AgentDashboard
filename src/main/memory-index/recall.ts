// recall.ts — the on-demand memory-detail fetch behind the `recall_memory` MCP
// tool + POST /api/memory/recall route (WP-D). A capsule body is fetchable whenever
// its `read-if` becomes relevant, whether the capsule is active or archived. Recall
// follows the capsule's DECLARED `detail:` pointer, resolved from the selected
// catalog, never a synthesized `<id>.md`.
//
// It composes the landed pieces and never re-implements them:
//   • memory-index-core.ts (WP-A1) — catalog/disposal parsers, isValidMemoryId,
//     safeUtf8Truncate, utf8ByteLength, and canonical memory paths.
//   • review-store.ts (WP-B)       — bumpRecall (recall telemetry; fires ONLY on
//                                     a successful ok:true fetch).
//
// Security contract (plans/memory-lessons-v2-implementation.md §WP-D):
//   1. Validate `id` against MEMORY_ID_GRAMMAR BEFORE touching disk (a traversal /
//      `..` / separator id fails the grammar → invalid_id, no disk read, no bump).
//   2. Select MEMORY.md before ARCHIVE.md. Duplicate ids in the selected catalog
//      are diagnosed internally and refused outward as not_found.
//   3. Enforce active → details/ and archived → archive/ containment before read.
//   4. Strip the leading memory-disposal:v1 block, then UTF-8-safe-truncate the
//      BODY ONLY to RECALL_DETAIL_MAX_BYTES (the cap excludes the JSON envelope /
//      metadata; `truncated:true` when the stripped body is clipped).
//   5. Structured result codes (invalid_id / not_found / read_error) — NEVER a
//      throw. `archived` capsules are served with `{ ok:true, archived:true }`.
//   6. `bumpRecall` fires ONLY on `ok:true` (recallMemoryDetailWithTelemetry).
//
// Workspace isolation is structural: the caller (the route) resolves
// `workspaceRoot` SOLELY from the authenticated X-Workspace-Id header, so two
// workspaces holding the same memory id read from disjoint trees and increment
// disjoint per-workspace counters.

import * as fs from 'fs';
import * as path from 'path';
import {
  parseIndex,
  parseArchiveIndex,
  isValidMemoryId,
  safeUtf8Truncate,
  utf8ByteLength,
  RECALL_DETAIL_MAX_BYTES,
  MEMORY_DETAILS_DIR,
  MEMORY_ARCHIVE_DIR,
  ARCHIVE_INDEX_REL,
  DISPOSAL_BLOCK_RE,
  type ParsedEntry,
} from '../../shared/memory-index-core';
import { bumpRecall } from './review-store';

export type RecallErrorCode = 'invalid_id' | 'not_found' | 'read_error';

export interface RecallOk {
  ok: true;
  id: string;
  /** the capsule's `status:` value from the parsed index. */
  status: string;
  /** true iff `status === 'archived'` (served, but flagged for the reader). */
  archived: boolean;
  /** the detail-file body after disposal stripping and UTF-8-safe truncation. */
  body: string;
  /** true iff the stripped body exceeded RECALL_DETAIL_MAX_BYTES and was clipped. */
  truncated: boolean;
  /** UTF-8 byte length of the (possibly truncated) `body`. */
  bytes: number;
}

export interface RecallErr {
  ok: false;
  code: RecallErrorCode;
}

export type RecallResult = RecallOk | RecallErr;

/** Realpath `p`, or null if it does not exist / cannot be resolved. Mirrors the
 *  io.ts helper (the recall path deliberately keeps a small local copy rather
 *  than importing across the pure/io seam). */
function tryRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** True iff absolute `target` lies STRICTLY beneath absolute `dir`. Both inputs
 *  must already be realpath-resolved so a symlink escape is caught before this
 *  lexical check runs. */
function isInsideDir(target: string, dir: string): boolean {
  const rel = path.relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The supervisor cwd / details dir / index path for a workspace root, derived
 *  from the ratified MEMORY_DETAILS_DIR constant (one source of the layout). */
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
  const memoryMd = path.join(supervisorDir, 'memory', 'MEMORY.md');
  const archiveMd = path.join(workspaceRoot, ...ARCHIVE_INDEX_REL.split('/').filter(Boolean));
  return { supervisorDir, detailsDir, archiveDir, memoryMd, archiveMd };
}

function readCatalogEntries(indexPath: string, archive: boolean): ParsedEntry[] | null {
  try {
    const text = fs.readFileSync(indexPath, 'utf8');
    return (archive ? parseArchiveIndex(text) : parseIndex(text)).entries;
  } catch {
    return null;
  }
}

function ambiguousRecall(id: string, catalog: 'MEMORY.md' | 'ARCHIVE.md', count: number): RecallErr {
  console.warn(`[memory-index] recall refused ambiguous id ${id}: ${count} records in ${catalog}`);
  return { ok: false, code: 'not_found' };
}

/** Remove the leading disposal-shaped block independently of grammar validity.
 *  DISPOSAL_BLOCK_RE intentionally consumes leading blank lines as part of that
 *  matched metadata prefix. The source file is never written. */
function stripLeadingDisposal(rawBody: string): string {
  const normalized = rawBody.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = DISPOSAL_BLOCK_RE.exec(normalized);
  if (!match) return rawBody;

  // Translate the normalized match length back to a raw-string offset so stripping
  // does not also rewrite a BOM/CRLF body's remaining bytes.
  let rawOffset = rawBody.startsWith('\uFEFF') ? 1 : 0;
  let normalizedOffset = 0;
  while (normalizedOffset < match[0].length) {
    rawOffset += rawBody[rawOffset] === '\r' && rawBody[rawOffset + 1] === '\n' ? 2 : 1;
    normalizedOffset += 1;
  }
  return rawBody.slice(rawOffset);
}

/**
 * Resolve + read a memory detail for `id` under `workspaceRoot`. PURE of the DB
 * (no telemetry) so it is unit-testable without a database handle; the route
 * wraps it with the recall-count increment. Never throws — every failure path
 * returns a structured `{ ok:false, code }`.
 */
export function recallMemoryDetail(workspaceRoot: string, id: unknown): RecallResult {
  // (1) Grammar BEFORE disk. A non-string, or a traversal/`..`/separator id, is
  // rejected here with no filesystem access whatsoever.
  if (typeof id !== 'string' || !isValidMemoryId(id)) {
    return { ok: false, code: 'invalid_id' };
  }

  const { supervisorDir, detailsDir, archiveDir, memoryMd, archiveMd } = memoryDirs(workspaceRoot);

  // MEMORY.md has transaction-defining precedence: any resident record suppresses
  // archive lookup, including an ambiguous resident set that must be refused.
  const memoryEntries = readCatalogEntries(memoryMd, false);
  if (memoryEntries === null) return { ok: false, code: 'not_found' };
  const memoryMatches = memoryEntries.filter((entry) => entry.id === id);
  let entry: ParsedEntry;
  let expectedStatus: 'active' | 'archived';
  let expectedDir: string;
  if (memoryMatches.length > 0) {
    if (memoryMatches.length !== 1) return ambiguousRecall(id, 'MEMORY.md', memoryMatches.length);
    [entry] = memoryMatches;
    expectedStatus = 'active';
    expectedDir = detailsDir;
  } else {
    const archiveEntries = readCatalogEntries(archiveMd, true);
    if (archiveEntries === null) return { ok: false, code: 'not_found' };
    const archiveMatches = archiveEntries.filter((candidate) => candidate.id === id);
    if (archiveMatches.length === 0) return { ok: false, code: 'not_found' };
    if (archiveMatches.length !== 1) return ambiguousRecall(id, 'ARCHIVE.md', archiveMatches.length);
    [entry] = archiveMatches;
    expectedStatus = 'archived';
    expectedDir = archiveDir;
  }

  // Catalog/status/root must agree. Treat mismatches as non-disclosing misses.
  if (entry.status !== expectedStatus) return { ok: false, code: 'not_found' };

  // (2) DECLARED pointer from the parsed capsule — never a synthesized <id>.md.
  const pointer = entry.detail;
  if (!pointer) return { ok: false, code: 'not_found' };

  const candidate = path.resolve(supervisorDir, pointer);
  const real = tryRealpath(candidate);
  if (real === null) return { ok: false, code: 'not_found' }; // missing detail file

  // Realpath-bound beneath the status-selected body root. A symlink escape, a
  // traversal, or the wrong memory subtree all resolve outside and are refused.
  const canonicalExpectedDir = tryRealpath(expectedDir);
  if (canonicalExpectedDir === null || !isInsideDir(real, canonicalExpectedDir)) {
    return { ok: false, code: 'not_found' };
  }

  // (3) Read + UTF-8-safe-truncate the BODY ONLY. A genuine read failure at this
  // point (permissions, mid-read IO error) is a read_error, distinct from a
  // missing file.
  let rawBody: string;
  try {
    rawBody = fs.readFileSync(real, 'utf8');
  } catch {
    return { ok: false, code: 'read_error' };
  }

  const visibleBody = stripLeadingDisposal(rawBody);
  const truncated = utf8ByteLength(visibleBody) > RECALL_DETAIL_MAX_BYTES;
  const body = truncated ? safeUtf8Truncate(visibleBody, RECALL_DETAIL_MAX_BYTES) : visibleBody;

  return {
    ok: true,
    id,
    status: entry.status,
    archived: entry.status === 'archived',
    body,
    truncated,
    bytes: utf8ByteLength(body),
  };
}

/**
 * The route-level entry point: resolve + read the detail, and on a SUCCESSFUL
 * fetch (`ok:true`, including archived) atomically increment the per-workspace
 * recall count. `bumpRecall` fires ONLY on ok:true — an invalid_id / not_found /
 * read_error never touches telemetry. `ws` is the opaque workspaces.id PK
 * (authenticated X-Workspace-Id); `workspaceRoot` is that workspace's on-disk
 * root, so the read and the increment are both workspace-scoped.
 */
export function recallMemoryDetailWithTelemetry(
  ws: string,
  workspaceRoot: string,
  id: unknown,
  nowISO: string,
): RecallResult {
  const result = recallMemoryDetail(workspaceRoot, id);
  if (result.ok) {
    bumpRecall(ws, result.id, nowISO);
  }
  return result;
}
