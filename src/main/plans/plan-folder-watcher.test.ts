// WP-P2B-folder — structured plan-folder ingest.
//   npm run build:main
//   node dist/main/main/plans/plan-folder-watcher.test.js
//
// Proves the acceptance items: two roots enumerated independently; state-dir home
// ensured on init; nested plan.md/output edits trigger a settled callback (a
// depth:0 root-only watch would fail this); late-validity picked up; over-cap
// folder still updates + surfaces `degraded-watch`; idempotent adopt by
// plan_artifact_id; NO author_* write (schema-checked); child-sub set tracked +
// removals reported; duplicate/malformed per policy; no P2L import.
//
// Registered in scripts/run-main-tests.mjs so the production main-test gate
// executes this suite.
//
// Uses the sql.js-backed better-sqlite3 fake (mirrors plan-gallery.test) so the
// REAL database + plan-folder-watcher modules run against a live schema, plus a
// real temp workspace on disk for the fs-backed folder ingest.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): {
    bind(params: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  };
};

let sqlJsCtor: new () => SqlJsDatabase;

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  static lastPath = '';
  private db: SqlJsDatabase;

  constructor(dbPath = ':memory:') {
    FakeBetterSqlite.lastPath = dbPath;
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) { store = new sqlJsCtor(); FakeBetterSqlite.stores.set(dbPath, store); }
    this.db = store;
  }
  pragma(_sql: string): unknown { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; }
        finally { stmt.free(); }
      },
      all: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally { stmt.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => {
      this.db.exec('BEGIN');
      try { const r = fn(...args); this.db.exec('COMMIT'); return r; }
      catch (err) { this.db.exec('ROLLBACK'); throw err; }
    };
  }
  private static store(): SqlJsDatabase {
    const s = FakeBetterSqlite.stores.get(FakeBetterSqlite.lastPath);
    if (!s) throw new Error('no store for last path');
    return s;
  }
  static rawAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = FakeBetterSqlite.store().prepare(sql);
    try {
      stmt.bind(params);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  }
  static rawRun(sql: string, params: unknown[] = []): void {
    FakeBetterSqlite.store().run(sql, params);
  }
}

// ── Types mirrored off the real modules (structural) ─────────────────────────
type StructuredPlanRow = {
  id: string; workspaceId: string; artifactId: string | null; folderRelPath: string | null;
  path: string; format: string; runState: string | null; mtimeMs: number; sizeBytes: number;
  deletedAt: string | null;
  sourceProposalId?: string | null;
};
type Plan = { id: string; workspaceId: string; deletedAt: string | null };

type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  getPlanByWorkspaceArtifactId(workspaceId: string, artifactId: string): StructuredPlanRow | null;
  getPlans(filters?: { workspaceId?: string; includeDeleted?: boolean }): Plan[];
  insertProposalRecord(rec: any): void;
  getPlanSourceProposalProjectionState(planId: string): { status: string } | null;
};

type FolderChangeKind = 'boot' | 'adopted' | 'changed' | 'dependency';
type PlanFolderDiagnostic = { kind: string; workspaceId: string; relPath: string; otherRelPath?: string; detail: string };
type FolderReconcileResult = {
  settled: Array<{ planId: string; folderRelPath: string; changeKind: FolderChangeKind }>;
  watchable: string[]; overCap: string[]; removed: string[]; diagnostics: PlanFolderDiagnostic[];
};
type Ws = { id: string; path: string; pathType: string };

type WatcherModule = {
  PlanFolderWatcher: new (opts?: {
    onPlanFolderSettled?: (planId: string, folderRelPath: string, changeKind: FolderChangeKind) => void | Promise<void>;
    now?: () => number; childSubCap?: number;
    reconcileProjections?: (input: any) => Promise<any>;
  }) => {
    reconcileWorkspace(ws: Ws, isBoot: boolean): Promise<FolderReconcileResult>;
    plansHome(ws: Ws): string;
    adoptedFoldersForTests(workspaceId: string): string[];
    pendingRetriesForTests(workspaceId: string): string[];
    clearRuntimeState(workspaceId?: string): void;
  };
  validatePlanFolder(folderAbs: string): { valid: boolean; reason?: string; planArtifactId?: string };
  computeFolderSignature(folderAbs: string): { maxManagedMtimeMs: number; overviewToken: string };
  DEFAULT_FOLDER_CHILD_SUB_CAP: number;
  PLAN_FOLDER_OUTPUT_SUBDIRS: readonly string[];
};

let dbm: DbModule;
let wm: WatcherModule;
let wsRoot = '';
let ws: Ws;

/** Full per-test isolation: a fresh on-disk workspace (empty state-dir plans
 *  home) AND a fresh workspace row, so no folder or `plans` row bleeds across
 *  cases. The shared runner state (one DB, one temp APPDATA) is untouched;
 *  `getPlans`/`getPlanByWorkspaceArtifactId` are workspace-scoped, so a new
 *  ws.id starts from zero rows. */
function freshWorkspace(): void {
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pfw-ws-'));
  fs.mkdirSync(path.join(wsRoot, '.lares', 'plans'), { recursive: true });
  ws = {
    id: dbm.createWorkspace({ title: 'ws', path: wsRoot, pathType: 'windows' }).id,
    path: wsRoot,
    pathType: 'windows',
  };
}

// ── Fixture helpers ──────────────────────────────────────────────────────────
function plansHomeAbs(): string { return path.join(wsRoot, '.lares', 'plans'); }
function folderAbsOf(sku: string): string { return path.join(plansHomeAbs(), sku); }
function relOf(sku: string): string { return `.lares/plans/${sku}`; }
function artifactForSku(sku: string): string {
  return `plan_${crypto.createHash('sha256').update(sku).digest('hex').slice(0, 8)}`;
}

/** Write a §R0-shaped plan folder. `artifactId` defaults to `plan_<sku>`; pass
 *  `planJson:'malformed'` for an unterminated blob, or omit `planMd`. */
function writeFolder(sku: string, opts: {
  artifactId?: string; planJson?: string | Record<string, unknown> | 'malformed'; planMd?: string | null; mtimeMs?: number;
} = {}): string {
  const abs = folderAbsOf(sku);
  fs.mkdirSync(abs, { recursive: true });
  let body: string;
  if (opts.planJson === 'malformed') body = '{ this is not : json';
  else if (typeof opts.planJson === 'string') body = opts.planJson;
  else body = JSON.stringify({
    schema_version: 1,
    plan_artifact_id: opts.artifactId ?? artifactForSku(sku),
    plan_sku: sku,
    ...(opts.planJson ?? {}),
  });
  fs.writeFileSync(path.join(abs, 'plan.json'), body);
  if (opts.planMd !== null) fs.writeFileSync(path.join(abs, 'plan.md'), opts.planMd ?? `# ${sku}\n`);
  if (opts.mtimeMs !== undefined) touchAll(abs, opts.mtimeMs);
  return relOf(sku);
}

let sourceSeq = 0;
function writeSourceFolder(opts: { register?: boolean } = {}): {
  sku: string; rel: string; planArtifactId: string; proposalArtifactId: string;
  proposalRelPath: string;
} {
  sourceSeq += 1;
  const hex = sourceSeq.toString(16).padStart(8, '0');
  const sku = `source-${hex}`;
  const planArtifactId = `plan_${hex}`;
  const proposalArtifactId = `prop_${hex}`;
  const proposalRelPath = `.lares/proposals/${sku}.md`;
  fs.mkdirSync(path.join(wsRoot, '.lares', 'proposals'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, proposalRelPath),
    `---\nartifact_id: ${proposalArtifactId}\nauthored_at: 2026-08-15\ntitle: Source\n---\n# Source\n`);
  const rel = writeFolder(sku, {
    artifactId: planArtifactId,
    planJson: {
      source_proposal: { artifact_id: proposalArtifactId, rel_path: proposalRelPath },
      responsibility_events: [], created_at: 1_786_800_000_000, updated_at: 1_786_800_000_000,
    },
  });
  if (opts.register) registerSourceProposal(proposalArtifactId, proposalRelPath);
  return { sku, rel, planArtifactId, proposalArtifactId, proposalRelPath };
}

function registerSourceProposal(artifactId: string, proposalRelPath: string): string {
  const id = `proposal-row-${ws.id}-${artifactId}`;
  dbm.insertProposalRecord({
    id, artifactId, workspaceId: ws.id, path: proposalRelPath, slug: null, title: 'Source',
    state: 'proposal', authorAgentId: null, authorRole: 'unknown', authorDisplay: null,
    authoredAt: null, createdAt: 10, updatedAt: 10, mtimeMs: 1, sizeBytes: 1,
    promotedToPlanId: null, deletedAt: null,
  });
  return id;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** Force mtimes under a folder so signature changes are deterministic. */
function touchAll(dirAbs: string, mtimeMs: number): void {
  const t = mtimeMs / 1000;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { fs.utimesSync(p, t, t); } catch { /* ignore */ } }
    }
  };
  walk(dirAbs);
}

function newWatcher(opts: { childSubCap?: number; settled?: any[] } = {}) {
  const settled = opts.settled;
  return new wm.PlanFolderWatcher({
    childSubCap: opts.childSubCap,
    onPlanFolderSettled: settled ? (id, rel, kind) => { settled.push([id, rel, kind]); } : undefined,
  });
}

function planRowCount(): number {
  return dbm.getPlans({ workspaceId: ws.id, includeDeleted: true }).length;
}

// ── Pure validators ───────────────────────────────────────────────────────────
test('validatePlanFolder classifies valid / absent / malformed / no-artifact-id', () => {
  writeFolder('v-ok');
  assert.equal(wm.validatePlanFolder(folderAbsOf('v-ok')).valid, true);

  fs.mkdirSync(folderAbsOf('v-stray'), { recursive: true }); // no plan.json
  assert.deepEqual(wm.validatePlanFolder(folderAbsOf('v-stray')), { valid: false, reason: 'absent' });

  writeFolder('v-bad', { planJson: 'malformed' });
  assert.equal(wm.validatePlanFolder(folderAbsOf('v-bad')).reason, 'malformed');

  writeFolder('v-noid', { planJson: { plan_artifact_id: '' } as any });
  assert.equal(wm.validatePlanFolder(folderAbsOf('v-noid')).reason, 'no-artifact-id');

  writeFolder('v-noncontract', { artifactId: 'plan_pigt5a83' });
  assert.equal(wm.validatePlanFolder(folderAbsOf('v-noncontract')).reason, 'non-contract-artifact-id');
});

test('computeFolderSignature rises when a nested output file is added/edited', () => {
  const sku = 'sig-1';
  writeFolder(sku, { mtimeMs: 1_000_000 });
  const s0 = wm.computeFolderSignature(folderAbsOf(sku));
  // Add a deliberation output with a later mtime.
  const delib = path.join(folderAbsOf(sku), 'deliberations');
  fs.mkdirSync(delib, { recursive: true });
  const out = path.join(delib, 'd1.md');
  fs.writeFileSync(out, '# out\n');
  fs.utimesSync(out, 5_000_000 / 1000, 5_000_000 / 1000);
  const s1 = wm.computeFolderSignature(folderAbsOf(sku));
  assert.ok(s1.maxManagedMtimeMs > s0.maxManagedMtimeMs,
    `nested edit bumps signature (${s0.maxManagedMtimeMs} → ${s1.maxManagedMtimeMs})`);
});

// ── Adopt behavior ─────────────────────────────────────────────────────────────
test('a valid folder is adopted as a structured/hardening row keyed by plan_artifact_id', async () => {
  const rel = writeFolder('2026-08-03-adopt-aaaa');
  const settled: any[] = [];
  const res = await newWatcher({ settled }).reconcileWorkspace(ws, false);

  const row = dbm.getPlanByWorkspaceArtifactId(ws.id, artifactForSku('2026-08-03-adopt-aaaa'))!;
  assert.ok(row, 'row adopted');
  assert.equal(row.format, 'structured');
  assert.equal(row.runState, 'hardening');
  assert.equal(row.folderRelPath, rel);
  assert.equal(row.path, `${rel}/plan.md`);
  assert.equal(row.deletedAt, null);
  assert.ok(res.settled.some((s) => s.planId === row.id && s.changeKind === 'adopted'));
  assert.deepEqual(settled[0], [row.id, rel, 'adopted']);
  assert.deepEqual(res.watchable, [rel]);
});

test('adopt is idempotent by plan_artifact_id — no duplicate row, no re-settle when unchanged', async () => {
  writeFolder('idem-bbbb', { mtimeMs: 2_000_000 });
  const w = newWatcher();
  await w.reconcileWorkspace(ws, false);
  const first = dbm.getPlanByWorkspaceArtifactId(ws.id, artifactForSku('idem-bbbb'))!;
  const before = planRowCount();

  const settled: any[] = [];
  const w2 = newWatcher({ settled });
  const res2 = await w2.reconcileWorkspace(ws, false);
  const second = dbm.getPlanByWorkspaceArtifactId(ws.id, artifactForSku('idem-bbbb'))!;
  assert.equal(second.id, first.id, 'same plan id (idempotent)');
  assert.equal(planRowCount(), before, 'no duplicate row');
  assert.equal(settled.length, 0, 'no settle on an unchanged re-scan');
  assert.equal(res2.settled.length, 0);
});

test('a nested output edit fires a settled(changed) callback (depth:0 root watch would miss it)', async () => {
  const rel = writeFolder('nested-cccc', { mtimeMs: 3_000_000 });
  const settled: any[] = [];
  const w = newWatcher({ settled });
  await w.reconcileWorkspace(ws, false); // adopt (settled: 'adopted') + seed prior signature
  const row = dbm.getPlanByWorkspaceArtifactId(ws.id, artifactForSku('nested-cccc'))!;
  settled.length = 0;

  // Edit a NESTED output with a later mtime; plan.md itself is untouched.
  const delib = path.join(folderAbsOf('nested-cccc'), 'deliberations');
  fs.mkdirSync(delib, { recursive: true });
  const out = path.join(delib, 'run1.md');
  fs.writeFileSync(out, '# result\n');
  fs.utimesSync(out, 9_000_000 / 1000, 9_000_000 / 1000);

  await w.reconcileWorkspace(ws, false); // signature moved ⇒ 'changed'
  assert.deepEqual(settled, [[row.id, rel, 'changed']]);
});

test('late-validity: a dir without plan.json is skipped, then adopted once plan.json appears', async () => {
  const sku = 'late-dddd';
  fs.mkdirSync(folderAbsOf(sku), { recursive: true });
  fs.writeFileSync(path.join(folderAbsOf(sku), 'plan.md'), '# not yet\n');
  const w = newWatcher();
  const r1 = await w.reconcileWorkspace(ws, false);
  assert.equal(dbm.getPlanByWorkspaceArtifactId(ws.id, artifactForSku(sku)), null, 'not adopted without plan.json');
  assert.ok(!r1.watchable.includes(relOf(sku)));

  // plan.json arrives (rename-event OR periodic reconciliation covers this).
  fs.writeFileSync(
    path.join(folderAbsOf(sku), 'plan.json'),
    JSON.stringify({ schema_version: 1, plan_artifact_id: artifactForSku(sku), plan_sku: sku }),
  );
  const r2 = await w.reconcileWorkspace(ws, false);
  assert.ok(dbm.getPlanByWorkspaceArtifactId(ws.id, artifactForSku(sku)), 'adopted after plan.json appears');
  assert.ok(r2.watchable.includes(relOf(sku)));
});

test('over-cap: a folder past the child-sub cap still adopts + updates, surfacing degraded-watch', async () => {
  writeFolder('cap-a-eeee', { mtimeMs: 4_000_000 });
  writeFolder('cap-b-ffff', { mtimeMs: 4_000_001 });
  const res = await newWatcher({ childSubCap: 1 }).reconcileWorkspace(ws, false);
  assert.equal(res.watchable.length, 1, 'one folder within the cap');
  assert.equal(res.overCap.length, 1, 'one folder over the cap');
  // BOTH are adopted (over-cap never means unregistered).
  assert.ok(dbm.getPlanByWorkspaceArtifactId(ws.id, artifactForSku('cap-a-eeee')));
  assert.ok(dbm.getPlanByWorkspaceArtifactId(ws.id, artifactForSku('cap-b-ffff')));
  const degraded = res.diagnostics.find((d) => d.kind === 'degraded-watch');
  assert.ok(degraded && res.overCap.includes(degraded.relPath), 'degraded-watch surfaced for the over-cap folder');
});

test('duplicate plan_artifact_id across two folders leaves the loser unregistered with a both-paths diagnostic', async () => {
  const relA = writeFolder('dup-a-gggg', { artifactId: 'plan_d00fd00f' });
  const relB = writeFolder('dup-b-hhhh', { artifactId: 'plan_d00fd00f' });
  const before = planRowCount();
  const res = await newWatcher().reconcileWorkspace(ws, false);
  // a sorts before b → a canonical, b duplicate.
  assert.equal(planRowCount(), before + 1, 'exactly one row for the shared artifact_id');
  const diag = res.diagnostics.find((d) => d.kind === 'duplicate-artifact-id' && d.relPath === relB);
  assert.ok(diag, 'duplicate diagnostic surfaced');
  assert.equal(diag!.otherRelPath, relA);
});

test('malformed plan.json is quarantined — not adopted, never rewritten', async () => {
  const sku = 'mal-iiii';
  writeFolder(sku, { planJson: 'malformed' });
  const abs = path.join(folderAbsOf(sku), 'plan.json');
  const before = fs.readFileSync(abs, 'utf8');
  const res = await newWatcher().reconcileWorkspace(ws, false);
  assert.equal(dbm.getPlanByWorkspaceArtifactId(ws.id, artifactForSku(sku)), null, 'not adopted');
  assert.equal(fs.readFileSync(abs, 'utf8'), before, 'plan.json untouched');
  assert.ok(res.diagnostics.some((d) => d.kind === 'malformed-plan-json' && d.relPath === relOf(sku)));
});

test('a removed folder is reported + soft-deleted, and revives (same id) when it reappears', async () => {
  const sku = 'gone-jjjj';
  writeFolder(sku, { mtimeMs: 6_000_000 });
  const w = newWatcher();
  await w.reconcileWorkspace(ws, false);
  const row = dbm.getPlanByWorkspaceArtifactId(ws.id, artifactForSku(sku))!;
  assert.equal(row.deletedAt, null);

  fs.rmSync(folderAbsOf(sku), { recursive: true, force: true });
  const res = await w.reconcileWorkspace(ws, false);
  assert.ok(res.removed.includes(relOf(sku)), 'removal reported');
  assert.ok(dbm.getPlanByWorkspaceArtifactId(ws.id, artifactForSku(sku))!.deletedAt != null, 'row soft-deleted');
  assert.ok(!res.settled.some((s) => s.folderRelPath === relOf(sku)), 'never settle on removal');

  // Reappears → same id revived (deleted_at cleared), no new row.
  writeFolder(sku, { mtimeMs: 7_000_000 });
  await w.reconcileWorkspace(ws, false);
  const revived = dbm.getPlanByWorkspaceArtifactId(ws.id, artifactForSku(sku))!;
  assert.equal(revived.id, row.id, 'same plan id revived');
  assert.equal(revived.deletedAt, null, 'deleted_at cleared on revive');
});

test('two roots are independent — the structured root ignores non-folder + plan.json-less entries', async () => {
  // A stray FILE (e.g. a legacy-style .html) sitting in the state-dir plans home
  // is not a directory and never enters the structured-folder path.
  fs.writeFileSync(path.join(plansHomeAbs(), 'legacy-loose.html'), '<html>x</html>');
  fs.mkdirSync(folderAbsOf('bare-kkkk'), { recursive: true }); // dir, no plan.json
  const res = await newWatcher().reconcileWorkspace(ws, false);
  assert.ok(!res.watchable.some((r) => r.includes('legacy-loose')), 'loose html never adopted');
  assert.ok(!res.watchable.includes(relOf('bare-kkkk')), 'plan.json-less dir not adopted');
});

test('adopt writes NO author_* column (schema-checked): plans has no author columns', () => {
  const cols = FakeBetterSqlite.rawAll('PRAGMA table_info(plans)').map((r) => String(r.name));
  assert.ok(!cols.some((c) => /^author_/.test(c)), `plans carries no author_* column (got: ${cols.join(', ')})`);
});

test('P2L ledger scan is wired through the settle seam', () => {
  const compiled = fs.readFileSync(path.join(__dirname, 'plan-folder-watcher.js'), 'utf8');
  assert.match(compiled, /plan-intent-ledger/, 'compiled settle-seam module references plan-intent-ledger');
});

test('dependency convergence: a proposal registered after folder boot syncs on an unchanged periodic pass', async () => {
  const source = writeSourceFolder();
  const settled: any[] = [];
  const watcher = newWatcher({ settled });
  await watcher.reconcileWorkspace(ws, true);
  const plan = dbm.getPlanByWorkspaceArtifactId(ws.id, source.planArtifactId)!;
  await waitFor(() => dbm.getPlanSourceProposalProjectionState(plan.id)?.status === 'absent', 'boot absence');

  registerSourceProposal(source.proposalArtifactId, source.proposalRelPath);
  const periodic = await watcher.reconcileWorkspace(ws, false);
  assert.ok(periodic.settled.some((entry) => entry.folderRelPath === source.rel
    && entry.changeKind === 'dependency'), 'registry-only change re-enters the production seam');
  assert.equal(dbm.getPlanSourceProposalProjectionState(plan.id)?.status, 'synced');
});

test('dependency convergence: plans.source_proposal_id and byPath.deletedAt alone each rerun projection', async () => {
  const source = writeSourceFolder({ register: true });
  const calls: string[] = [];
  const watcher = new wm.PlanFolderWatcher({
    reconcileProjections: async (input: any) => {
      calls.push(input.changeKind);
      return {
        intentLedger: { diagnostics: [] }, workPackages: { status: 'synced', diagnostics: [] },
        overview: { status: 'synced', diagnostics: [] },
      };
    },
  });
  await watcher.reconcileWorkspace(ws, false);
  const plan = dbm.getPlanByWorkspaceArtifactId(ws.id, source.planArtifactId)!;
  calls.length = 0;

  FakeBetterSqlite.rawRun('UPDATE plans SET source_proposal_id = ? WHERE id = ?', ['foreign-proposal-id', plan.id]);
  await watcher.reconcileWorkspace(ws, false);
  assert.deepEqual(calls, ['dependency'], 'plan linkage alone invalidates the key');

  calls.length = 0;
  const proposalId = `proposal-row-${ws.id}-${source.proposalArtifactId}`;
  FakeBetterSqlite.rawRun('UPDATE proposals SET deleted_at = ? WHERE id = ?', [123, proposalId]);
  await watcher.reconcileWorkspace(ws, false);
  assert.deepEqual(calls, ['dependency'], 'byPath.deletedAt with the same row id invalidates the key');
});

test('boot rejection retries once on an unchanged periodic pass, fulfillment clears it, then no-op stays quiet', async () => {
  const source = writeSourceFolder();
  let calls = 0;
  const kinds: string[] = [];
  const watcher = new wm.PlanFolderWatcher({
    reconcileProjections: async (input: any) => {
      calls += 1;
      kinds.push(input.changeKind);
      if (calls === 1) throw new Error('injected boot rejection');
      return {
        intentLedger: { diagnostics: [] }, workPackages: { status: 'synced', diagnostics: [] },
        overview: { status: 'synced', diagnostics: [] },
      };
    },
  });
  await watcher.reconcileWorkspace(ws, true);
  await waitFor(() => watcher.pendingRetriesForTests(ws.id).includes(source.rel), 'boot retry registration');
  await watcher.reconcileWorkspace(ws, false);
  assert.deepEqual(kinds, ['boot', 'dependency']);
  assert.deepEqual(watcher.pendingRetriesForTests(ws.id), [], 'fulfilled retry clears key');
  await watcher.reconcileWorkspace(ws, false);
  assert.equal(calls, 2, 'following no-op does not project');

  // Removal evicts a failed boot retry, so recreating the same rel-path gets
  // only its ordinary revive projection and no stale retry projection after it.
  const removedRetry = new wm.PlanFolderWatcher({ reconcileProjections: async () => { throw new Error('remove me'); } });
  await removedRetry.reconcileWorkspace(ws, true);
  await waitFor(() => removedRetry.pendingRetriesForTests(ws.id).includes(source.rel), 'retry before removal');
  fs.rmSync(folderAbsOf(source.sku), { recursive: true, force: true });
  await removedRetry.reconcileWorkspace(ws, false);
  const rawRetry = (removedRetry as unknown as {
    pendingRetry: Map<string, Set<string>>;
  }).pendingRetry;
  assert.equal(rawRetry.get(ws.id)?.has(source.rel) ?? false, false, 'removal evicts the raw retry entry');
  const recreatedKinds: string[] = [];
  (removedRetry as any).reconcileProjections = async (input: any) => {
    recreatedKinds.push(input.changeKind);
    return {
      intentLedger: { diagnostics: [] }, workPackages: { status: 'synced', diagnostics: [] },
      overview: { status: 'synced', diagnostics: [] },
    };
  };
  writeFolder(source.sku, {
    artifactId: source.planArtifactId,
    planJson: {
      source_proposal: { artifact_id: source.proposalArtifactId, rel_path: source.proposalRelPath },
      responsibility_events: [], created_at: 1_786_800_000_000, updated_at: 1_786_800_000_000,
    },
  });
  await removedRetry.reconcileWorkspace(ws, false);
  await removedRetry.reconcileWorkspace(ws, false);
  assert.deepEqual(recreatedKinds, ['adopted'], 'same-path recreation has no stale follow-up retry');

  // A rejected boot after teardown is forgotten; restart work is attributed to boot.
  const rejecting = new wm.PlanFolderWatcher({ reconcileProjections: async () => { throw new Error('reject'); } });
  await rejecting.reconcileWorkspace(ws, true);
  await waitFor(() => rejecting.pendingRetriesForTests(ws.id).length === 1, 'pending retry before clear');
  rejecting.clearRuntimeState();
  assert.deepEqual(rejecting.pendingRetriesForTests(ws.id), []);
  const restartKinds: string[] = [];
  (rejecting as any).reconcileProjections = async (input: any) => {
    restartKinds.push(input.changeKind);
    return {
      intentLedger: { diagnostics: [] }, workPackages: { status: 'synced', diagnostics: [] },
      overview: { status: 'synced', diagnostics: [] },
    };
  };
  await rejecting.reconcileWorkspace(ws, true);
  await waitFor(() => restartKinds.length === 1, 'restart boot projection');
  assert.deepEqual(restartKinds, ['boot'], 'post-clear restart is boot, not retained retry');
});

test('a returned terminal conflict completes boot and is not retried periodically', async () => {
  writeSourceFolder();
  const kinds: string[] = [];
  const watcher = new wm.PlanFolderWatcher({
    reconcileProjections: async (input: any) => {
      kinds.push(input.changeKind);
      return {
        sourceProposal: { status: 'conflict' }, intentLedger: { diagnostics: [] },
        workPackages: { status: 'synced', diagnostics: [] }, overview: { status: 'synced', diagnostics: [] },
      };
    },
  });
  await watcher.reconcileWorkspace(ws, true);
  await waitFor(() => kinds.length === 1, 'terminal boot completion');
  assert.deepEqual(watcher.pendingRetriesForTests(ws.id), []);
  await watcher.reconcileWorkspace(ws, false);
  assert.deepEqual(kinds, ['boot']);
});

test('legacy non-contract folder is quarantined while a valid sibling reaches synced', async () => {
  writeFolder('legacy-pigt5a83', { artifactId: 'plan_pigt5a83' });
  const source = writeSourceFolder({ register: true });
  const result = await newWatcher().reconcileWorkspace(ws, false);
  const plan = dbm.getPlanByWorkspaceArtifactId(ws.id, source.planArtifactId)!;
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.kind === 'non-contract-plan-artifact-id'));
  assert.equal(dbm.getPlanSourceProposalProjectionState(plan.id)?.status, 'synced');
});

test('PlansWatcher logs a stable quarantine diagnostic once across repeated no-op scans', async () => {
  const plansWatcherModule = require('../plans-watcher') as typeof import('../plans-watcher');
  const watcher: any = new plansWatcherModule.PlansWatcher();
  watcher.folderStates.set(ws.id, {
    ws, home: plansHomeAbs(), rootUnsubscribe: () => {}, childSubs: new Map(), debounce: null,
  });
  const diagnostic = {
    kind: 'non-contract-plan-artifact-id', workspaceId: ws.id, relPath: '.lares/plans/legacy-pigt5a83',
    detail: 'legacy quarantine',
  };
  let runtimeCleared = false;
  watcher.folderWatcher = {
    reconcileWorkspace: async () => ({ settled: [], watchable: [], overCap: [], removed: [], diagnostics: [diagnostic] }),
    clearRuntimeState: () => { runtimeCleared = true; },
  };
  const messages: unknown[][] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { messages.push(args); };
  try {
    await watcher.reconcileFolderRoot(ws, false);
    await watcher.reconcileFolderRoot(ws, false);
  } finally {
    console.log = originalLog;
    watcher.stop();
  }
  assert.equal(messages.filter((args) => String(args[0]).includes('legacy quarantine')).length, 1);
  assert.equal(runtimeCleared, true, 'PlansWatcher.stop clears folder watcher runtime state');
});

// ── runner ─────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'pfw-appdata-'));
  process.env.APPDATA = tmpAppData;
  // Per-test workspaces (empty plans home + zero-row ws) are minted by
  // freshWorkspace() inside the loop below — no shared workspace here.

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as DbModule;
  dbm.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  wm = require('./plan-folder-watcher') as WatcherModule;

  let passed = 0, failed = 0;
  for (const t of tests) {
    freshWorkspace(); // isolate every case: empty plans home + zero-row workspace
    try { await t.run(); console.log(`  ok  ${t.name}`); passed += 1; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }

  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(wsRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
