import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Workspace } from '../shared/types';
import { parseProposalFrontmatter } from '../shared/plan-identity';
import { getDb } from './database';
import { ingestProposalBatch, type ParsedProposal, type IngestReport } from './proposal-ingest';
import { workspaceStateDir, workspaceStateDirName } from './workspace-state-dir';

const READ_CAP_BYTES = 2_000_000;

export interface ProposalScanReport {
  workspaceId: string;
  discovered: number;
  parsed: number;
  parseFailed: number;
  ingest: IngestReport;
}

export interface ProposalScanOptions {
  db?: Database.Database;
  now?: () => number;
}

function parseEpoch(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseProposal(raw: string, relPath: string, name: string, stat: fs.Stats, now: number): ParsedProposal {
  // An unterminated leading frontmatter block is a scan failure. A document
  // without frontmatter is still a valid unsigned proposal (artifact/author
  // remain NULL), so the scanner never writes back a generated identity.
  const leading = raw.match(/^---[ \t]*(?:\r?\n)/);
  if (leading && !raw.slice(leading[0].length).match(/(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/)) {
    throw new Error('unterminated proposal frontmatter');
  }
  const frontmatter = parseProposalFrontmatter(raw);
  const authorRole = frontmatter.author_role === 'supervisor' || frontmatter.author_role === 'worker'
    ? frontmatter.author_role : 'unknown';
  const title = frontmatter.title ?? name.replace(/\.md$/i, '');
  return {
    path: relPath,
    artifactId: frontmatter.artifact_id ?? null,
    authorAgentId: frontmatter.author_agent_id ?? null,
    title,
    slug: name.replace(/\.md$/i, ''),
    authorRole,
    authorDisplay: frontmatter.author ?? null,
    authoredAt: parseEpoch(frontmatter.authored_at),
    createdAt: now,
    updatedAt: now,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    promotedToPlanId: frontmatter.promoted_to_plan_id ?? frontmatter.promoted_to ?? null,
  };
}

/** Scan one workspace's flat .lares/proposals/*.md corpus and file the result
 * through WP-1's ingest engine. This function only reads proposal files. */
export function runProposalScan(workspace: Workspace, options: ProposalScanOptions = {}): ProposalScanReport {
  const now = options.now ?? (() => Date.now());
  const root = path.join(workspaceStateDir(workspace.path, workspace.pathType), 'proposals');
  const prefix = `${workspaceStateDirName(workspace.path, workspace.pathType)}/proposals/`;
  const seenPaths = new Set<string>();
  const parseFailedPaths = new Set<string>();
  const files: ParsedProposal[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /\.md$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const relPath = `${prefix}${name}`;
    seenPaths.add(relPath);
    const absolute = path.join(root, name);
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > READ_CAP_BYTES) throw new Error('proposal file is unavailable or oversized');
      const raw = fs.readFileSync(absolute, 'utf8');
      files.push(parseProposal(raw, relPath, name, stat, now()));
    } catch {
      parseFailedPaths.add(relPath);
    }
  }
  const db = options.db ?? getDb();
  const ingest = ingestProposalBatch(db, workspace.id, files, { seenPaths, parseFailedPaths });
  return { workspaceId: workspace.id, discovered: names.length, parsed: files.length, parseFailed: parseFailedPaths.size, ingest };
}
