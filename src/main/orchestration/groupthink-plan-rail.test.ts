
// WP6 — planning-surface rail on the GroupThink launch + done-detection paths.
//
// Proves the two hops that carry plan_id + section_anchor from a dispatched run
// all the way to a launched member agent's environment, plus the done-detection
// swap (whole-file existsSync → post-dispatch document mtime):
//
//   1. RUN → LAUNCH INPUT (behavioral): runSerial/runParallel stamp
//      launchInput.planId / launchInput.planSection onto EVERY member from
//      ctx.run.planId / ctx.run.sectionAnchor.
//   2. LAUNCH INPUT → AGENT ENV (structural, mirrors supervisor-plan-env.test):
//      BOTH launch sites in supervisor/index.ts inject agent.planId /
//      agent.planSection into AGENT_DASHBOARD_PLAN_ID / _PLAN_SECTION — the
//      native `extraEnv` record AND the WSL `wslEnvPrefix` array (§7 risk 1,
//      the dual-injection trap). Together these pin the whole chain so a member
//      launched by a rail-carrying run demonstrably receives the plan env under
//      Windows and WSL alike.
//   3. DONE-DETECTION SWAP (behavioral): a bound run completes only after its
//      folder-native document changes after dispatch; a pre-existing file alone
//      never short-circuits it.
//
//   npm run build:main
//   node dist/main/main/orchestration/groupthink-plan-rail.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planArtifactHash, runSerial, runParallel } from './groupthink-v2';
import { OrchestrationService } from './service';
import { Agent } from '../../shared/types';
import { DashboardClient, OrchestrationRun, OrchestrationRunContext } from './types';

// ── In-memory DB patch (mirrors orchestration-service.test): the SQLite native
// binding is Electron-ABI, so the service reads patched db exports at call time.
// The planning-surface demo-fix test below dispatches a REAL rail run through
// OrchestrationService + the REAL runSerial runner, so we need getPlan (the new
// path-resolution hop) plus the orchestration store fns. The runner-level tests
// above never touch db, so this patch is inert for them.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('../database') as Record<string, any>;
const svcRunsStore = new Map<string, OrchestrationRun>();
const svcPlansStore = new Map<string, { id: string; workspaceId: string; path: string; deletedAt: null; artifactId?: string }>();
const svcEvents: Array<{ runId: string; kind: string; payload: unknown }> = [];
const svcClone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
let svcWorkspaceRoot = os.tmpdir();
db.getWorkspace = (id: string) => (id === 'ws-1' ? { id: 'ws-1', path: svcWorkspaceRoot } : null);
db.getPlan = (id: string) => (svcPlansStore.has(id) ? svcClone(svcPlansStore.get(id)!) : null);
db.getPlanIntentRow = (_workspaceId: string, planId: string, intentId: string) =>
  planId === '00000000-0000-4000-8000-000000000001' && intentId === 'int_1234abcd'
    ? { planId, intentId, status: 'active' }
    : null;
db.insertOrchestration = (r: OrchestrationRun) => { svcRunsStore.set(r.runId, svcClone(r)); };
db.updateOrchestration = (r: OrchestrationRun) => { svcRunsStore.set(r.runId, svcClone(r)); };
db.getOrchestrationRun = (id: string) => (svcRunsStore.has(id) ? svcClone(svcRunsStore.get(id)!) : null);
db.listOrchestrationRuns = () => Array.from(svcRunsStore.values()).map(svcClone);
db.insertOrchestrationEvent = (e: any) => { svcEvents.push(svcClone(e)); };
db.insertOrchestrationMember = () => {};
db.markActiveRunsAborted = () => [];
// Clamp setTimeout so 2000ms polls fire in ≤2ms (same trick as groupthink-v2.test).
const realSetTimeout = global.setTimeout;
(global as any).setTimeout = ((fn: any, ms?: number, ...rest: any[]) =>
  realSetTimeout(fn, Math.min(typeof ms === 'number' ? ms : 0, 2), ...rest)) as typeof setTimeout;

interface RelayMessage { content: string; ts: string; turnComplete?: boolean }

interface FakeAgent {
  id: string; title: string; provider: string; status: string;
  latest: RelayMessage | null; counter: number;
  pending: boolean; getCalls: number; revealAt: number; sendCount: number;
}
interface FakeState { agents: Map<string, FakeAgent>; launchInputs: any[]; events: string[]; sentPrompts: Array<{ id: string; text: string }>; }
interface FakeConfig {
  onTurn?: (a: FakeAgent, state: FakeState) => void;
}

let agentSeq = 0;
function makeFake(cfg: FakeConfig = {}): { client: DashboardClient; state: FakeState } {
  const state: FakeState = { agents: new Map(), launchInputs: [], events: [], sentPrompts: [] };
  const arm = (a: FakeAgent, revealAt: number) => { a.pending = true; a.getCalls = 0; a.revealAt = revealAt; };
  const reveal = (a: FakeAgent) => {
    a.counter++;
    a.latest = { content: `${a.title} :: turn ${a.counter}`, ts: `${a.id}#${String(a.counter).padStart(4, '0')}`, turnComplete: true };
    a.pending = false;
    state.events.push(`turn:${a.id}#${a.counter}`);
    cfg.onTurn?.(a, state);
  };
  const client: DashboardClient = {
    launchAgent: async (input) => {
      const id = `agent-${++agentSeq}`;
      const a: FakeAgent = { id, title: input.title || id, provider: String(input.provider), status: 'idle', latest: null, counter: 0, pending: false, getCalls: 0, revealAt: 1, sendCount: 0 };
      state.agents.set(id, a);
      state.launchInputs.push(input);
      state.events.push(`launch:${a.title}`);
      return { id, status: 'idle' } as unknown as Agent;
    },
    getAgent: (id) => (state.agents.get(id) as unknown as Agent) ?? null,
    getMessages: async (id) => {
      const a = state.agents.get(id);
      if (!a) return [];
      a.getCalls++;
      if (a.pending && a.getCalls >= a.revealAt) reveal(a);
      return a.latest ? [{ ...a.latest }] : [];
    },
    sendInput: async (id, text) => {
      const a = state.agents.get(id);
      if (!a) throw new Error(`sendInput to unknown agent ${id}`);
      state.sentPrompts.push({ id, text: String(text ?? '') });
      a.sendCount++;
      arm(a, a.sendCount === 1 ? 2 : 1);
    },
    sendInputConfirmed: async (id, text) => {
      const a = state.agents.get(id);
      if (!a) throw new Error(`sendInputConfirmed to unknown agent ${id}`);
      state.sentPrompts.push({ id, text: String(text ?? '') });
      a.sendCount++;
      arm(a, a.sendCount === 1 ? 2 : 1);
      return { delivered: true, confirmed: true, mode: 'hook' as const };
    },
    resubmitEnter: () => {},
    recoverChatBinding: () => {},
    isInputInFlight: () => false,
    stopAgent: async () => {},
  };
  return { client, state };
}

let planSeq = 0;
function freshPlanPath(): string { return path.join(os.tmpdir(), `gt-rail-${process.pid}-${++planSeq}.md`); }
function rm(p: string): void { try { fs.unlinkSync(p); } catch { /* ignore */ } }

function makeRun(overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    runId: 'run-rail', name: 'groupthink', mode: 'serial', status: 'running',
    workspaceId: 'ws-1', supervisorId: 'sup-1', topic: 'Plan a thing',
    planPath: freshPlanPath(), leadProvider: 'claude', reviewerProvider: 'codex',
    turnTimeoutMs: 600000, recoveryRepollMs: 30, lastRelayedTs: {},
    startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
function makeCtx(run: OrchestrationRun): OrchestrationRunContext {
  return { run, signal: new AbortController().signal, persist: () => {}, emit: () => {} };
}

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }
// ── Hop 1: run → launch input ────────────────────────────────────────────────

test('serial: every launched member carries the run planId + sectionAnchor', async () => {
  const run = makeRun({ planId: 'plan-9', sectionAnchor: 'sec_z' });
  // Terminate only once BOTH members have launched: fire the section change after
  // the Reviewer produces its first turn (BUG-29 launches it after lead turn 1).
  const { client, state } = makeFake({
    onTurn: (a) => { if (a.title.startsWith('Reviewer')) fs.writeFileSync(run.planPath, 'updated'); },
  });
  try {
    await runSerial(client, makeCtx(run));
    assert.equal(state.launchInputs.length, 2, 'lead + reviewer both launched');
    for (const input of state.launchInputs) {
      assert.equal(input.planId, 'plan-9', `${input.title} launch input carries planId`);
      assert.equal(input.planSection, 'sec_z', `${input.title} launch input carries planSection`);
    }
    assert.equal(fs.existsSync(run.planPath), true, 'completion came from the bound document update');
  } finally { rm(run.planPath); }
});

test('parallel: both planners carry the run planId + sectionAnchor', async () => {
  const run = makeRun({ mode: 'parallel', planId: 'plan-p', sectionAnchor: 'sec_syn' });
  // Complete at R3: let the synthesizer's R3 turn fire the section change.
  let synthTurns = 0;
  const { client, state } = makeFake({
    onTurn: (a) => {
      if (a.title.startsWith('Synthesizer') && ++synthTurns >= 3) fs.writeFileSync(run.planPath, 'updated');
    },
  });
  try {
    await runParallel(client, makeCtx(run));
    assert.equal(state.launchInputs.length, 2, 'synthesizer + peer launched');
    for (const input of state.launchInputs) {
      assert.equal(input.planId, 'plan-p', `${input.title} carries planId`);
      assert.equal(input.planSection, 'sec_syn', `${input.title} carries planSection`);
    }
    assert.equal(fs.existsSync(run.planPath), true, 'R3 completed on the bound document update');
  } finally { rm(run.planPath); }
});

test('rail-less run leaves planId/planSection unset on launch inputs (unchanged legacy behavior)', async () => {
  const run = makeRun();   // no planId/sectionAnchor
  const { client, state } = makeFake({
    onTurn: (a) => { if (a.title.startsWith('Lead') && a.counter === 2) fs.writeFileSync(run.planPath, 'plan'); },
  });
  try {
    await runSerial(client, makeCtx(run));
    for (const input of state.launchInputs) {
      assert.equal(input.planId, undefined, 'no planId stamped on a rail-less run');
      assert.equal(input.planSection, undefined, 'no planSection stamped on a rail-less run');
    }
  } finally { rm(run.planPath); }
});

// ── Hop 2: launch input → agent env, at BOTH sites (structural parity) ────────

// __dirname at runtime is dist/main/main/orchestration → four hops to repo root.
const SUPERVISOR_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', '..', 'src', 'main', 'supervisor', 'index.ts'),
  'utf8',
);
test('native site: extraEnv injects AGENT_DASHBOARD_PLAN_ID/_SECTION from agent.plan*', () => {
  assert.match(SUPERVISOR_SRC, /extraEnv\.AGENT_DASHBOARD_PLAN_ID\s*=\s*agent\.planId/);
  assert.match(SUPERVISOR_SRC, /extraEnv\.AGENT_DASHBOARD_PLAN_SECTION\s*=\s*agent\.planSection/);
});
test('WSL site: wslEnvPrefix injects AGENT_DASHBOARD_PLAN_ID/_SECTION from agent.plan*', () => {
  assert.match(SUPERVISOR_SRC, /wslEnvPrefix\.push\(`AGENT_DASHBOARD_PLAN_ID=\$\{[^}]*agent\.planId[^}]*\}`\)/);
  assert.match(SUPERVISOR_SRC, /wslEnvPrefix\.push\(`AGENT_DASHBOARD_PLAN_SECTION=\$\{[^}]*agent\.planSection[^}]*\}`\)/);
});

// ── Hop 3: done-detection swap (existsSync → post-dispatch mtime) ─────────────

test('done-detection: a bound run ignores a file older than dispatch and completes after it changes', async () => {
  const startedAt = new Date().toISOString();
  const run = makeRun({ planId: 'plan-x', sectionAnchor: 'sec_q', startedAt });
  // A file at planPath would short-circuit the LEGACY existsSync gate on turn 1.
  fs.writeFileSync(run.planPath, 'pre-existing registered surface');
  const old = new Date(Date.parse(startedAt) - 10_000);
  fs.utimesSync(run.planPath, old, old);
  const { client, state } = makeFake({
    onTurn: (a) => { if (a.title.startsWith('Lead')) fs.writeFileSync(run.planPath, 'updated after dispatch'); },
  });
  try {
    await runSerial(client, makeCtx(run));
    assert.equal(state.launchInputs.length, 1, 'the first post-dispatch update completes the run');
  } finally { rm(run.planPath); }
});

test('done-detection: a bound run completes as soon as its document is created', async () => {
  const run = makeRun({ planId: 'plan-y', sectionAnchor: 'sec_done' });
  const { client, state } = makeFake({
    onTurn: (a) => { if (a.title.startsWith('Lead')) fs.writeFileSync(run.planPath, 'created'); },
  });
  try {
    await runSerial(client, makeCtx(run));   // resolves (no throw)
    assert.equal(state.launchInputs.length, 1, 'only the Lead launched — document creation ended the run at turn 1');
    assert.equal(fs.existsSync(run.planPath), true, 'completed with the bound document on disk');
  } finally { rm(run.planPath); }
});

// ── Fix 3 (planning-surface demo, 2026-07-06): rail runs resolve the plan row's
//    REAL path — never the legacy `plans/new-plan.md` default ─────────────────
//
// The demo GroupThink (a rail run: planId + sectionAnchor) baked the default
// plan_path into the Lead's termination instructions AND the groupthink.complete
// message, forcing the Lead to self-correct. These pin the fix end-to-end: a
// service.start_run rail dispatch resolves getPlan(planId).path into run.planPath,
// so every prompt hop (writebackClause → serialLeadPrompt kickoff) and the
// completion delivery reference that real path, and the default appears nowhere.

async function svcWaitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => realSetTimeout(r, 5));
  }
  throw new Error('svcWaitFor timed out');
}

const FOLDER_PLAN_ID = '00000000-0000-4000-8000-000000000001';
const FOLDER_PLAN_ARTIFACT_ID = 'plan_cba81aeb';
const FOLDER_INTENT_ID = 'int_1234abcd';

interface FolderPlanFixture {
  root: string;
  folder: string;
  planPath: string;
  cleanup(): void;
}

function scaffoldFolderPlan(): FolderPlanFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp4-plan-'));
  const folder = path.join(root, '.lares', 'plans', `wp4-${path.basename(root)}`);
  const planPath = path.join(folder, 'plan.md');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'plan.json'), JSON.stringify({
    schema_version: 1,
    plan_artifact_id: FOLDER_PLAN_ARTIFACT_ID,
    title: 'WP-4 integration fixture',
  }, null, 2));
  fs.writeFileSync(planPath, '# Scaffolded folder plan\n');
  svcWorkspaceRoot = root;
  svcPlansStore.set(FOLDER_PLAN_ID, {
    id: FOLDER_PLAN_ID,
    workspaceId: 'ws-1',
    path: path.relative(root, planPath),
    deletedAt: null,
    artifactId: FOLDER_PLAN_ARTIFACT_ID,
  });
  return {
    root, folder, planPath,
    cleanup: () => {
      const resolved = path.resolve(root);
      assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep), 'fixture cleanup stays inside OS temp');
      fs.rmSync(resolved, { recursive: true, force: true });
      svcWorkspaceRoot = os.tmpdir();
    },
  };
}

function resetSvcState(): void {
  svcRunsStore.clear();
  svcEvents.length = 0;
}

function matchingArtifact(run: OrchestrationRun): string {
  return `---\n` +
    `intent_id: ${run.planningIntentId}\n` +
    `plan_artifact_id: ${run.planArtifactId}\n` +
    `status: active\n` +
    `date: 2026-08-20\n` +
    `---\n\n# Integrated deliberation\n`;
}

function startFolderRun(
  svc: OrchestrationService,
  mode: 'serial' | 'parallel',
  extra: Record<string, unknown> = {},
): { runId: string; planId: string | null } {
  return svc.start_run({
    name: 'groupthink', workspaceId: 'ws-1', supervisorId: 'sup-1',
    topic: 'Exercise the folder-plan integration', mode,
    planId: FOLDER_PLAN_ID, planningIntentId: FOLDER_INTENT_ID,
    ...extra,
  } as any);
}

function makeService(client: DashboardClient): OrchestrationService {
  return new OrchestrationService(client, async () => ({ ok: true }), { serial: runSerial, parallel: runParallel });
}

test('folder plan serial: reviewer launches and completion waits for matching derived artifact', async () => {
  resetSvcState();
  const fixture = scaffoldFolderPlan();
  let target = '';
  let absentAtLeadTurn1 = false;
  const { client, state } = makeFake({
    onTurn: (agent) => {
      if (agent.title.startsWith('Lead') && agent.counter === 1) {
        absentAtLeadTurn1 = target !== '' && !fs.existsSync(target);
      }
      if (agent.title.startsWith('Lead') && agent.counter === 2) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, matchingArtifact(db.getOrchestrationRun(runId)!));
      }
    },
  });
  const svc = makeService(client);
  let runId = '';
  try {
    ({ runId } = startFolderRun(svc, 'serial'));
    target = db.getOrchestrationRun(runId)!.planPath;
    await svcWaitFor(() => db.getOrchestrationRun(runId)?.status === 'complete');
    assert.equal(absentAtLeadTurn1, true, 'derived target was absent after lead turn 1');
    assert.equal(state.launchInputs.length, 2, 'reviewer launched instead of turn-1 false completion');
    assert.notEqual(target, fixture.planPath, 'completion target is not scaffolded plan.md');
    assert.equal(fs.readFileSync(fixture.planPath, 'utf8'), '# Scaffolded folder plan\n', 'plan.md stayed untouched');
    const complete = svcEvents.find((event) => event.runId === runId && event.kind === 'complete');
    assert.deepEqual(complete?.payload, { planPath: target }, 'complete event names the derived artifact');
  } finally {
    fixture.cleanup();
  }
});

test('folder plan parallel: both planners launch and synthesis completes on derived artifact write', async () => {
  resetSvcState();
  const fixture = scaffoldFolderPlan();
  let target = '';
  let absentBeforeSynthesis = true;
  const { client, state } = makeFake({
    onTurn: (agent) => {
      if (!agent.title.startsWith('Synthesizer')) return;
      if (agent.counter < 3) absentBeforeSynthesis = absentBeforeSynthesis && target !== '' && !fs.existsSync(target);
      if (agent.counter === 3) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, matchingArtifact(db.getOrchestrationRun(runId)!));
      }
    },
  });
  const svc = makeService(client);
  let runId = '';
  try {
    ({ runId } = startFolderRun(svc, 'parallel'));
    target = db.getOrchestrationRun(runId)!.planPath;
    await svcWaitFor(() => db.getOrchestrationRun(runId)?.status === 'complete');
    assert.equal(state.launchInputs.length, 2, 'both planners launched');
    assert.equal(absentBeforeSynthesis, true, 'target stayed absent through R1 and R2');
    const synthesizer = [...state.agents.values()].find((agent) => agent.title.startsWith('Synthesizer'))!;
    assert.equal(synthesizer.counter, 3, 'synthesis reached R3 before completion');
    assert.equal(fs.existsSync(target), true, 'derived synthesis artifact exists');
  } finally {
    fixture.cleanup();
  }
});

test('two concurrent folder-plan runs freeze distinct targets and complete without collision', async () => {
  resetSvcState();
  const fixture = scaffoldFolderPlan();
  const targets = new Map<string, OrchestrationRun>();
  let sharedState!: FakeState;
  const { client, state } = makeFake({
    onTurn: (agent) => {
      if (!agent.title.startsWith('Lead') || agent.counter !== 2) return;
      const kickoff = sharedState.sentPrompts.find((prompt) => prompt.id === agent.id && prompt.text.includes('Termination contract'));
      const entry = [...targets.entries()].find(([target]) => kickoff?.text.includes(target));
      assert.ok(entry, 'lead kickoff maps to exactly one frozen target');
      fs.mkdirSync(path.dirname(entry![0]), { recursive: true });
      fs.writeFileSync(entry![0], matchingArtifact(entry![1]));
    },
  });
  sharedState = state;
  const svc = makeService(client);
  try {
    const first = startFolderRun(svc, 'serial');
    const second = startFolderRun(svc, 'serial');
    const firstRun = db.getOrchestrationRun(first.runId)!;
    const secondRun = db.getOrchestrationRun(second.runId)!;
    targets.set(firstRun.planPath, firstRun);
    targets.set(secondRun.planPath, secondRun);
    assert.notEqual(firstRun.planPath, secondRun.planPath, 'concurrent runs freeze distinct derived targets');
    await svcWaitFor(() => db.getOrchestrationRun(first.runId)?.status === 'complete'
      && db.getOrchestrationRun(second.runId)?.status === 'complete');
    assert.equal(fs.existsSync(firstRun.planPath), true);
    assert.equal(fs.existsSync(secondRun.planPath), true);
    assert.notEqual(fs.realpathSync(firstRun.planPath), fs.realpathSync(secondRun.planPath), 'artifacts did not collide');
  } finally {
    fixture.cleanup();
  }
});

test('restart-resume accepts a persisted-baseline delta with matching identity', async () => {
  resetSvcState();
  const fixture = scaffoldFolderPlan();
  const { client, state } = makeFake();
  const stalling = new OrchestrationService(client, async () => ({ ok: true }), {
    serial: async () => { throw new Error('STALL: simulated dashboard restart'); },
    parallel: runParallel,
  });
  try {
    const { runId } = startFolderRun(stalling, 'serial');
    await svcWaitFor(() => db.getOrchestrationRun(runId)?.status === 'stalled');
    const persisted = db.getOrchestrationRun(runId)!;
    assert.equal(persisted.planBaselineHash, null, 'absent launch target persisted as null baseline');
    fs.mkdirSync(path.dirname(persisted.planPath), { recursive: true });
    fs.writeFileSync(persisted.planPath, matchingArtifact(persisted));

    // Simulate process rehydration: only the cloned row survives into a new service.
    svcRunsStore.set(runId, svcClone(persisted));
    const restarted = makeService(client);
    restarted.start_run({
      name: 'groupthink', workspaceId: 'ws-1', supervisorId: 'sup-1', resumeRunId: runId,
    } as any);
    await svcWaitFor(() => db.getOrchestrationRun(runId)?.status === 'complete');
    assert.equal(state.launchInputs.length, 1, 'matching changed artifact is accepted before reviewer launch');
    assert.equal(db.getOrchestrationRun(runId)!.planBaselineHash, null, 'resume preserved the persisted baseline');
  } finally {
    fixture.cleanup();
  }
});

test('restart-resume re-baselines non-matching content and keeps waiting', async () => {
  resetSvcState();
  const fixture = scaffoldFolderPlan();
  let resumedTarget = '';
  let invalidBaseline = '';
  const { client, state } = makeFake({
    onTurn: (agent) => {
      if (agent.title.startsWith('Lead') && agent.counter === 1) {
        assert.equal(fs.readFileSync(resumedTarget, 'utf8').includes('int_deadbeef'), true,
          'invalid resume artifact still exists after lead turn 1');
      }
      if (agent.title.startsWith('Lead') && agent.counter === 2) {
        fs.writeFileSync(resumedTarget, matchingArtifact(db.getOrchestrationRun(runId)!));
      }
    },
  });
  const stalling = new OrchestrationService(client, async () => ({ ok: true }), {
    serial: async () => { throw new Error('STALL: simulated dashboard restart'); },
    parallel: runParallel,
  });
  let runId = '';
  try {
    ({ runId } = startFolderRun(stalling, 'serial'));
    await svcWaitFor(() => db.getOrchestrationRun(runId)?.status === 'stalled');
    const persisted = db.getOrchestrationRun(runId)!;
    resumedTarget = persisted.planPath;
    fs.mkdirSync(path.dirname(resumedTarget), { recursive: true });
    fs.writeFileSync(resumedTarget, matchingArtifact(persisted).replace(FOLDER_INTENT_ID, 'int_deadbeef'));
    invalidBaseline = planArtifactHash(resumedTarget)!;
    svcRunsStore.set(runId, svcClone(persisted));

    const restarted = makeService(client);
    restarted.start_run({
      name: 'groupthink', workspaceId: 'ws-1', supervisorId: 'sup-1', resumeRunId: runId,
    } as any);
    await svcWaitFor(() => db.getOrchestrationRun(runId)?.status === 'complete');
    assert.equal(state.launchInputs.length, 2, 'invalid artifact was re-baselined and reviewer launched');
    assert.equal(db.getOrchestrationRun(runId)!.planBaselineHash, invalidBaseline,
      'persisted resume baseline is the invalid pre-existing content hash');
  } finally {
    fixture.cleanup();
  }
});

test('folder plan with sectionAnchor still derives a fresh target and cannot mtime-complete before creation', async () => {
  resetSvcState();
  const fixture = scaffoldFolderPlan();
  let target = '';
  let absentAtLeadTurn1 = false;
  const { client, state } = makeFake({
    onTurn: (agent) => {
      if (agent.title.startsWith('Lead') && agent.counter === 1) {
        absentAtLeadTurn1 = target !== '' && !fs.existsSync(target);
      }
      if (agent.title.startsWith('Reviewer') && agent.counter === 1) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, matchingArtifact(db.getOrchestrationRun(runId)!));
      }
    },
  });
  const svc = makeService(client);
  let runId = '';
  try {
    ({ runId } = startFolderRun(svc, 'serial', { sectionAnchor: 'sec_bonus' }));
    target = db.getOrchestrationRun(runId)!.planPath;
    await svcWaitFor(() => db.getOrchestrationRun(runId)?.status === 'complete');
    assert.notEqual(target, fixture.planPath, 'sectionAnchor does not defeat derived target selection');
    assert.equal(absentAtLeadTurn1, true, 'mtime detector saw no file at lead turn 1');
    assert.equal(state.launchInputs.length, 2, 'reviewer launched before fresh target creation');
  } finally {
    fixture.cleanup();
  }
});

const REAL_PLAN_REL = 'plans/demo-plan-planning-surface-acceptance.html';
const REAL_PLAN_BASENAME = 'demo-plan-planning-surface-acceptance.html';

test('rail dispatch resolves the plan row path into run.planPath (never plans/new-plan.md)', async () => {
  svcPlansStore.set('00000000-0000-4000-8000-000000000001', { id: '00000000-0000-4000-8000-000000000001', workspaceId: 'ws-1', path: REAL_PLAN_REL, deletedAt: null });
  const realPlanPath = path.join(os.tmpdir(), REAL_PLAN_REL);
  const { client, state } = makeFake({
    onTurn: (a) => {
      if (!a.title.startsWith('Reviewer')) return;
      fs.mkdirSync(path.dirname(realPlanPath), { recursive: true });
      fs.writeFileSync(realPlanPath, 'updated');
    },
  });
  const delivered: string[] = [];
  const svc = new OrchestrationService(client, async (_sup, text) => { delivered.push(text); return { ok: true }; },
    { serial: runSerial, parallel: runParallel });

  const { runId } = svc.start_run({
    name: 'groupthink', workspaceId: 'ws-1', supervisorId: 'sup-1',
    topic: 'Plan the acceptance demo', mode: 'serial',
    planId: '00000000-0000-4000-8000-000000000001', planningIntentId: 'int_1234abcd', sectionAnchor: 'sec_demo',
  } as any);

  await svcWaitFor(() => db.getOrchestrationRun(runId)?.status === 'complete');
  const run = db.getOrchestrationRun(runId)!;

  // 1. run.planPath is the plan row's real path (joined to the workspace), NOT the default.
  assert.ok(run.planPath.includes(REAL_PLAN_BASENAME), `run.planPath resolves to the plan row path (got ${run.planPath})`);
  assert.ok(!run.planPath.includes('new-plan.md'), 'run.planPath is not the plans/new-plan.md default');

  // 2. Every kickoff/relay prompt sent references the real path; the default appears in NONE.
  const leadKickoff = state.sentPrompts.find((p) => p.text.includes('Termination contract'));
  assert.ok(leadKickoff, 'the Lead received a kickoff carrying the termination contract');
  assert.ok(leadKickoff!.text.includes(REAL_PLAN_BASENAME), 'the termination contract writes back to the real plan path');
  for (const p of state.sentPrompts) {
    assert.ok(!p.text.includes('new-plan.md'), `no sent prompt mentions the plan_path default (offending: ${p.id})`);
  }

  // 3. The groupthink.complete delivery references the real path, never the default.
  const completeMsg = delivered.find((t) => t.includes('groupthink.complete'));
  assert.ok(completeMsg, 'a groupthink.complete message was delivered');
  assert.ok(completeMsg!.includes(REAL_PLAN_BASENAME), 'completion message references the real plan path');
  assert.ok(!completeMsg!.includes('new-plan.md'), 'completion message never names the plan_path default');
  rm(realPlanPath);
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
