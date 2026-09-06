import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LibraryDocumentStatus, ShelfRow, ShelfStatus } from '../../shared/library';
import { listLibraryDocuments, listLibraryDocumentsByRelPaths, type LibraryDocumentRow, type LibraryStore } from './library-store';
import { listLibraryReportSources, normalizeLibraryReportKey, type LibraryReportFile, type LibraryReportRoot, type LibraryReportSourcesInventory } from './library-report-sources';

const REPORT_PREFIXES = { inbox: '.lares/library/inbox/', cleared: '.lares/library/cleared/' } as const;
const INDEXING_STATUSES = new Set<LibraryDocumentStatus>(['queued', 'extracting', 'chunking', 'embedding']);
const hashCache = new Map<string, { size: number; mtimeMs: number; hash: string }>();
export interface ListLibraryShelfOptions { inventory?: LibraryReportSourcesInventory; readFile?: (filePath: string) => Promise<Buffer>; hashConcurrency?: number; warn?: (message: string) => void }
function canonical(value: string): string { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
function reportRelPath(root: LibraryReportRoot, file: LibraryReportFile): string { return normalizeLibraryReportKey(`${REPORT_PREFIXES[root]}${file.rel_path}`); }
function isReportOwned(relPath: string): boolean { const key = normalizeLibraryReportKey(relPath); return Object.values(REPORT_PREFIXES).some((prefix) => key.startsWith(normalizeLibraryReportKey(prefix))); }
function selectRows(rows: readonly LibraryDocumentRow[], warn: (message: string) => void): Map<string, LibraryDocumentRow> {
  const grouped = new Map<string, LibraryDocumentRow[]>();
  for (const row of rows) { const key = normalizeLibraryReportKey(row.source_rel_path); const group = grouped.get(key) ?? []; group.push(row); grouped.set(key, group); }
  const selected = new Map<string, LibraryDocumentRow>();
  for (const [relPath, group] of grouped) {
    group.sort((a, b) => b.index_generation - a.index_generation || b.id.localeCompare(a.id));
    if (group.length > 1) warn(`Library duplicate source_rel_path "${relPath}": ${group.map((row) => row.id).join(', ')}; using ${group[0].id}`);
    selected.set(relPath, group[0]);
  }
  return selected;
}
async function mapBounded<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0;
  async function worker(): Promise<void> { while (next < items.length) { const index = next; next += 1; results[index] = await work(items[index]); } }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker())); return results;
}
async function fileHash(file: LibraryReportFile, readFile: (filePath: string) => Promise<Buffer>): Promise<string> {
  const key = canonical(file.abs_path); const cached = hashCache.get(key);
  if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.hash;
  const hash = crypto.createHash('sha256').update(await readFile(file.abs_path)).digest('hex'); hashCache.set(key, { size: file.size, mtimeMs: file.mtimeMs, hash }); return hash;
}
export function invalidateLibraryShelfHash(filePath: string): void { hashCache.delete(canonical(filePath)); }
function statusFor(row: LibraryDocumentRow | undefined, diskSize: number, hash?: string): ShelfStatus {
  if (!row) return 'pending'; if (row.size !== diskSize || hash !== row.source_hash) return 'stale';
  if (INDEXING_STATUSES.has(row.status as LibraryDocumentStatus)) return 'indexing'; if (row.status === 'error') return 'error'; if (row.status === 'ready') return 'ready'; return 'error';
}
function pendingRow(relPath: string, file: LibraryReportFile, root: LibraryReportRoot): ShelfRow {
  return { id: `shelf:${relPath}`, type: 'research', title: path.basename(file.rel_path, path.extname(file.rel_path)), created: new Date(file.mtimeMs).toISOString(), topics_json: '[]', trust: root === 'inbox' ? 'untrusted' : 'cleared', source_rel_path: relPath, reader_rel_path: relPath, source_hash: '', size: file.size, page_count: null, provider: null, agent_id: null, summary: null, status: 'queued', error_reason: null, index_generation: 0, chunker_version: '', tokenizer_version: '', shelf_status: 'pending' };
}
export async function listLibraryShelf(workspaceRoot: string, store: LibraryStore, options: ListLibraryShelfOptions = {}): Promise<ShelfRow[]> {
  const inventory = options.inventory ?? await listLibraryReportSources(workspaceRoot);
  const disk = (['inbox', 'cleared'] as const).flatMap((root) => inventory[root].files.map((file) => ({ root, file, relPath: reportRelPath(root, file) })));
  const diskRows = listLibraryDocumentsByRelPaths(store, disk.map((item) => item.relPath), normalizeLibraryReportKey);
  const selectedDisk = selectRows(diskRows, options.warn ?? console.warn);
  const candidates = disk.filter(({ file, relPath }) => selectedDisk.get(relPath)?.size === file.size);
  const hashes = await mapBounded(candidates, options.hashConcurrency ?? 4, ({ file }) => fileHash(file, options.readFile ?? fs.promises.readFile));
  const hashByPath = new Map(candidates.map((item, index) => [item.relPath, hashes[index]]));
  const shelf = disk.map(({ root, file, relPath }) => {
    const row = selectedDisk.get(relPath); if (!row) return pendingRow(relPath, file, root);
    return { ...row, type: 'research' as const, trust: root === 'inbox' ? 'untrusted' as const : 'cleared' as const, source_rel_path: relPath, reader_rel_path: relPath, size: file.size, status: row.status as LibraryDocumentStatus, shelf_status: statusFor(row, file.size, hashByPath.get(relPath)) } satisfies ShelfRow;
  });
  const selectedAll = selectRows(listLibraryDocuments(store, { include_untrusted: true }), options.warn ?? console.warn);
  for (const [relPath, row] of selectedAll) {
    if (isReportOwned(relPath)) continue;
    shelf.push({ ...row, status: row.status as LibraryDocumentStatus, shelf_status: row.status === 'ready' ? 'ready' : INDEXING_STATUSES.has(row.status as LibraryDocumentStatus) ? 'indexing' : 'error' });
  }
  return shelf.sort((a, b) => a.source_rel_path.localeCompare(b.source_rel_path));
}
