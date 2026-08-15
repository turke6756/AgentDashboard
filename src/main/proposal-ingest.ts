import type Database from 'better-sqlite3';

export interface ParsedProposal {
  path: string;
  artifactId: string | null;
  authorAgentId: string | null;
  title: string | null;
  id?: string;
  slug?: string | null;
  authorRole?: 'supervisor' | 'worker' | 'unknown';
  authorDisplay?: string | null;
  authoredAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  mtimeMs?: number | null;
  sizeBytes?: number | null;
  deletedAt?: number | null;
}

export interface ExistingProposalIdentity { path: string; artifactId: string | null; }
export interface ScanStatus {
  seenPaths: Set<string>;
  parseFailedPaths: Set<string>;
}
export interface ReconciledProposal {
  path: string;
  effectiveArtifactId: string | null;
  claimedArtifactId: string | null;
  outcome: 'kept' | 'degraded' | 'reassigned' | 'unchanged';
  conflictWithPath?: string;
}
export interface ReconciliationPlan {
  files: ReconciledProposal[];
  releases: Array<{ path: string; artifactId: string }>;
}
export interface IngestConflict {
  path: string;
  klass: 'duplicate-artifact-id' | 'artifact-id-reassigned' | 'parse-failed';
  oldArtifactId: string | null;
  newArtifactId: string | null;
  attemptedArtifactId: string | null;
  effectiveArtifactId: string | null;
  detail: string | null;
}
export interface IngestReport { plan: ReconciliationPlan; conflicts: IngestConflict[]; }

const normalized = (p: string): string => p.replace(/\\/g, '/');

export function reconcileArtifactIds(
  files: ParsedProposal[], existing: ExistingProposalIdentity[], scan: ScanStatus,
): ReconciliationPlan {
  const parsed = files.map((f) => ({ ...f, path: normalized(f.path) }));
  const old = new Map(existing.map((e) => [normalized(e.path), e.artifactId]));
  const groups = new Map<string, string[]>();
  for (const [path, artifactId] of old) {
    if (artifactId && scan.seenPaths.has(path) && scan.parseFailedPaths.has(path)) {
      const paths = groups.get(artifactId) ?? [];
      paths.push(path); groups.set(artifactId, paths);
    }
  }
  for (const f of parsed) if (f.artifactId !== null) {
    const paths = groups.get(f.artifactId) ?? [];
    paths.push(f.path); groups.set(f.artifactId, paths);
  }
  const winners = new Map<string, string>();
  for (const [id, paths] of groups) {
    const incumbents = paths.filter((p) => {
      const incumbent = old.get(p);
      return incumbent === id;
    });
    winners.set(id, (incumbents.length ? incumbents : paths).sort()[0]);
  }
  const releases: Array<{ path: string; artifactId: string }> = [];
  const parsedPaths = new Set(parsed.map((f) => f.path));
  for (const [path, artifactId] of old) {
    if (!artifactId) continue;
    const failed = scan.seenPaths.has(path) && scan.parseFailedPaths.has(path);
    const changed = parsedPaths.has(path) && parsed.find((f) => f.path === path)?.artifactId !== artifactId;
    const winnerTakes = winners.get(artifactId) !== undefined && winners.get(artifactId) !== path;
    if (!failed && (changed || (!scan.seenPaths.has(path) && winnerTakes))) releases.push({ path, artifactId });
  }
  const out = parsed.map((f): ReconciledProposal => {
    const effective = f.artifactId === null ? null : (winners.get(f.artifactId) === f.path ? f.artifactId : null);
    const oldId = old.get(f.path) ?? null;
    const conflictWithPath = f.artifactId !== null && effective === null ? winners.get(f.artifactId) : undefined;
    const outcome = conflictWithPath ? 'degraded' : oldId !== null && oldId !== f.artifactId ? 'reassigned' : oldId === f.artifactId ? 'unchanged' : 'kept';
    return { path: f.path, effectiveArtifactId: effective, claimedArtifactId: f.artifactId, outcome, ...(conflictWithPath ? { conflictWithPath } : {}) };
  });
  return { files: out, releases };
}

export function upsertProposalByPath(db: Database.Database, workspaceId: string, row: {
  path: string; artifact_id: string | null; author_agent_id: string | null; title: string | null;
  id?: string; slug?: string | null; author_role?: 'supervisor' | 'worker' | 'unknown'; author_display?: string | null;
  authored_at?: number | null; created_at?: number; updated_at?: number; mtime_ms?: number | null; size_bytes?: number | null;
  deleted_at?: number | null;
}): void {
  const now = Date.now();
  // Scan/ingest never owns promoted_to_plan_id. New rows start unlinked;
  // enrichAdoptedPlanRow and applyPlanSourceProposalProjection are its writers.
  db.prepare(`INSERT INTO proposals
    (id, artifact_id, workspace_id, path, slug, title, state, author_agent_id, author_role, author_display, authored_at,
     created_at, updated_at, mtime_ms, size_bytes, promoted_to_plan_id, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, 'proposal', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(workspace_id, path) DO UPDATE SET artifact_id=excluded.artifact_id, slug=excluded.slug, title=excluded.title,
      author_agent_id=excluded.author_agent_id, author_role=excluded.author_role, author_display=excluded.author_display,
      authored_at=excluded.authored_at, mtime_ms=excluded.mtime_ms, size_bytes=excluded.size_bytes,
      deleted_at=excluded.deleted_at,
      updated_at=CASE WHEN proposals.artifact_id IS excluded.artifact_id AND proposals.slug IS excluded.slug
        AND proposals.title IS excluded.title AND proposals.author_agent_id IS excluded.author_agent_id
        AND proposals.author_role IS excluded.author_role AND proposals.author_display IS excluded.author_display
        AND proposals.authored_at IS excluded.authored_at AND proposals.mtime_ms IS excluded.mtime_ms
        AND proposals.size_bytes IS excluded.size_bytes AND proposals.deleted_at IS excluded.deleted_at
        THEN proposals.updated_at ELSE excluded.updated_at END`).run(
    row.id ?? `${workspaceId}:${row.path}`, row.artifact_id, workspaceId, normalized(row.path), row.slug ?? null, row.title,
    row.author_agent_id, row.author_role ?? 'unknown', row.author_display ?? null, row.authored_at ?? null,
    row.created_at ?? now, row.updated_at ?? now, row.mtime_ms ?? null, row.size_bytes ?? null,
    row.deleted_at ?? null,
  );
}

export function recordProposalIngestConflict(db: Database.Database, workspaceId: string, c: IngestConflict): void {
  db.prepare(`INSERT INTO proposal_ingest_conflicts
    (workspace_id,path,klass,old_artifact_id,new_artifact_id,attempted_artifact_id,effective_artifact_id,detail,observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(workspaceId, normalized(c.path), c.klass, c.oldArtifactId, c.newArtifactId,
    c.attemptedArtifactId, c.effectiveArtifactId, c.detail, Date.now());
}

export function ingestProposalBatch(db: Database.Database, workspaceId: string, files: ParsedProposal[], scan: ScanStatus): IngestReport {
  const existing = db.prepare('SELECT path, artifact_id AS artifactId FROM proposals WHERE workspace_id = ?').all(workspaceId) as ExistingProposalIdentity[];
  const plan = reconcileArtifactIds(files, existing, scan);
  const conflicts: IngestConflict[] = [];
  db.exec('BEGIN');
  try {
    for (const release of plan.releases) { db.exec('SAVEPOINT r'); db.prepare('UPDATE proposals SET artifact_id=NULL WHERE workspace_id=? AND path=? AND artifact_id=?').run(workspaceId, release.path, release.artifactId); db.exec('RELEASE r'); }
    for (const f of plan.files) {
      const source = files.find((x) => normalized(x.path) === f.path)!;
      db.exec('SAVEPOINT f');
      try {
        upsertProposalByPath(db, workspaceId, { path: f.path, artifact_id: f.effectiveArtifactId, author_agent_id: source.authorAgentId, title: source.title, id: source.id, slug: source.slug, author_role: source.authorRole, author_display: source.authorDisplay, authored_at: source.authoredAt, created_at: source.createdAt, updated_at: source.updatedAt, mtime_ms: source.mtimeMs, size_bytes: source.sizeBytes, deleted_at: source.deletedAt });
        db.exec('RELEASE f');
        if (f.outcome === 'degraded') { const c = { path: f.path, klass: 'duplicate-artifact-id' as const, oldArtifactId: existing.find((e) => normalized(e.path) === f.path)?.artifactId ?? null, newArtifactId: null, attemptedArtifactId: f.claimedArtifactId, effectiveArtifactId: null, detail: `winner: ${f.conflictWithPath}` }; recordProposalIngestConflict(db, workspaceId, c); conflicts.push(c); }
        if (f.outcome === 'reassigned') { const c = { path: f.path, klass: 'artifact-id-reassigned' as const, oldArtifactId: existing.find((e) => normalized(e.path) === f.path)?.artifactId ?? null, newArtifactId: f.effectiveArtifactId, attemptedArtifactId: null, effectiveArtifactId: f.effectiveArtifactId, detail: null }; recordProposalIngestConflict(db, workspaceId, c); conflicts.push(c); }
      } catch (error) { db.exec('ROLLBACK TO f'); db.exec('RELEASE f'); const c = { path: f.path, klass: 'parse-failed' as const, oldArtifactId: null, newArtifactId: null, attemptedArtifactId: f.claimedArtifactId, effectiveArtifactId: null, detail: String(error) }; recordProposalIngestConflict(db, workspaceId, c); conflicts.push(c); }
    }
    for (const path of scan.parseFailedPaths) { if (!scan.seenPaths.has(path)) continue; db.exec('SAVEPOINT p'); db.exec('ROLLBACK TO p'); const c = { path, klass: 'parse-failed' as const, oldArtifactId: existing.find((e) => normalized(e.path) === normalized(path))?.artifactId ?? null, newArtifactId: null, attemptedArtifactId: null, effectiveArtifactId: null, detail: null }; recordProposalIngestConflict(db, workspaceId, c); conflicts.push(c); db.exec('RELEASE p'); }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { plan, conflicts };
}
