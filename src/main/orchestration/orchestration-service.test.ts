// OrchestrationService lifecycle tests (plan §7).
//
// Drives the service with INJECTED runners + a fake deliver fn so the lifecycle
// (detach / persist / emit / deliver / abort / boot-reconcile) is exercised
// without the real groupthink relay loop. The SQLite native binding is compiled
// for Electron's ABI (not plain node), so — like api-server-status.test.ts —
// we patch the database module's exports with an in-memory store rather than
// opening a real DB. The service reads those exports at call time, so patching
// the shared module object is picked up.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/orchestration/orchestration-service.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ApiServer } from '../api-server';
import { getApiToken } from '../security/api-auth';
import type { AgentSupervisor } from '../supervisor';
import { assertGroupthinkProvider, OrchestrationService } from './service';
import { DashboardClient, OrchestrationRun, OrchestrationRunContext, OrchestrationRunner } from './types';
import {
  __resetOrchestrationProviderSettingsForTest,
  updateOrchestrationProviderSettings,
} from './orchestration-provider-settings';
import { resetWorkspaceStateDirCacheForTests } from '../workspace-state-dir';

// ── In-memory DB patch ───────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('../database') as Record<string, any>;
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

const runsStore = new Map<string, OrchestrationRun>();
const eventsStore: Array<{ runId: string; ts: string; kind: string; payload: unknown }> = [];
const providerSettingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-orchestration-precedence-'));
const workspaceRoots = {
  defaulted: path.join(providerSettingsRoot, 'defaulted'),
  builtIn: path.join(providerSettingsRoot, 'built-in'),
  dashboard: path.join(providerSettingsRoot, 'dashboard'),
};
const PLAN_UUID = '11111111-1111-4111-8111-111111111111';
const SECOND_PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_PLAN_UUID = '33333333-3333-4333-8333-333333333333';
const DELETED_PLAN_UUID = '44444444-4444-4444-8444-444444444444';
const BUILT_IN_PLAN_UUID = '55555555-5555-4555-8555-555555555555';
const HTML_PLAN_UUID = '66666666-6666-4666-8666-666666666666';
const NULL_ARTIFACT_PLAN_UUID = '77777777-7777-4777-8777-777777777777';
const WSL_PLAN_UUID = '88888888-8888-4888-8888-888888888888';
const PLAN_ARTIFACT_ID = 'plan_a1b2c3d4';
const SECOND_PLAN_ARTIFACT_ID = 'plan_b1c2d3e4';
const HTML_PLAN_ARTIFACT_ID = 'plan_e1f2a3b4';
const WSL_PLAN_ARTIFACT_ID = 'plan_f1a2b3c4';

db.getWorkspace = (id: string) => {
  if (id === 'ws-1') return { id: 'ws-1', path: workspaceRoots.defaulted, pathType: 'windows' };
  if (id === 'ws-built-in') return { id: 'ws-built-in', path: workspaceRoots.builtIn, pathType: 'windows' };
  if (id === 'ws-dashboard') return { id: 'ws-dashboard', path: workspaceRoots.dashboard, pathType: 'windows' };
  if (id === 'ws-wsl') return { id: 'ws-wsl', path: workspaceRoots.defaulted, pathType: 'wsl' };
  return null;
};
// Fix 3 (planning-surface demo): start_run now resolves getPlan(planId).path for
// rail runs. These lifecycle tests don't assert path resolution, so a plans store
// keyed by id suffices; unknown ids fall back to null → the legacy planPath default.
const planRows = new Map([
  [PLAN_UUID, { id: PLAN_UUID, workspaceId: 'ws-1', path: '.lares/plans/primary/plan.md', deletedAt: null, artifactId: PLAN_ARTIFACT_ID }],
  [SECOND_PLAN_UUID, { id: SECOND_PLAN_UUID, workspaceId: 'ws-1', path: '.lares/plans/second/plan.md', deletedAt: null, artifactId: SECOND_PLAN_ARTIFACT_ID }],
  [FOREIGN_PLAN_UUID, { id: FOREIGN_PLAN_UUID, workspaceId: 'ws-2', path: '.lares/plans/foreign/plan.md', deletedAt: null, artifactId: 'plan_c1d2e3f4' }],
  [DELETED_PLAN_UUID, { id: DELETED_PLAN_UUID, workspaceId: 'ws-1', path: '.lares/plans/deleted/plan.md', deletedAt: '2026-08-17T00:00:00.000Z', artifactId: 'plan_d1e2f3a4' }],
  [BUILT_IN_PLAN_UUID, { id: BUILT_IN_PLAN_UUID, workspaceId: 'ws-built-in', path: '.lares/plans/built-in/plan.md', deletedAt: null, artifactId: PLAN_ARTIFACT_ID }],
  [HTML_PLAN_UUID, { id: HTML_PLAN_UUID, workspaceId: 'ws-1', path: 'plans/legacy-plan.html', deletedAt: null, artifactId: HTML_PLAN_ARTIFACT_ID }],
  [NULL_ARTIFACT_PLAN_UUID, { id: NULL_ARTIFACT_PLAN_UUID, workspaceId: 'ws-1', path: '.lares/plans/null-artifact/plan.md', deletedAt: null, artifactId: null }],
  [WSL_PLAN_UUID, { id: WSL_PLAN_UUID, workspaceId: 'ws-wsl', path: '.lares/plans/wsl/plan.md', deletedAt: null, artifactId: WSL_PLAN_ARTIFACT_ID }],
]);
db.getPlan = (id: string) => planRows.has(id) ? clone(planRows.get(id)!) : null;
db.getPlanByWorkspaceArtifactId = (workspaceId: string, artifactId: string) => {
  const row = [...planRows.values()].find((candidate) =>
    candidate.workspaceId === workspaceId && candidate.artifactId === artifactId);
  return row ? clone(row) : null;
};
db.getPlanIntentRow = (_workspaceId: string, planId: string, intentId: string) => {
  if (intentId === 'int_1234abcd') return { planId, intentId, status: 'active' };
  if (intentId === 'int_deadbeef') return { planId, intentId, status: 'withdrawn' };
  return null;
};
function upsertRunLikeSql(r: OrchestrationRun): void {
  const prior = runsStore.get(r.runId);
  const next = clone(r);
  if (prior?.planArtifactId != null) next.planArtifactId = prior.planArtifactId;
  if (prior?.planningIntentId != null) next.planningIntentId = prior.planningIntentId;
  if (prior?.planOutputKind != null) next.planOutputKind = prior.planOutputKind;
  runsStore.set(r.runId, next);
}
db.insertOrchestration = upsertRunLikeSql;
db.updateOrchestration = upsertRunLikeSql;
db.getOrchestrationRun = (id: string) => (runsStore.has(id) ? clone(runsStore.get(id)!) : null);
db.listOrchestrationRuns = () => Array.from(runsStore.values()).map(clone);
db.insertOrchestrationEvent = (e: any) => { eventsStore.push(clone(e)); };
db.insertOrchestrationMember = () => {};
db.markActiveRunsAborted = (reason: string) => {
  const affected: OrchestrationRun[] = [];
  for (const r of runsStore.values()) {
    if (r.status === 'starting' || r.status === 'running') {
      affected.push(clone(r));
      r.status = 'aborted';
      r.error = reason;
    }
  }
  return affected;
};
db.getAgent = (id: string) => id === 'sup-1'
  ? { id, workspaceId: 'ws-1', isSupervisor: true, title: 'Supervisor', provider: 'claude', status: 'idle' }
  : null;
db.getSupervisorAgent = () => null;
let lastFocusUpsert: { supervisorId: string; planId: string; notes: string | null } | null = null;
db.upsertSupervisorFocus = (input: typeof lastFocusUpsert) => {
  lastFocusUpsert = input;
  return input;
};
function focusUpserted(): { supervisorId: string; planId: string; notes: string | null } | null {
  return lastFocusUpsert;
}

const getRun = (runId: string): OrchestrationRun | null => db.getOrchestrationRun(runId);
const eventsFor = (runId: string) => eventsStore.filter((e) => e.runId === runId);

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── Helpers ──────────────────────────────────────────────────────────

function makeClient(overrides: Partial<DashboardClient> = {}): DashboardClient {
  return {
    launchAgent: async () => ({ id: 'agent-x' } as any),
    getAgent: () => null,
    getMessages: async () => [],
    sendInput: async () => {},
    sendInputConfirmed: async () => ({ delivered: true, confirmed: true, mode: 'hook' as const }),
    resubmitEnter: () => {},
    recoverChatBinding: () => {},
    isInputInFlight: () => false,
    stopAgent: async () => {},
    ...overrides,
  };
}

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: any) => void; }
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

function makeDeliver(ok = true) {
  const calls: Array<{ supervisorId: string; text: string }> = [];
  const fn = async (supervisorId: string, text: string) => { calls.push({ supervisorId, text }); return { ok }; };
  return { fn, calls };
}

function baseReq(extra: Record<string, unknown> = {}) {
  const req: Record<string, unknown> = {
    name: 'groupthink' as const,
    workspaceId: 'ws-1',
    supervisorId: 'sup-1',
    topic: 'Plan a thing',
    mode: 'serial' as const,
    planId: PLAN_ARTIFACT_ID,
    planningIntentId: 'int_1234abcd',
    ...extra,
  };
  if (extra.resumeRunId !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(extra, 'planId')) delete req.planId;
    if (!Object.prototype.hasOwnProperty.call(extra, 'planningIntentId')) delete req.planningIntentId;
  }
  return req as any;
}

function planlessReq(extra: Record<string, unknown> = {}) {
  return baseReq({ planId: undefined, planningIntentId: undefined, ...extra });
}

interface HttpResult { status: number; body: string; }
function request(port: number, body: Record<string, unknown>, workspaceId = 'ws-1'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/orchestrations', method: 'POST', agent: false,
      headers: {
        Authorization: `Bearer ${getApiToken()}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload).toString(),
        'X-Workspace-Id': workspaceId,
        'X-Supervisor-Id': 'sup-1',
      },
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function getRequest(port: number, requestPath: string, workspaceId = 'ws-1'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: requestPath, method: 'GET', agent: false,
      headers: {
        Authorization: `Bearer ${getApiToken()}`,
        'X-Workspace-Id': workspaceId,
        'X-Supervisor-Id': 'sup-1',
      },
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Tests ────────────────────────────────────────────────────────────

test('assertGroupthinkProvider accepts launchable providers and rejects discontinued or unsupported values', () => {
  for (const role of ['lead_provider', 'reviewer_provider'] as const) {
    for (const provider of ['claude', 'codex', 'grok', 'agy']) {
      assert.doesNotThrow(() => assertGroupthinkProvider(role, provider));
    }
    assert.doesNotThrow(() => assertGroupthinkProvider(role, undefined));

    for (const provider of ['gemini', 'unknown', '']) {
      assert.throws(
        () => assertGroupthinkProvider(role, provider),
        (err: unknown) => {
          const typed = err as { statusCode?: number; message?: string };
          assert.equal(typed.statusCode, 422);
          if (provider === 'gemini') {
            assert.match(typed.message ?? '', /Gemini provider discontinued/);
          } else {
            assert.match(typed.message ?? '', new RegExp(`Unsupported ${role}`));
            assert.match(typed.message ?? '', /claude, codex, grok, agy/);
          }
          return true;
        },
      );
    }
  }
});

test('discontinued Gemini providers are rejected before an orchestration run is persisted', () => {
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn);
  for (const field of ['leadProvider', 'reviewerProvider'] as const) {
    const before = runsStore.size;
    assert.throws(
      () => svc.start_run(baseReq({ [field]: 'gemini' })),
      (err: unknown) => {
        const typed = err as { statusCode?: number; message?: string };
        assert.equal(typed.statusCode, 422);
        assert.match(typed.message ?? '', /Gemini provider discontinued/);
        assert.match(typed.message ?? '', /Antigravity \(agy\)/);
        return true;
      },
    );
    assert.equal(runsStore.size, before);
  }
});

test('fresh runs accept every provider in either slot, including same-provider pairs', () => {
  const runner: OrchestrationRunner = async () => {};
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });

  for (const provider of ['claude', 'codex', 'grok', 'agy']) {
    const leadRun = svc.start_run(baseReq({ leadProvider: provider }));
    assert.equal(getRun(leadRun.runId)?.leadProvider, provider);

    const reviewerRun = svc.start_run(baseReq({ reviewerProvider: provider }));
    assert.equal(getRun(reviewerRun.runId)?.reviewerProvider, provider);

    const sameProviderRun = svc.start_run(baseReq({ leadProvider: provider, reviewerProvider: provider }));
    assert.equal(getRun(sameProviderRun.runId)?.leadProvider, provider);
    assert.equal(getRun(sameProviderRun.runId)?.reviewerProvider, provider);
  }
});

test('fresh-run provider precedence is explicit over workspace default over built-in default', () => {
  __resetOrchestrationProviderSettingsForTest();
  updateOrchestrationProviderSettings({
    groupthink: { defaultLeadProvider: 'grok', defaultReviewerProvider: 'agy' },
  }, workspaceRoots.defaulted);
  const runner: OrchestrationRunner = async () => {};
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });

  const explicit = svc.start_run(baseReq({ leadProvider: 'codex', reviewerProvider: 'claude' }));
  assert.equal(getRun(explicit.runId)?.leadProvider, 'codex');
  assert.equal(getRun(explicit.runId)?.reviewerProvider, 'claude');

  const workspaceDefault = svc.start_run(baseReq());
  assert.equal(getRun(workspaceDefault.runId)?.leadProvider, 'grok');
  assert.equal(getRun(workspaceDefault.runId)?.reviewerProvider, 'agy');

  const builtIn = svc.start_run(baseReq({ workspaceId: 'ws-built-in' }));
  assert.equal(getRun(builtIn.runId)?.leadProvider, 'claude');
  assert.equal(getRun(builtIn.runId)?.reviewerProvider, 'codex');

  updateOrchestrationProviderSettings({
    groupthink: { defaultLeadProvider: 'claude', defaultReviewerProvider: 'codex' },
  }, workspaceRoots.defaulted);
});

test('fresh runs reject unknown and empty providers before persistence', () => {
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn);
  for (const field of ['leadProvider', 'reviewerProvider'] as const) {
    for (const provider of ['unknown', '']) {
      const before = runsStore.size;
      assert.throws(
        () => svc.start_run(baseReq({ [field]: provider })),
        (err: unknown) => (err as { statusCode?: number }).statusCode === 422,
      );
      assert.equal(runsStore.size, before);
    }
  }
});

function priorRun(runId: string, leadProvider = 'claude', reviewerProvider = 'codex'): OrchestrationRun {
  const now = new Date().toISOString();
  return {
    runId,
    name: 'groupthink',
    mode: 'serial',
    status: 'aborted',
    workspaceId: 'ws-1',
    supervisorId: 'sup-1',
    topic: 'Resume provider test',
    planPath: path.join(os.tmpdir(), `${runId}.md`),
    leadProvider,
    reviewerProvider,
    turnTimeoutMs: 600000,
    lastRelayedTs: {},
    startedAt: now,
    updatedAt: now,
  };
}

test('plan-less fresh launch freezes the none binding and a contained library target', async () => {
  const gate = deferred();
  const runner: OrchestrationRunner = async () => { await gate.promise; };
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });
  const { runId, planId } = svc.start_run(planlessReq());
  const run = getRun(runId)!;

  assert.equal(planId, null);
  assert.equal(run.planId, undefined);
  assert.equal(run.planArtifactId, null);
  assert.equal(run.planningIntentId, null);
  assert.equal(run.planItemId, null);
  assert.equal(run.sectionAnchor, undefined);
  assert.equal(run.planBindingMode, 'none');
  assert.equal(run.planOutputKind, 'library-deliberation');
  assert.equal(path.dirname(path.dirname(run.planPath)), path.join(workspaceRoots.defaulted, '.lares', 'library'));
  assert.match(path.basename(run.planPath), /^\d{4}-\d{2}-\d{2}-groupthink-[0-9a-f]{8}\.md$/);
  assert.ok(fs.statSync(path.dirname(run.planPath)).isDirectory(), 'deliberations parent exists before dispatch');
  assert.equal(run.planBaselineHash, null, 'the absent frozen target has a null baseline');

  gate.resolve();
  await waitFor(() => getRun(runId)?.status === 'complete');
});

test('fresh and resume launches enforce plan/intent pairing and reject orphan anchors before branching', () => {
  const runner: OrchestrationRunner = async () => {};
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });
  db.insertOrchestration(priorRun('pair-resume'));

  const rejected = [
    baseReq({ planningIntentId: undefined }),
    baseReq({ planId: undefined }),
    baseReq({ planId: '', planningIntentId: 'int_1234abcd' }),
    baseReq({ planId: 7, planningIntentId: 'int_1234abcd' }),
    baseReq({ planId: PLAN_ARTIFACT_ID, planningIntentId: 7 }),
    planlessReq({ sectionAnchor: 'sec_orphan' }),
    baseReq({ resumeRunId: 'pair-resume', planId: PLAN_ARTIFACT_ID, planningIntentId: undefined }),
    baseReq({ resumeRunId: 'pair-resume', sectionAnchor: 'sec_orphan' }),
  ];
  for (const req of rejected) {
    assert.throws(
      () => svc.start_run(req),
      (err: unknown) => (err as { statusCode?: number }).statusCode === 400,
      'REACHABILITY:orchestration-service-planless-gate',
    );
  }

  assert.doesNotThrow(() => svc.start_run(planlessReq()));
  assert.doesNotThrow(() => svc.start_run(baseReq({ sectionAnchor: 'sec_bound' })));
  assert.doesNotThrow(() => svc.start_run(baseReq({ resumeRunId: 'pair-resume' })));

  db.insertOrchestration({
    ...priorRun('pair-resume-mismatch'),
    planId: PLAN_UUID,
    planningIntentId: 'int_1234abcd',
  });
  assert.throws(
    () => svc.start_run(baseReq({
      resumeRunId: 'pair-resume-mismatch',
      planId: SECOND_PLAN_ARTIFACT_ID,
      planningIntentId: 'int_1234abcd',
    })),
    (err: unknown) => (err as { statusCode?: number; code?: string }).statusCode === 409
      && (err as { code?: string }).code === 'plan_ref_resume_mismatch',
  );
});

test('plan-less target follows both live and legacy workspace-state roots', async () => {
  const runner: OrchestrationRunner = async () => {};
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });
  const live = svc.start_run(planlessReq());
  assert.equal(
    path.dirname(path.dirname(getRun(live.runId)!.planPath)),
    path.join(workspaceRoots.defaulted, '.lares', 'library'),
  );

  fs.mkdirSync(path.join(workspaceRoots.dashboard, '.dashboard'), { recursive: true });
  resetWorkspaceStateDirCacheForTests();
  const renameSync = fs.renameSync;
  (fs as any).renameSync = (from: fs.PathLike, to: fs.PathLike) => {
    if (path.resolve(String(from)) === path.resolve(workspaceRoots.dashboard, '.dashboard')) {
      const err = Object.assign(new Error('simulated locked legacy state dir'), { code: 'EPERM' });
      throw err;
    }
    return renameSync(from, to);
  };
  try {
    const legacy = svc.start_run(planlessReq({ workspaceId: 'ws-dashboard' }));
    assert.equal(
      path.dirname(path.dirname(getRun(legacy.runId)!.planPath)),
      path.join(workspaceRoots.dashboard, '.dashboard', 'library'),
    );
  } finally {
    (fs as any).renameSync = renameSync;
  }
});

test('resume rejects provider mutation with 409, including legacy-command-derived providers', () => {
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn);
  db.insertOrchestration(priorRun('resume-mismatch'));

  assert.throws(
    () => svc.start_run(baseReq({ resumeRunId: 'resume-mismatch', leadProvider: 'grok' })),
    (err: unknown) => (err as { statusCode?: number }).statusCode === 409,
  );
  assert.throws(
    () => svc.start_run(baseReq({
      resumeRunId: 'resume-mismatch',
      legacyCommand: 'node scripts/groupthink-v2.js --reviewerProvider=agy',
    })),
    (err: unknown) => (err as { statusCode?: number }).statusCode === 409,
  );
});

test('resume accepts matching providers', () => {
  const runner: OrchestrationRunner = async () => {};
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });
  db.insertOrchestration(priorRun('resume-match', 'grok', 'agy'));

  const resumed = svc.start_run(baseReq({
    resumeRunId: 'resume-match',
    leadProvider: 'grok',
    reviewerProvider: 'agy',
  }));
  assert.equal(resumed.runId, 'resume-match');
});

test('historical Gemini runs remain readable but cannot be resumed', () => {
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn);
  db.insertOrchestration(priorRun('resume-gemini', 'gemini', 'codex'));

  assert.throws(
    () => svc.start_run(baseReq({ resumeRunId: 'resume-gemini' })),
    (err: unknown) => {
      const typed = err as { statusCode?: number; message?: string };
      assert.equal(typed.statusCode, 422);
      assert.match(typed.message ?? '', /cannot be resumed/);
      return true;
    },
  );
});

test('orchestration-start-run-resolves-plan-ref', () => {
  const runner: OrchestrationRunner = async () => {};
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });
  const result = svc.start_run(baseReq({ planId: PLAN_ARTIFACT_ID }));
  const persisted = getRun(result.runId)!;
  assert.equal(
    persisted.planId,
    PLAN_UUID,
    'REACHABILITY:orchestration-start-run-plan-ref',
  );
  assert.equal(persisted.planArtifactId, PLAN_ARTIFACT_ID, 'portable plan identity frozen for prompt frontmatter');
  assert.equal(persisted.planOutputKind, 'folder-deliberation', 'folder output shape frozen with the run');
  assert.equal(result.planId, PLAN_UUID, 'start_run returns the canonical UUID');
});

test('orchestration upsert freezes identity fields, fills a null artifact id, and writes back baseline', () => {
  const frozen = priorRun('sql-coalesce-frozen');
  frozen.planArtifactId = 'plan_aaaaaaaa';
  frozen.planOutputKind = 'folder-deliberation';
  frozen.planBaselineHash = 'baseline-old';
  db.insertOrchestration(frozen);
  db.updateOrchestration({
    ...frozen,
    planArtifactId: 'plan_bbbbbbbb',
    planOutputKind: 'registered-surface',
    planBaselineHash: 'baseline-new',
  });
  assert.equal(getRun(frozen.runId)!.planArtifactId, 'plan_aaaaaaaa', 'COALESCE freezes a set artifact id');
  assert.equal(getRun(frozen.runId)!.planOutputKind, 'folder-deliberation', 'COALESCE freezes output kind');
  assert.equal(getRun(frozen.runId)!.planBaselineHash, 'baseline-new', 'baseline is writable on update');

  const fill = priorRun('sql-coalesce-fill');
  fill.planArtifactId = null;
  db.insertOrchestration(fill);
  db.updateOrchestration({ ...fill, planArtifactId: 'plan_cccccccc', planBaselineHash: 'filled-baseline' });
  assert.equal(getRun(fill.runId)!.planArtifactId, 'plan_cccccccc', 'COALESCE fills a null artifact id');
  assert.equal(getRun(fill.runId)!.planBaselineHash, 'filled-baseline');
});

test('folder plan launch freezes a unique in-folder deliberation target', () => {
  const runner: OrchestrationRunner = async () => {};
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });
  const result = svc.start_run(baseReq({ planPath: 'caller-controlled.md' }));
  const run = getRun(result.runId)!;
  const planFolder = path.join(workspaceRoots.defaulted, '.lares', 'plans', 'primary');

  assert.equal(
    path.dirname(path.dirname(run.planPath)),
    planFolder,
    'REACHABILITY:wp1-deliberation-target',
  );
  assert.equal(path.basename(path.dirname(run.planPath)), 'deliberations');
  assert.match(path.basename(run.planPath), /^\d{4}-\d{2}-\d{2}-1234abcd-[0-9a-f]{8}\.md$/);
  assert.match(run.planPath, new RegExp(`${run.runId}\\.md$`));
  assert.notEqual(run.planPath, path.join(planFolder, 'plan.md'));
});

test('folder plan output kind survives sectionAnchor and nullable artifact identity', () => {
  const runner: OrchestrationRunner = async () => {};
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });
  const result = svc.start_run(baseReq({ planId: NULL_ARTIFACT_PLAN_UUID, sectionAnchor: 'sec_ignored' }));
  const run = getRun(result.runId)!;
  assert.equal(run.planOutputKind, 'folder-deliberation');
  assert.equal(run.planArtifactId, null);
  assert.match(run.planPath, /[\\/]deliberations[\\/].+\.md$/);
});

test('WSL folder-plan classification uses the workspace path type', () => {
  const runner: OrchestrationRunner = async () => {};
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });
  const result = svc.start_run(baseReq({ workspaceId: 'ws-wsl', planId: WSL_PLAN_UUID }));
  const run = getRun(result.runId)!;
  assert.equal(run.planOutputKind, 'folder-deliberation');
  assert.match(run.planPath, /[\\/]deliberations[\\/].+\.md$/);
});

test('concurrent folder plan launches freeze distinct deliberation targets', async () => {
  const gate = deferred();
  const runner: OrchestrationRunner = async () => { await gate.promise; };
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });
  const first = svc.start_run(baseReq());
  const second = svc.start_run(baseReq());
  const firstPath = getRun(first.runId)!.planPath;
  const secondPath = getRun(second.runId)!.planPath;

  assert.notEqual(firstPath, secondPath);
  assert.ok(firstPath.endsWith(`${first.runId}.md`));
  assert.ok(secondPath.endsWith(`${second.runId}.md`));
  gate.resolve();
  await waitFor(() => getRun(first.runId)?.status === 'complete');
  await waitFor(() => getRun(second.runId)?.status === 'complete');
});

test('anchored HTML-surface plan keeps the registered plan path', () => {
  const runner: OrchestrationRunner = async () => {};
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });
  const result = svc.start_run(baseReq({ planId: HTML_PLAN_ARTIFACT_ID, sectionAnchor: 'sec_html' }));

  assert.equal(getRun(result.runId)!.planPath, path.join(workspaceRoots.defaulted, 'plans', 'legacy-plan.html'));
  assert.equal(getRun(result.runId)!.planOutputKind, 'registered-surface');
});

test('complete and stalled events report the derived deliberation target', async () => {
  const completeDeliver = makeDeliver();
  const completeRunner: OrchestrationRunner = async () => {};
  const completeSvc = new OrchestrationService(makeClient(), completeDeliver.fn, {
    serial: completeRunner, parallel: completeRunner,
  });
  const complete = completeSvc.start_run(baseReq());
  await waitFor(() => getRun(complete.runId)?.status === 'complete');
  const completePath = getRun(complete.runId)!.planPath;
  const completeEvent = eventsFor(complete.runId).find((event) => event.kind === 'complete');
  assert.deepEqual(completeEvent?.payload, {
    planPath: completePath, planId: PLAN_UUID, artifactKind: 'plan',
  });
  assert.ok(completeDeliver.calls[0].text.includes(completePath));

  const stalledDeliver = makeDeliver();
  const stalledRunner: OrchestrationRunner = async () => { throw new Error('STALL: test'); };
  const stalledSvc = new OrchestrationService(makeClient(), stalledDeliver.fn, {
    serial: stalledRunner, parallel: stalledRunner,
  });
  const stalled = stalledSvc.start_run(baseReq());
  await waitFor(() => getRun(stalled.runId)?.status === 'stalled');
  const stalledPath = getRun(stalled.runId)!.planPath;
  const stalledEvent = eventsFor(stalled.runId).find((event) => event.kind === 'stalled');
  assert.equal((stalledEvent?.payload as { planPath?: string }).planPath, stalledPath);
  const stalledDelivery = JSON.parse(stalledDeliver.calls[0].text.split('\n').slice(1).join('\n'));
  assert.equal(stalledDelivery.planPath, stalledPath);
});

test('plan-less lifecycle events, relay, GET, and stamp expose deliberation semantics without focus mutation', async () => {
  lastFocusUpsert = null;
  const runner: OrchestrationRunner = async (_client, ctx) => {
    fs.writeFileSync(ctx.run.planPath, '# Standalone deliberation\n');
  };
  const delivery = makeDeliver();
  const svc = new OrchestrationService(makeClient(), delivery.fn, { serial: runner, parallel: runner });
  const supervisor = { getUsageLimits: () => ({ available: false }) } as unknown as AgentSupervisor;
  const server = new ApiServer(supervisor, 0, svc, '127.0.0.1');
  const port = await server.start();
  try {
    const launched = await request(port, {
      name: 'groupthink',
      params: { workspaceId: 'ws-1', supervisorId: 'sup-1', topic: 'Plan-less lifecycle' },
    });
    assert.equal(launched.status, 200);
    const { runId } = JSON.parse(launched.body) as { runId: string };
    await waitFor(() => getRun(runId)?.status === 'complete');
    const run = getRun(runId)!;

    const started = eventsFor(runId).find((event) => event.kind === 'started')?.payload as any;
    const complete = eventsFor(runId).find((event) => event.kind === 'complete')?.payload as any;
    assert.equal(started.planId, null);
    assert.equal(started.artifactKind, 'deliberation');
    assert.equal(complete.planId, null);
    assert.equal(complete.artifactKind, 'deliberation');
    assert.match(delivery.calls[0].text, new RegExp(`Deliberation at .*${runId}\\.md`));

    const pulled = await getRequest(port, `/api/orchestrations/${runId}`);
    assert.equal(pulled.status, 200);
    const serialized = JSON.parse(pulled.body);
    assert.equal(serialized.planId, null);
    assert.equal(serialized.artifactKind, 'deliberation');
    assert.equal(focusUpserted(), null, 'plan-less POST does not auto-focus a plan');

    const content = fs.readFileSync(run.planPath, 'utf8');
    assert.equal((content.match(/<!-- groupthink_run:/g) ?? []).length, 1, 'completion stamps exactly once');
  } finally {
    server.stop();
  }
});

test('new-launch plan and intent failures preserve the settled rung codes and exact messages', () => {
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn);
  const cases = [
    {
      req: { planId: 'plan_ffffffff' }, statusCode: 404, code: 'plan_not_found',
      message: "No plan matching plan_id 'plan_ffffffff' exists in the requested workspace scope.",
    },
    {
      req: { planId: DELETED_PLAN_UUID }, statusCode: 409, code: 'plan_deleted',
      message: `Plan '${DELETED_PLAN_UUID}' resolves to a deleted plan row; deleted plans are not a valid target.`,
    },
    {
      req: { planId: FOREIGN_PLAN_UUID }, statusCode: 403, code: 'plan_wrong_workspace',
      message: `Plan '${FOREIGN_PLAN_UUID}' does not belong to workspace 'ws-1'.`,
    },
    {
      req: { planningIntentId: 'int_00000000' }, statusCode: 404, code: 'planning_intent_not_found',
      message: `Planning intent 'int_00000000' is not recorded for plan '${PLAN_UUID}' (resolved from '${PLAN_ARTIFACT_ID}').`,
    },
    {
      req: { planningIntentId: 'int_deadbeef' }, statusCode: 409, code: 'planning_intent_not_active',
      message: `Planning intent 'int_deadbeef' for plan '${PLAN_UUID}' has status 'withdrawn'; expected 'active'.`,
    },
  ];

  for (const expected of cases) {
    assert.throws(() => svc.start_run(baseReq(expected.req)), (err: unknown) => {
      const typed = err as { statusCode?: number; code?: string; message?: string };
      assert.equal(typed.statusCode, expected.statusCode);
      assert.equal(typed.code, expected.code);
      assert.equal(typed.message, expected.message);
      return true;
    });
  }
});

test('resume resolves an explicit alias, rejects a different plan, and skips resolution when omitted', () => {
  const runner: OrchestrationRunner = async () => {};
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });
  const frozen = {
    ...priorRun('resume-plan-ref'),
    planId: PLAN_UUID,
    planningIntentId: 'int_1234abcd',
  };
  db.insertOrchestration(frozen);

  const matched = svc.start_run(baseReq({
    resumeRunId: frozen.runId,
    planId: PLAN_ARTIFACT_ID,
    planningIntentId: frozen.planningIntentId,
  }));
  assert.equal(matched.planId, PLAN_UUID);

  db.insertOrchestration({ ...frozen, runId: 'resume-plan-mismatch' });
  assert.throws(
    () => svc.start_run(baseReq({
      resumeRunId: 'resume-plan-mismatch',
      planId: SECOND_PLAN_ARTIFACT_ID,
      planningIntentId: frozen.planningIntentId,
    })),
    (err: unknown) => {
      const typed = err as { statusCode?: number; code?: string; message?: string };
      assert.equal(typed.statusCode, 409);
      assert.equal(typed.code, 'plan_ref_resume_mismatch');
      assert.equal(
        typed.message,
        `Resume plan_id '${SECOND_PLAN_ARTIFACT_ID}' resolves to '${SECOND_PLAN_UUID}', which is not this run's frozen plan '${PLAN_UUID}'.`,
      );
      return true;
    },
  );

  db.insertOrchestration({ ...frozen, runId: 'resume-plan-omitted' });
  const getPlan = db.getPlan;
  const getPlanByWorkspaceArtifactId = db.getPlanByWorkspaceArtifactId;
  db.getPlan = () => { throw new Error('resume without planId must not resolve'); };
  db.getPlanByWorkspaceArtifactId = () => { throw new Error('resume without planId must not resolve'); };
  try {
    const omitted = svc.start_run(baseReq({ resumeRunId: 'resume-plan-omitted' }));
    assert.equal(omitted.planId, PLAN_UUID);
  } finally {
    db.getPlan = getPlan;
    db.getPlanByWorkspaceArtifactId = getPlanByWorkspaceArtifactId;
  }
});

test('orchestration route binds workspace before start_run and preserves resolver status/code', async () => {
  let startCalls = 0;
  const stubOrchestration = {
    start_run: () => { startCalls++; return { runId: 'must-not-run', planId: null }; },
  } as unknown as ConstructorParameters<typeof ApiServer>[2];
  const supervisor = { getUsageLimits: () => ({ available: false }) } as unknown as AgentSupervisor;
  const server = new ApiServer(supervisor, 0, stubOrchestration, '127.0.0.1');
  const port = await server.start();
  try {
    const denied = await request(port, {
      name: 'groupthink',
      params: { workspaceId: 'ws-built-in', supervisorId: 'sup-1', planId: PLAN_ARTIFACT_ID },
    });
    assert.equal(denied.status, 403);
    assert.equal(startCalls, 0, 'unauthorized workspace is rejected before start_run');
  } finally {
    server.stop();
  }

  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, {
    serial: async () => {}, parallel: async () => {},
  });
  const liveServer = new ApiServer(supervisor, 0, svc, '127.0.0.1');
  const livePort = await liveServer.start();
  try {
    const missing = await request(livePort, {
      name: 'groupthink',
      params: {
        workspaceId: 'ws-1', supervisorId: 'sup-1', planId: 'plan_ffffffff',
        planningIntentId: 'int_1234abcd',
      },
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(JSON.parse(missing.body), {
      error: "No plan matching plan_id 'plan_ffffffff' exists in the requested workspace scope.",
      code: 'plan_not_found',
    });
  } finally {
    liveServer.stop();
  }
});

test('orchestration-route-autofocus-uses-canonical-uuid', async () => {
  lastFocusUpsert = null;
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, {
    serial: async () => {}, parallel: async () => {},
  });
  const supervisor = { getUsageLimits: () => ({ available: false }) } as unknown as AgentSupervisor;
  const server = new ApiServer(supervisor, 0, svc, '127.0.0.1');
  const port = await server.start();
  try {
    const response = await request(port, {
      name: 'groupthink',
      params: {
        workspaceId: 'ws-1', supervisorId: 'sup-1', planId: PLAN_ARTIFACT_ID,
        planningIntentId: 'int_1234abcd',
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { runId: JSON.parse(response.body).runId });
    assert.equal(
      focusUpserted()?.planId,
      PLAN_UUID,
      'REACHABILITY:orchestration-autofocus-uuid',
    );
  } finally {
    server.stop();
  }
});

test('detached start_run returns a runId before the runner completes; status starts running', async () => {
  const gate = deferred();
  const runner: OrchestrationRunner = async () => { await gate.promise; };
  const { fn, calls } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const { runId } = svc.start_run(baseReq());
  assert.ok(runId, 'start_run returns a runId synchronously');

  await waitFor(() => getRun(runId)?.status === 'running');
  assert.equal(getRun(runId)!.status, 'running', 'still running while the runner is blocked');
  assert.ok(eventsFor(runId).some((e) => e.kind === 'started'), 'started event emitted');
  assert.equal(calls.length, 0, 'no delivery before completion');

  gate.resolve();
  await waitFor(() => getRun(runId)?.status === 'complete');
  const done = getRun(runId)!;
  assert.equal(done.status, 'complete');
  assert.ok(done.endedAt, 'endedAt stamped on completion');
  assert.ok(eventsFor(runId).some((e) => e.kind === 'complete'), 'complete event emitted');
  assert.equal(calls.length, 1, 'delivered once on completion');
  assert.match(calls[0].text, /groupthink\.complete/);
});

test('a STALL throw transitions the run to stalled + emits a resume_hint', async () => {
  const runner: OrchestrationRunner = async () => { throw new Error('STALL: turn timeout exceeded'); };
  const { fn, calls } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const { runId } = svc.start_run(planlessReq());
  await waitFor(() => getRun(runId)?.status === 'stalled');
  const run = getRun(runId)!;
  assert.equal(run.status, 'stalled');
  assert.match(run.error || '', /STALL/);
  assert.ok(eventsFor(runId).some((e) => e.kind === 'stalled'));
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /orchestration\.groupthink\.stalled/);
  assert.match(calls[0].text, new RegExp(runId), 'resume_hint carries the runId');
  const payload = eventsFor(runId).find((event) => event.kind === 'stalled')?.payload as any;
  assert.equal(payload.planId, null);
  assert.equal(payload.artifactKind, 'deliberation');
  assert.equal(payload.resume_hint.params.resumeRunId, runId);
});

test('T12: only controlled deliberation misses map to no_deliberation_written', async () => {
  const cases = [
    { message: 'STALL: no deliberation file at C:/tmp/missing.md', reason: 'no_deliberation_written', kind: 'stalled' },
    {
      message: 'STALL: the deliberation artifact at C:/tmp/wrong.md exists but does not match the run identity',
      reason: 'no_deliberation_written', kind: 'stalled',
    },
    { message: 'deliberation provider failed unexpectedly', reason: 'timeout', kind: 'error' },
  ];

  for (const row of cases) {
    const runner: OrchestrationRunner = async () => { throw new Error(row.message); };
    const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });
    const { runId } = svc.start_run(planlessReq());
    await waitFor(() => getRun(runId)?.status === row.kind);
    const payload = eventsFor(runId).find((event) => event.kind === row.kind)?.payload as any;
    assert.equal(payload.reason, row.reason, row.message);
  }
});

test('a non-stall throw transitions the run to error', async () => {
  const runner: OrchestrationRunner = async () => { throw new Error('boom: unexpected'); };
  const { fn } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const { runId } = svc.start_run(baseReq());
  await waitFor(() => getRun(runId)?.status === 'error');
  assert.equal(getRun(runId)!.status, 'error');
  assert.ok(eventsFor(runId).some((e) => e.kind === 'error'));
});

test('abort cancels the run, delivers an aborted event, and persists aborted', async () => {
  const runner: OrchestrationRunner = async (_client, ctx: OrchestrationRunContext) =>
    new Promise<void>((_resolve, reject) => {
      if (ctx.signal.aborted) return reject(new Error('aborted'));
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const { fn, calls } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const { runId } = svc.start_run(planlessReq());
  await waitFor(() => getRun(runId)?.status === 'running');

  const res = svc.abort(runId);
  assert.equal(res.ok, true);
  assert.equal(getRun(runId)!.status, 'aborted');
  await waitFor(() => calls.some((c) => /orchestration\.groupthink\.aborted/.test(c.text)));
  // The runner rejection after abort must NOT also deliver a stalled event.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!calls.some((c) => /stalled/.test(c.text)), 'no stalled delivery on an aborted run');
  const payload = JSON.parse(calls.find((c) => /orchestration\.groupthink\.aborted/.test(c.text))!.text.split('\n').slice(1).join('\n'));
  assert.equal(payload.planId, null);
  assert.equal(payload.artifactKind, 'deliberation');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'resume_hint'), false);
});

test('delivery_failed event is recorded when the supervisor is unreachable', async () => {
  const runner: OrchestrationRunner = async () => {};
  const { fn } = makeDeliver(false);   // deliver always reports ok:false
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const { runId } = svc.start_run(baseReq());
  await waitFor(() => getRun(runId)?.status === 'complete');
  await waitFor(() => eventsFor(runId).some((e) => e.kind === 'delivery_failed'));
  assert.ok(eventsFor(runId).some((e) => e.kind === 'delivery_failed'));
});

test('boot reconcile marks orphaned running rows aborted + emits a resume hint', async () => {
  const orphan: OrchestrationRun = {
    runId: 'orphan01',
    name: 'groupthink',
    mode: 'serial',
    status: 'running',
    workspaceId: 'ws-1',
    supervisorId: 'sup-boot',
    topic: 'left mid-flight',
    planPath: path.join(os.tmpdir(), 'plan.md'),
    planId: undefined,
    planOutputKind: 'library-deliberation',
    planBindingMode: 'none',
    leadProvider: 'claude',
    reviewerProvider: 'codex',
    turnTimeoutMs: 600000,
    lastRelayedTs: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.insertOrchestration(orphan);

  const { fn, calls } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn);
  svc.start();

  assert.equal(getRun('orphan01')!.status, 'aborted');
  await waitFor(() => calls.some((c) => /dashboard_restarted/.test(c.text)));
  const delivered = calls.find((c) => /dashboard_restarted/.test(c.text))!;
  assert.match(delivered.text, /orphan01/, 'resume hint carries the orphaned runId');
  assert.equal(delivered.supervisorId, 'sup-boot');
  const payload = JSON.parse(delivered.text.split('\n').slice(1).join('\n'));
  assert.equal(payload.planId, null);
  assert.equal(payload.artifactKind, 'deliberation');
  assert.equal(payload.resume_hint.params.resumeRunId, 'orphan01');
});

// ── WP6: planning-surface rail persistence ──────────────────────────────────

test('WP6: start_run persists the canonical planId + sectionAnchor onto the run row', async () => {
  const gate = deferred();
  const runner: OrchestrationRunner = async () => { await gate.promise; };
  const { fn } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const { runId } = svc.start_run(baseReq({ planId: PLAN_ARTIFACT_ID, sectionAnchor: 'sec_x1' }));
  const run = getRun(runId)!;
  assert.equal(run.planId, PLAN_UUID, 'planId frozen on the run as the row UUID');
  assert.equal(run.sectionAnchor, 'sec_x1', 'sectionAnchor frozen on the run');
  gate.resolve();
  await waitFor(() => getRun(runId)?.status === 'complete');
});

test('WP-P8B: concurrent dispatches may target the same plan after HTML writeback removal', async () => {
  const gate = deferred();
  const runner: OrchestrationRunner = async () => { await gate.promise; };
  const { fn } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const first = svc.start_run(baseReq({ planId: PLAN_ARTIFACT_ID, sectionAnchor: 'sec_a' }));
  await waitFor(() => getRun(first.runId)?.status === 'running');
  const second = svc.start_run(baseReq({ planId: PLAN_ARTIFACT_ID, sectionAnchor: 'sec_b' }));
  await waitFor(() => getRun(second.runId)?.status === 'running');
  assert.notEqual(first.runId, second.runId);

  gate.resolve();
  await waitFor(() => getRun(first.runId)?.status === 'complete');
  await waitFor(() => getRun(second.runId)?.status === 'complete');
});

test('new launches reject missing or mismatched plan/intent bindings before persistence', () => {
  const runner: OrchestrationRunner = async () => {};
  const { fn } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const before = runsStore.size;
  assert.throws(() => svc.start_run(baseReq({ planId: undefined })), /must be provided together, or both omitted/);
  assert.throws(() => svc.start_run(baseReq({ planningIntentId: undefined })), /must be provided together, or both omitted/);
  assert.throws(() => svc.start_run(baseReq({ planningIntentId: 'int_deadbeef' })), /status 'withdrawn'; expected 'active'/);
  assert.throws(() => svc.start_run(baseReq({ planningIntentId: 'intent_bad' })), /must match/);
  assert.equal(runsStore.size, before, 'rejected launches write no orchestration row');
});

// ── GT-C §1.6 / §1.10 — T1 trail materialization ordering ────────────

test('a rail run skips legacy stampPlanMembers', async () => {
  const gate = deferred();
  const runner: OrchestrationRunner = async () => { await gate.promise; };
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });

  let stampCalled = false;
  (svc as any).stampPlanMembers = () => { stampCalled = true; };

  const { runId } = svc.start_run(baseReq({ planId: PLAN_ARTIFACT_ID, sectionAnchor: 'sec_z' }));
  await waitFor(() => getRun(runId)?.status === 'running');
  gate.resolve();
  await waitFor(() => getRun(runId)?.status === 'complete');
  assert.equal(stampCalled, false, 'the legacy whole-file stamp is skipped on a rail surface');
});

test('a resumed historical non-rail run keeps legacy stamp behavior', async () => {
  const gate = deferred();
  const runner: OrchestrationRunner = async () => { await gate.promise; };
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });

  let stampCalled = false;
  (svc as any).stampPlanMembers = () => { stampCalled = true; };

  db.insertOrchestration(priorRun('legacy-unbound'));
  const { runId } = svc.start_run(baseReq({ resumeRunId: 'legacy-unbound' }));
  await waitFor(() => getRun(runId)?.status === 'running');
  gate.resolve();
  await waitFor(() => getRun(runId)?.status === 'complete');
  assert.equal(stampCalled, true, 'the non-rail path still stamps groupthink_run');
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(providerSettingsRoot, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
})();
