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
export interface LibraryReportEligibilityOptions { rootPath?: string; rootRealPath?: string; realPath?: string }

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function nativeRealpath(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => fs.realpath.native(filePath, (error, resolved) => error ? reject(error) : resolve(resolved)));
}
export function normalizeLibraryReportKey(value: string): string {
  const portable = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? portable.toLowerCase() : portable;
}
export function isEligibleLibraryReport(filePath: string, stat: fs.Stats, options: LibraryReportEligibilityOptions = {}): boolean {
  if (!stat.isFile() || stat.isSymbolicLink() || path.extname(filePath).toLowerCase() !== '.md') return false;
  if (options.rootPath) {
    const relative = path.relative(options.rootPath, filePath);
    if (!isWithin(options.rootPath, filePath)) return false;
    if (normalizeLibraryReportKey(relative).split('/')[0] === '_legacy') return false;
  }
  return !options.rootRealPath || !options.realPath || isWithin(options.rootRealPath, options.realPath);
}
async function inventoryRoot(root: LibraryReportRoot, rootPath: string, workspaceReal: string | null, options: LibraryReportSourceOptions): Promise<LibraryReportRootInventory> {
  // Start incomplete and promote only after a real root is fully scanned. Missing
  // or redirected roots must never authorize A6 deletion from an empty inventory.
  const result: LibraryReportRootInventory = { root, root_path: rootPath, files: [], directories: [], health: 'incomplete' };
  const pathType = options.pathType ?? (rootPath.startsWith('/') ? 'wsl' : 'windows');
  const readdir = options.readdir ?? fs.promises.readdir;
  let rootReal: string;
  try {
    const stat = await fs.promises.lstat(rootPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return result;
    rootReal = await nativeRealpath(rootPath);
    if (!workspaceReal || !isWithin(workspaceReal, rootReal)) return result;
  } catch { return result; }
  const confinedWorkspaceReal = workspaceReal;
  result.health = 'complete';
  async function walk(directory: string, isRoot: boolean): Promise<void> {
    result.directories.push({ abs_path: directory, pathType });
    let entries: fs.Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }) as fs.Dirent[]; }
    catch { result.health = 'incomplete'; return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (isRoot && normalizeLibraryReportKey(entry.name) === '_legacy' && entry.isDirectory()) continue;
      const absolute = path.join(directory, entry.name);
      try {
        const stat = await fs.promises.lstat(absolute);
        if (stat.isSymbolicLink()) continue;
        const real = await nativeRealpath(absolute);
        if (!isWithin(confinedWorkspaceReal, real) || !isWithin(rootReal, real)) { result.health = 'incomplete'; continue; }
        if (stat.isDirectory()) await walk(absolute, false);
        else if (isEligibleLibraryReport(absolute, stat, { rootPath, rootRealPath: rootReal, realPath: real })) result.files.push({ rel_path: normalizeLibraryReportKey(path.relative(rootPath, absolute)), abs_path: absolute, size: stat.size, mtimeMs: stat.mtimeMs });
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
  let workspaceReal: string | null = null;
  try { workspaceReal = await nativeRealpath(workspaceRoot); } catch { /* both roots remain conservatively incomplete */ }
  const [inbox, cleared] = await Promise.all([
    inventoryRoot('inbox', path.join(libraryRoot, 'inbox'), workspaceReal, options), inventoryRoot('cleared', path.join(libraryRoot, 'cleared'), workspaceReal, options),
  ]);
  return { inbox, cleared };
}
