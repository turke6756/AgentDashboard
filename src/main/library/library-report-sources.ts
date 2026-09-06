import fs from 'node:fs';
import path from 'node:path';
import type { PathType } from '../../shared/types';

export type LibraryReportRoot = 'inbox' | 'cleared';
export type LibraryReportInventoryHealth = 'complete' | 'incomplete';
export interface LibraryReportFile { rel_path: string; abs_path: string; size: number; mtimeMs: number }
export interface LibraryReportDirectory { abs_path: string; pathType: PathType }
export interface LibraryReportRootInventory { root: LibraryReportRoot; root_path: string; files: LibraryReportFile[]; directories: LibraryReportDirectory[]; health: LibraryReportInventoryHealth }
export interface LibraryReportSourcesInventory { inbox: LibraryReportRootInventory; cleared: LibraryReportRootInventory }
export interface LibraryReportSourceOptions { pathType?: PathType; readdir?: typeof fs.promises.readdir }

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
export function isEligibleLibraryReport(filePath: string, stat: fs.Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && path.extname(filePath).toLowerCase() === '.md';
}
async function inventoryRoot(root: LibraryReportRoot, rootPath: string, options: LibraryReportSourceOptions): Promise<LibraryReportRootInventory> {
  const result: LibraryReportRootInventory = { root, root_path: rootPath, files: [], directories: [], health: 'complete' };
  const pathType = options.pathType ?? (rootPath.startsWith('/') ? 'wsl' : 'windows');
  const readdir = options.readdir ?? fs.promises.readdir;
  let rootReal: string;
  try {
    const stat = await fs.promises.lstat(rootPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return result;
    rootReal = await fs.promises.realpath(rootPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.health = 'incomplete';
    return result;
  }
  async function walk(directory: string, isRoot: boolean): Promise<void> {
    result.directories.push({ abs_path: directory, pathType });
    let entries: fs.Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }) as fs.Dirent[]; }
    catch { result.health = 'incomplete'; return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (isRoot && entry.name === '_legacy' && entry.isDirectory()) continue;
      const absolute = path.join(directory, entry.name);
      try {
        const stat = await fs.promises.lstat(absolute);
        if (stat.isSymbolicLink()) continue;
        const real = await fs.promises.realpath(absolute);
        if (!isWithin(rootReal, real)) { result.health = 'incomplete'; continue; }
        if (stat.isDirectory()) await walk(absolute, false);
        else if (isEligibleLibraryReport(absolute, stat)) result.files.push({ rel_path: path.relative(rootPath, absolute).split(path.sep).join('/'), abs_path: absolute, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch { result.health = 'incomplete'; }
    }
  }
  await walk(rootPath, true);
  result.files.sort((a, b) => a.rel_path.localeCompare(b.rel_path));
  result.directories.sort((a, b) => a.abs_path.localeCompare(b.abs_path));
  return result;
}
export async function listLibraryReportSources(workspaceRoot: string, options: LibraryReportSourceOptions = {}): Promise<LibraryReportSourcesInventory> {
  const libraryRoot = path.join(workspaceRoot, '.lares', 'library');
  const [inbox, cleared] = await Promise.all([
    inventoryRoot('inbox', path.join(libraryRoot, 'inbox'), options), inventoryRoot('cleared', path.join(libraryRoot, 'cleared'), options),
  ]);
  return { inbox, cleared };
}
