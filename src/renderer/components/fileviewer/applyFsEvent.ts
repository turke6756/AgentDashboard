import type { DirectoryEntry, FsEvent } from '../../../shared/types';

function entryName(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? fullPath;
}

function insertSorted(entries: DirectoryEntry[], e: DirectoryEntry): DirectoryEntry[] {
  const next = [...entries];
  let idx = next.findIndex((existing) => {
    if (existing.isDirectory !== e.isDirectory) return !existing.isDirectory;
    return existing.name.localeCompare(e.name, undefined, { sensitivity: 'base' }) > 0;
  });
  if (idx < 0) idx = next.length;
  next.splice(idx, 0, e);
  return next;
}

export function applyFsEvent(entries: DirectoryEntry[], event: FsEvent): DirectoryEntry[] {
  if (event.type === 'add') {
    if (entries.some((e) => e.path === event.path)) return entries;
    const newEntry: DirectoryEntry = {
      name: entryName(event.path),
      path: event.path,
      isDirectory: event.isDirectory,
      size: event.size,
    };
    return insertSorted(entries, newEntry);
  }
  if (event.type === 'unlink') {
    const idx = entries.findIndex((e) => e.path === event.path);
    if (idx < 0) return entries;
    const next = [...entries];
    next.splice(idx, 1);
    return next;
  }
  // 'change' — no visible state to update (size not shown). Keep as no-op.
  return entries;
}
