import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { PathType, FileContent, DirectoryEntry } from '../shared/types';
import { ensureWslPath } from './path-utils';

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_NOTEBOOK_SIZE = 5 * 1024 * 1024; // 5MB for .ipynb files
const WSL_TIMEOUT = 10000;

const DANGEROUS_CHARS = /[$`;&|]/;

function sanitizePath(p: string): string {
  if (DANGEROUS_CHARS.test(p)) {
    throw new Error('Path contains disallowed characters');
  }
  return p;
}

export function readFileContents(filePath: string, pathType: PathType): FileContent {
  try {
    const isNotebook = filePath.toLowerCase().endsWith('.ipynb');
    const sizeLimit = isNotebook ? MAX_NOTEBOOK_SIZE : MAX_FILE_SIZE;

    if (pathType === 'wsl') {
      const wslPath = sanitizePath(ensureWslPath(filePath, pathType));
      // Check size first
      const statOut = execFileSync('wsl.exe', ['bash', '-lc', `stat -c '%s' '${wslPath}'`], {
        encoding: 'utf-8',
        timeout: WSL_TIMEOUT,
      }).trim();
      const size = parseInt(statOut, 10);
      if (isNaN(size)) {
        return { path: filePath, content: '', encoding: 'utf-8', size: 0, error: 'Could not determine file size' };
      }
      if (size > sizeLimit) {
        return { path: filePath, content: '', encoding: 'utf-8', size, error: `File too large (${(size / 1024 / 1024).toFixed(1)}MB). Open in VS Code instead.` };
      }
      const content = execFileSync('wsl.exe', ['bash', '-lc', `cat '${wslPath}'`], {
        encoding: 'utf-8',
        timeout: WSL_TIMEOUT,
        maxBuffer: sizeLimit + 1024,
      });
      return { path: filePath, content, encoding: 'utf-8', size };
    } else {
      // Windows path
      const stat = fs.statSync(filePath);
      if (stat.size > sizeLimit) {
        return { path: filePath, content: '', encoding: 'utf-8', size: stat.size, error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Open in VS Code instead.` };
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      return { path: filePath, content, encoding: 'utf-8', size: stat.size };
    }
  } catch (err: any) {
    if (err.message?.includes('disallowed characters')) {
      return { path: filePath, content: '', encoding: 'utf-8', size: 0, error: err.message };
    }
    return { path: filePath, content: '', encoding: 'utf-8', size: 0, error: err.message || 'Failed to read file' };
  }
}

export function listDirectoryEntries(dirPath: string, pathType: PathType): DirectoryEntry[] {
  try {
    if (pathType === 'wsl') {
      const wslPath = sanitizePath(ensureWslPath(dirPath, pathType));
      // List with stat info: name, type, size
      const raw = execFileSync('wsl.exe', ['bash', '-lc',
        `find '${wslPath}' -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%f\\n' 2>/dev/null | sort -t$'\\t' -k1,1r -k3,3f`
      ], {
        encoding: 'utf-8',
        timeout: WSL_TIMEOUT,
      });
      const entries: DirectoryEntry[] = [];
      for (const line of raw.trim().split('\n')) {
        if (!line) continue;
        const [type, sizeStr, name] = line.split('\t');
        if (!name) continue;
        const isDirectory = type === 'd';
        const entryPath = wslPath.endsWith('/') ? `${wslPath}${name}` : `${wslPath}/${name}`;
        entries.push({
          name,
          path: entryPath,
          isDirectory,
          size: parseInt(sizeStr, 10) || 0,
        });
      }
      return entries;
    } else {
      // Windows path
      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      const entries: DirectoryEntry[] = items.map((item) => {
        const fullPath = path.join(dirPath, item.name);
        let size = 0;
        try {
          if (!item.isDirectory()) {
            size = fs.statSync(fullPath).size;
          }
        } catch { /* skip */ }
        return {
          name: item.name,
          path: fullPath,
          isDirectory: item.isDirectory(),
          size,
        };
      });
      // Dirs first, then alpha
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
      return entries;
    }
  } catch (err: any) {
    console.error('listDirectoryEntries error:', err.message);
    return [];
  }
}
