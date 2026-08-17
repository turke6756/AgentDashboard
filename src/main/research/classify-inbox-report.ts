import fs from 'node:fs';
import path from 'node:path';

import {
  validateResearchFrontmatter,
  type ResearchFrontmatter,
} from './frontmatter';

export const INBOX_REPORT_READ_LIMIT_BYTES = 64 * 1024;

export type ClassifiedInboxReport =
  | { status: 'ok'; relPath: string; frontmatter: ResearchFrontmatter }
  | {
    status: 'malformed';
    relPath: string;
    reason: string;
    recovered?: Partial<ResearchFrontmatter>;
  };

export function classifyInboxReport(input: {
  relPath: string;
  content: string;
}): ClassifiedInboxReport {
  const result = validateResearchFrontmatter(input.content, { expectTrust: 'untrusted' });
  if (!result.ok) {
    return {
      status: 'malformed',
      relPath: input.relPath,
      reason: result.reason,
      ...(result.recovered ? { recovered: result.recovered } : {}),
    };
  }
  return { status: 'ok', relPath: input.relPath, frontmatter: result.frontmatter };
}

export interface ListInboxReportsOptions {
  maxBytes?: number;
  /** Narrow test seam for an otherwise unreadable file; production uses fs.promises.readFile. */
  readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>;
}

function ioMalformed(relPath: string, reason: string): ClassifiedInboxReport {
  return {
    status: 'malformed',
    relPath,
    reason: `Research inbox report malformed: ${reason}`,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Recursively list markdown reports without following symlinks or junctions.
 * Files remain in place regardless of classification result. */
export async function listInboxReports(
  inboxDir: string,
  options: ListInboxReportsOptions = {},
): Promise<ClassifiedInboxReport[]> {
  const maxBytes = options.maxBytes ?? INBOX_REPORT_READ_LIMIT_BYTES;
  const readFile = options.readFile ?? ((filePath, encoding) => fs.promises.readFile(filePath, encoding));
  let rootReal: string;
  try {
    const rootStat = await fs.promises.lstat(inboxDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
    rootReal = await fs.promises.realpath(inboxDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }

  const reports: ClassifiedInboxReport[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(absolute);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;

      let real: string;
      try {
        real = await fs.promises.realpath(absolute);
      } catch {
        continue;
      }
      if (!isWithin(rootReal, real)) continue;

      if (stat.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!stat.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;

      const relPath = path.relative(inboxDir, absolute).split(path.sep).join('/');
      if (stat.size > maxBytes) {
        reports.push(ioMalformed(relPath, `file exceeds ${maxBytes}-byte classification limit`));
        continue;
      }
      try {
        const content = await readFile(absolute, 'utf8');
        reports.push(classifyInboxReport({ relPath, content }));
      } catch (error) {
        const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
        reports.push(ioMalformed(relPath, `file is unreadable${detail}`));
      }
    }
  }

  await walk(inboxDir);
  return reports.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
