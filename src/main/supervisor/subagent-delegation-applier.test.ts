// WP-2 (plan_11bfa6ab) — AgentSupervisor.applyHookStatusEvent delegation
// contract + the zero-in-flight / running-child watchdog and the restart
// reconciliation gate. Deliberation int_7c2e9a41 §§D1–D5, D8 are authoritative.
//
// The pure correlation is covered in subagent-delegation-tracker.test.ts; this
// file exercises the AUTHORITATIVE applier seam against a real AgentSupervisor
// (db-patched, injected clock) so the production Stop-suppression branch, the
// watermark isolation, the combination validation, and the monitorTick drain
// are all proven end-to-end. The reachability mutation
// (reachability-mutations/wp2-parent-stop-suppression.patch) flips the
// count>0 suppression branch; the suppression case below carries the
// REACHABILITY:subagent-delegation-applier marker and fails under the mutation.
//
// Compile via the main tsconfig and run through the registered runner:
//   npm run build:dev:main
//   MAIN_TEST_COMPILED_ROOT=dist-dev/main node scripts/run-main-tests.mjs \
//     dist/main/main/supervisor/subagent-delegation-applier.test.js

import assert from 'node:assert/strict';
import { AgentSupervisor } from './index';
import type { ParsedHookEvent, HookTransport } from './index';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import { SUBAGENT_ORPHAN_MS } from '../../shared/constants';
import type { Agent, AgentStatus } from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

interface AuditRow { agentId: string; type: string; payload: string }

function patchDb(agentsMap: Map<string, Agent>, audit: AuditRow[]): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'updateAgentStatus', 'applyStatusTransition', 'updateAgentHookStatus',
    'updateAgentDashboardMcpStatus', 'updateAgentPid', 'getAgent',
    'addEvent', 'updateAgentLastOutput', 'getActiveAgents', 'getAllAgents',
    'getSupervisorAgent',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];

  db.updateAgentStatus = (id: string, status: AgentStatus) => {
    const a = agentsMap.get(id); if (a) a.status = status;
  };
  db.updateAgentHookStatus = (id: string, hookStatus: NonNullable<Agent['hookStatus']>, lastHookEventAt?: number) => {
    const a = agentsMap.get(id);
    if (a) { a.hookStatus = hookStatus; if (lastHookEventAt !== undefined) a.lastHookEventAt = lastHookEventAt; }
  };
  db.updateAgentDashboardMcpStatus = () => {};
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => agentsMap.get(id) ?? null;
  db.addEvent = (id: string, type: string, payload?: string | null) => {
    audit.push({ agentId: id, type, payload: payload ?? '' });
  };
  db.updateAgentLastOutput = () => {};
  db.getActiveAgents = () => Array.from(agentsMap.values());
  db.getAllAgents = () => Array.from(agentsMap.values());
  db.getSupervisorAgent = () => null;
  patchApplyStatusTransition(db as unknown as Record<string, unknown>);

  return () => { for (const k of keys) db[k] = orig[k]; };
}

interface Clock { now: () => number; advance: (ms: number) => void; }
function clock(start = 1_000_000): Clock {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

interface Env {
  supervisor: AgentSupervisor;
  agent: Agent;
  audit: AuditRow[];
  clock: Clock;
  apply: (event: Partial<ParsedHookEvent>, transport?: HookTransport) => string;
  tick: () => void;
  cleanup: () => void;
}

function makeEnv(status: AgentStatus = 'working'): Env {
  const agentsMap = new Map<string, Agent>();
  const audit: AuditRow[] = [];
  const restoreDb = patchDb(agentsMap, audit);
  const agent = makeAgent('w-1', { provider: 'claude', isWorker: true, status });
  agentsMap.set(agent.id, agent);
  const c = clock();
  const supervisor = new AgentSupervisor({ now: c.now });
  (supervisor as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
  const apply = (event: Partial<ParsedHookEvent>, transport: HookTransport = 'http'): string =>
    supervisor.applyHookStatusEvent(agent.id, { ts: c.now(), state: 'active', ...event } as ParsedHookEvent, transport);
  const tick = (): void => {
    const monitor = (supervisor as unknown as { monitor: { emit: (event: string) => boolean } }).monitor;
    monitor.emit('tick');
  };
  return { supervisor, agent, audit, clock: c, apply, tick, cleanup: () => restoreDb() };
}

function statusChanges(audit: AuditRow[]): Array<{ from: string; to: string; source: string }> {
  return audit.filter((r) => r.type === 'status_change').map((r) => JSON.parse(r.payload));
}
function idleChanges(audit: AuditRow[]): Array<{ from: string; to: string; source: string }> {
  return statusChanges(audit).filter((c) => c.to === 'idle');
}

const startRec = (sessionId: string, subagentId: string, ts: number): Partial<ParsedHookEvent> => ({
  state: 'active', kind: 'subagent-start', hookEventName: 'SubagentStart',
  source: 'hook-subagent-start', sessionId, subagentId, ts,
});
const stopRec = (sessionId: string, subagentId: string, ts: number): Partial<ParsedHookEvent> => ({
  state: 'active', kind: 'subagent-stop', hookEventName: 'SubagentStop',
  source: 'hook-subagent-stop', sessionId, subagentId, ts,
});
const parentStop = (ts: number): Partial<ParsedHookEvent> => ({
  state: 'idle', hookEventName: 'Stop', source: 'hook-stop', ts,
});

// ── D4: parent Stop suppression while children run (REACHABILITY seam) ──

test('parent Stop with a child in flight is suppressed; a second Stop ends the turn', () => {
  const env = makeEnv('working');
  try {
    assert.equal(env.apply(startRec('s', 'c1', 1001)), 'applied');
    assert.equal(env.apply(parentStop(1002)), 'applied');
    // Child still running → the first parent Stop was deferred, never idle.
    assert.equal(env.apply(stopRec('s', 'c1', 1003)), 'applied');
    assert.equal(
      idleChanges(env.audit).length, 0,
      'REACHABILITY:subagent-delegation-applier a parent Stop while a child is in flight must be suppressed (no idle flip, no idle supervisor event) and the final SubagentStop must not force idle',
    );
    assert.equal(env.agent.status, 'working', 'the parent is held working across the final SubagentStop');

    // Second parent Stop after reintegration, count === 0 → authoritative idle.
    assert.equal(env.apply(parentStop(1004)), 'applied');
    assert.equal(idleChanges(env.audit).length, 1, 'the second parent Stop ends the turn exactly once');
    assert.equal(env.agent.status, 'idle');
  } finally { env.cleanup(); }
});

test('a parent Stop with zero children in flight flips idle via forceIdleFromHook exactly as before', () => {
  const env = makeEnv('working');
  try {
    assert.equal(env.apply(parentStop(2001)), 'applied');
    const idle = idleChanges(env.audit);
    assert.equal(idle.length, 1, 'zero-children Stop is the ordinary authoritative turn end');
    assert.equal(idle[0].source, 'hook-stop');
    assert.equal(env.agent.status, 'idle');
  } finally { env.cleanup(); }
});

// ── D1: combination validation in the authoritative applier ──

test('invalid subagent bookkeeping combinations are rejected as invalid', () => {
  const env = makeEnv('working');
  try {
    // Right kind, wrong state.
    assert.equal(env.apply({ ...startRec('s', 'c', 3001), state: 'working' }), 'invalid');
    // Right kind + state, mismatched hookEventName.
    assert.equal(env.apply({ ...startRec('s', 'c', 3002), hookEventName: 'SubagentStop' }), 'invalid');
    // Unknown kind.
    assert.equal(env.apply({ state: 'active', kind: 'subagent-bogus', hookEventName: 'SubagentStart', sessionId: 's', subagentId: 'c', ts: 3003 }), 'invalid');
    // Delegation-shaped records may not omit kind or disguise a child id as an
    // ordinary SessionStart.
    assert.equal(env.apply({ state: 'active', hookEventName: 'SubagentStart', sessionId: 's', subagentId: 'c', ts: 3003 }), 'invalid');
    assert.equal(env.apply({ state: 'active', hookEventName: 'SessionStart', sessionId: 's', subagentId: 'c', ts: 3003 }), 'invalid');
    // Missing correlation field.
    assert.equal(env.apply({ ...startRec('s', '', 3004) }), 'invalid');
    assert.equal(env.apply({ ...startRec('', 'c', 3005) }), 'invalid');
    // None of the rejects registered a child.
    assert.equal((env.supervisor as unknown as { subagentDelegations: { inFlightCount: (id: string) => number } })
      .subagentDelegations.inFlightCount('w-1'), 0);
  } finally { env.cleanup(); }
});

// ── D2: bookkeeping never reads or advances the global watermark ──

test('delegation records never advance lastAppliedHookTs; a later ordinary event stays fresh', () => {
  const env = makeEnv('working');
  try {
    assert.equal(env.apply({ state: 'working', hookEventName: 'UserPromptSubmit', source: 'hook-start', sessionId: 's', ts: 100 }), 'applied');
    // A far-future delegation record must NOT push the ordinary-event watermark.
    assert.equal(env.apply(startRec('s', 'c', 9_000)), 'applied');
    // An ordinary event older than the delegation ts but newer than 100 still applies.
    assert.equal(
      env.apply({ state: 'working', hookEventName: 'UserPromptSubmit', source: 'hook-start', sessionId: 's', ts: 150 }),
      'applied',
      'bookkeeping ts must not stale a slower ordinary event',
    );
  } finally { env.cleanup(); }
});

test('a duplicate delegation record is suppressed and a stop-before-start start is stale', () => {
  const env = makeEnv('working');
  try {
    assert.equal(env.apply(startRec('s', 'c', 500)), 'applied');
    assert.equal(env.apply(startRec('s', 'c', 500)), 'duplicate');

    // Out-of-order: a stop lands first (tombstone), then its late start.
    assert.equal(env.apply(stopRec('s', 'd', 620)), 'applied');
    assert.equal(env.apply(startRec('s', 'd', 619)), 'stale');
    assert.equal(env.apply(startRec('s', 'd', 620)), 'stale', 'stop wins an equal-ts tie');
  } finally { env.cleanup(); }
});

// ── D5: zero-in-flight drain and running-child expiry on monitorTick ──

test('the zero-in-flight watchdog drains a deferred Stop after SUBAGENT_ORPHAN_MS and emits no orphan event', () => {
  const env = makeEnv('working');
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  try {
    env.apply(startRec('s', 'c', 1));
    env.apply(parentStop(2));
    env.apply(stopRec('s', 'c', 3));
    assert.equal(env.agent.status, 'working');

    env.tick(); // before the bound → no drain
    assert.equal(idleChanges(env.audit).length, 0);

    env.clock.advance(SUBAGENT_ORPHAN_MS);
    env.tick();
    const idle = idleChanges(env.audit);
    assert.equal(idle.length, 1, 'the deferred Stop drains to idle');
    assert.equal(idle[0].source, 'hook-stop');
    assert.equal(env.agent.status, 'idle');
    assert.equal(env.audit.filter((r) => r.type === 'subagent_orphaned').length, 0, 'no subagent_orphaned event type exists');
    assert.equal(warnings.filter((w) => w.includes('watchdog expiry')).length, 1, 'a pure zero-in-flight expiry warns');
    const state = (env.supervisor as unknown as { subagentDelegations: { getState: (id: string) => unknown } })
      .subagentDelegations.getState('w-1');
    assert.equal(state, undefined, 'the drained epoch is retired');
  } finally { console.warn = origWarn; env.cleanup(); }
});

test('a running child past SUBAGENT_ORPHAN_MS expires into the same drain with one warning', () => {
  const env = makeEnv('working');
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  try {
    env.apply(startRec('s', 'orphan', 1));
    env.apply(parentStop(2)); // deferred while the child still runs

    env.clock.advance(SUBAGENT_ORPHAN_MS);
    env.tick(); // expires the running child → zeroInFlightAt set this tick, no drain yet
    assert.equal(idleChanges(env.audit).length, 0);

    env.clock.advance(SUBAGENT_ORPHAN_MS);
    env.tick(); // now the drain fires
    assert.equal(idleChanges(env.audit).length, 1);
    assert.equal(env.agent.status, 'idle');
    const expiryWarns = warnings.filter((w) => w.includes('[subagent-delegation]'));
    assert.equal(expiryWarns.length, 1, `exactly one rate-limited expiry warning; got ${expiryWarns.length}`);
  } finally { console.warn = origWarn; env.cleanup(); }
});

test('a waiting parent keeps waiting, discards the deferred Stop, and never drains to idle', () => {
  const env = makeEnv('waiting');
  try {
    env.apply(startRec('s', 'c', 1));
    env.apply(parentStop(2));
    env.apply(stopRec('s', 'c', 3)); // final child stop while waiting
    env.clock.advance(SUBAGENT_ORPHAN_MS * 2);
    env.tick();
    assert.equal(idleChanges(env.audit).length, 0, 'waiting outranks an inferred idle');
    assert.equal(env.agent.status, 'waiting');
    const state = (env.supervisor as unknown as {
      subagentDelegations: { getState: (id: string) => { deferredParentStop?: unknown; zeroInFlightAt?: unknown } | undefined };
    }).subagentDelegations.getState('w-1');
    assert.equal(state?.deferredParentStop, undefined, 'the obsolete deferred Stop is discarded');
    assert.equal(state?.zeroInFlightAt, undefined);
  } finally { env.cleanup(); }
});

test('waiting preserves a deferred Stop; after an answer, a never-stopping child expires and drains through monitor tick', () => {
  const env = makeEnv('working');
  try {
    env.apply(startRec('s', 'orphan', 1));
    env.apply(parentStop(2));
    env.apply({ state: 'waiting', hookEventName: 'Notification', notificationType: 'permission_prompt', waitingExcerpt: 'Need input', ts: 3 });
    assert.equal(env.agent.status, 'waiting');
    const deleg = (env.supervisor as unknown as {
      subagentDelegations: { getState: (id: string) => { deferredParentStop?: unknown } | undefined };
    }).subagentDelegations;
    assert.notEqual(deleg.getState('w-1')?.deferredParentStop, undefined, 'waiting does not discard the deferred Stop early');

    env.apply({ state: 'working', hookEventName: 'UserPromptSubmit', source: 'hook-start', sessionId: 's', ts: 4 });
    assert.equal(env.agent.status, 'working');
    env.clock.advance(SUBAGENT_ORPHAN_MS);
    env.tick();
    assert.equal(idleChanges(env.audit).length, 0, 'child expiry first arms the zero-count watchdog');
    env.clock.advance(SUBAGENT_ORPHAN_MS);
    env.tick();
    assert.equal(env.agent.status, 'idle');
    assert.equal(idleChanges(env.audit).length, 1);
  } finally { env.cleanup(); }
});

test('a new child start clears zeroInFlightAt so a resumed delegating turn is not spuriously drained', () => {
  const env = makeEnv('working');
  try {
    env.apply(startRec('s', 'c1', 1));
    env.apply(parentStop(2));
    env.apply(stopRec('s', 'c1', 3)); // arms zeroInFlightAt
    env.apply(startRec('s', 'c2', 4)); // resumed delegation clears the fallback
    env.clock.advance(SUBAGENT_ORPHAN_MS * 2);
    env.tick();
    assert.equal(idleChanges(env.audit).length, 0, 'a resumed delegating turn must not drain');
    assert.equal(env.agent.status, 'working');
  } finally { env.cleanup(); }
});

test('a new child start keeps the deferred Stop so multiple orphaned children still drain the parent', () => {
  const env = makeEnv('working');
  try {
    env.apply(startRec('s', 'a', 1));
    env.apply(parentStop(2));
    env.apply(startRec('s', 'b', 3));
    env.clock.advance(SUBAGENT_ORPHAN_MS);
    env.tick();
    assert.equal(env.agent.status, 'working');
    env.clock.advance(SUBAGENT_ORPHAN_MS);
    env.tick();
    assert.equal(env.agent.status, 'idle', 'the original deferred Stop survives the second start and drains');
  } finally { env.cleanup(); }
});

// ── D3: same-session prompt keeps children; different-session rotates ──

test('a same-session UserPromptSubmit keeps live children; a different-session one rotates the epoch', () => {
  const env = makeEnv('working');
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  const inFlight = (): number => (env.supervisor as unknown as {
    subagentDelegations: { inFlightCount: (id: string) => number };
  }).subagentDelegations.inFlightCount('w-1');
  try {
    env.apply({ state: 'working', hookEventName: 'UserPromptSubmit', source: 'hook-start', sessionId: 's1', ts: 10 });
    env.apply(startRec('s1', 'c', 11));
    assert.equal(inFlight(), 1);
    // Reintegration prompt in the SAME session keeps the child (WP-1 R13/R23).
    env.apply({ state: 'working', hookEventName: 'UserPromptSubmit', source: 'hook-start', sessionId: 's1', ts: 12 });
    assert.equal(inFlight(), 1, 'a same-session prompt must not clear live children');
    // A different session id rotates the epoch and clears children.
    env.apply({ state: 'working', hookEventName: 'UserPromptSubmit', source: 'hook-start', sessionId: 's2', ts: 13 });
    assert.equal(inFlight(), 0, 'a different-session prompt rotates the epoch');
    assert.equal(warnings.filter((w) => w.includes('rotated parent epoch')).length, 1);
  } finally { console.warn = origWarn; env.cleanup(); }
});

test('a late old-session Start is ignored with a distinct disposition and warning', () => {
  const env = makeEnv('working');
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  try {
    env.apply({ state: 'working', hookEventName: 'UserPromptSubmit', source: 'hook-start', sessionId: 'old', ts: 10 });
    env.apply({ state: 'working', hookEventName: 'UserPromptSubmit', source: 'hook-start', sessionId: 'current', ts: 11 });
    assert.equal(env.apply(startRec('old', 'late', 12)), 'wrong-session');
    const deleg = (env.supervisor as unknown as { subagentDelegations: { inFlightCount: (id: string) => number } }).subagentDelegations;
    assert.equal(deleg.inFlightCount('w-1'), 0);
    assert.equal(warnings.filter((w) => w.includes('non-current session=old')).length, 1);
  } finally { console.warn = origWarn; env.cleanup(); }
});

// ── D8 hard gate: restart reconciliation cannot strand a working parent ──

test('restart reconciliation bounds a persisted-working parent: it drains within the watchdog and never before it', async () => {
  const env = makeEnv('working');
  try {
    // Execute AgentSupervisor.reconcile() itself. A fake live runner keeps this
    // focused on startup reconciliation without launching a subprocess.
    (env.supervisor as unknown as { windowsRunners: Map<string, unknown> })
      .windowsRunners.set('w-1', {});
    const deleg = (env.supervisor as unknown as {
      subagentDelegations: {
        getState: (id: string) => unknown;
      };
    }).subagentDelegations;
    assert.equal(deleg.getState('w-1'), undefined, 'fresh supervisor starts without process-local correlation');
    await env.supervisor.reconcile();
    assert.notEqual(deleg.getState('w-1'), undefined, 'production reconcile arms the bounded fallback');

    env.tick(); // before the bound → the parent is NOT prematurely drained
    assert.equal(idleChanges(env.audit).length, 0);
    assert.equal(env.agent.status, 'working');

    env.clock.advance(SUBAGENT_ORPHAN_MS);
    env.tick();
    const idle = idleChanges(env.audit);
    assert.equal(idle.length, 1, 'a post-restart working parent cannot be stranded: the watchdog drains it');
    assert.equal(idle[0].source, 'subagent-restart-reconciliation');
    assert.equal(env.agent.status, 'idle');
  } finally { env.cleanup(); }
});

test('restart reconciliation does not re-arm a parent that already has live correlation', async () => {
  const env = makeEnv('working');
  try {
    env.apply(startRec('s', 'c', 1)); // live child → tracker state exists
    (env.supervisor as unknown as { windowsRunners: Map<string, unknown> })
      .windowsRunners.set('w-1', {});
    const deleg = (env.supervisor as unknown as {
      subagentDelegations: { getState: (id: string) => unknown };
    }).subagentDelegations;
    const before = deleg.getState('w-1');
    await env.supervisor.reconcile();
    assert.equal(deleg.getState('w-1'), before, 'production reconcile preserves live correlation');
    env.clock.advance(SUBAGENT_ORPHAN_MS * 2);
    env.tick();
    assert.equal(idleChanges(env.audit).length, 0, 'a genuinely delegating parent must not be drained by reconciliation');
    assert.equal(env.agent.status, 'working');
  } finally { env.cleanup(); }
});

test('a live ordinary hook after restart disarms the reconciliation fallback', async () => {
  const env = makeEnv('working');
  try {
    (env.supervisor as unknown as { windowsRunners: Map<string, unknown> }).windowsRunners.set('w-1', {});
    const deleg = (env.supervisor as unknown as { subagentDelegations: { getState: (id: string) => unknown } }).subagentDelegations;
    await env.supervisor.reconcile();
    assert.notEqual(deleg.getState('w-1'), undefined);
    assert.equal(env.apply({ state: 'working', hookEventName: 'UserPromptSubmit', source: 'hook-start', sessionId: 'live', ts: 10 }), 'applied');
    env.clock.advance(SUBAGENT_ORPHAN_MS * 2);
    env.tick();
    assert.equal(env.agent.status, 'working');
    assert.equal(idleChanges(env.audit).length, 0, 'a live hook proves the future Stop seam is reachable');
  } finally { env.cleanup(); }
});

let passed = 0;
async function main(): Promise<void> {
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error(err instanceof Error ? err.stack ?? err.message : err);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed} passed, ${tests.length - passed} failed`);
}
void main();
