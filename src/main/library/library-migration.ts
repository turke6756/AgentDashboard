import fs from 'node:fs';
import path from 'node:path';

import { classifyInboxReport } from '../research/classify-inbox-report';

export interface LibraryMigrationResult {
  renamed: boolean;
  mergedFiles: number;
  archivedReports: number;
}

function mergeWithoutOverwrite(source: string, destination: string): number {
  let moved = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (!fs.existsSync(to)) {
      fs.renameSync(from, to);
      moved += entry.isDirectory() ? countFiles(to) : 1;
      continue;
    }
    if (entry.isDirectory() && fs.statSync(to).isDirectory()) {
      moved += mergeWithoutOverwrite(from, to);
      try { fs.rmdirSync(from); } catch { /* conflicting files remain in research/ */ }
    }
  }
  return moved;
}

function countFiles(root: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(path.join(root, entry.name)) : 1;
  }
  return count;
}

function archiveMalformedReports(inboxDir: string): number {
  if (!fs.existsSync(inboxDir)) return 0;
  const legacyDir = path.join(inboxDir, '_legacy');
  let archived = 0;

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dir === inboxDir && entry.name === '_legacy') continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
      const relPath = path.relative(inboxDir, absolute).split(path.sep).join('/');
      let malformed = false;
      try {
        malformed = classifyInboxReport({ relPath, content: fs.readFileSync(absolute, 'utf8') }).status === 'malformed';
      } catch {
        malformed = true;
      }
      if (!malformed) continue;
      const destination = path.join(legacyDir, relPath);
      if (fs.existsSync(destination)) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(absolute, destination);
      archived += 1;
    }
  }

  walk(inboxDir);
  return archived;
}

function migrateScaffoldSidecar(stateDir: string): void {
  const sidecar = path.join(stateDir, '.scaffold-versions.json');
  if (!fs.existsSync(sidecar)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
    let changed = false;
    for (const key of Object.keys(parsed)) {
      if (key !== 'research' && !key.startsWith('research/')) continue;
      const next = `library${key.slice('research'.length)}`;
      if (!(next in parsed)) parsed[next] = parsed[key];
      delete parsed[key];
      changed = true;
    }
    if (changed) fs.writeFileSync(sidecar, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  } catch {
    // A malformed sidecar is owned by the scaffold writer's normal recovery path.
  }
}

/** Migrate the workspace-local research folder into the Library contract. */
export function migrateWorkspaceLibrary(stateDir: string): LibraryMigrationResult {
  fs.mkdirSync(stateDir, { recursive: true });
  const researchDir = path.join(stateDir, 'research');
  const libraryDir = path.join(stateDir, 'library');
  let renamed = false;
  let mergedFiles = 0;

  if (fs.existsSync(researchDir) && !fs.existsSync(libraryDir)) {
    fs.renameSync(researchDir, libraryDir);
    renamed = true;
  } else {
    fs.mkdirSync(libraryDir, { recursive: true });
    if (fs.existsSync(researchDir)) {
      mergedFiles = mergeWithoutOverwrite(researchDir, libraryDir);
      try { fs.rmdirSync(researchDir); } catch { /* non-overwritten conflicts remain */ }
    }
  }

  for (const name of ['inbox', 'cleared', 'scratch', 'sources', 'derived']) {
    fs.mkdirSync(path.join(libraryDir, name), { recursive: true });
  }
  migrateScaffoldSidecar(stateDir);
  const archivedReports = archiveMalformedReports(path.join(libraryDir, 'inbox'));
  return { renamed, mergedFiles, archivedReports };
}
