// plan_44ce2fa7 WP-4: Codex continuation successor staging through the real
// continuationRelaunch and boot-reconcile seams.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

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

let SqlJsCtor: new () => SqlJsDatabase;
class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;
  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new SqlJsCtor();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
    this.db = store;
  }
  pragma(): undefined { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          return stmt.step() ? stmt.getAsObject() : undefined;
        } finally { stmt.free(); }
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
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    };
  }
}

type AgentRow = {
  id: string;
  provider: string;
  isSupervisor: boolean;
  workingDirectory: string;
  resumeSessionId?: string | null;
  continuationGeneration?: number;
};
type Attempt = { id: string; generation: number };
type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  createAgent(input: Record<string, unknown>): AgentRow;
  getAgent(id: string): AgentRow | null;
  getActiveAgents(): AgentRow[];
  getAgentSessions(agentId: string): Array<{ generation: number; sessionId: string; endedAt: string | null }>;
  insertAgentSession(agentId: string, generation: number, sessionId: string, cwd: string, provider: string): void;
  updateAgentResumeSessionId(id: string, sessionId: string | null): void;
  updateAgentStatus(id: string, status: string): void;
  createContinuationHandoffAttempt(agentId: string, opts?: { reason?: string }): Attempt;
  freezeContinuationAttemptBinding(attemptId: string, binding: {
    planId: null; planItemId: null; source: 'continuation-carry';
  }): unknown;
  insertContinuationBrick(input: {
    agentId: string; handoffAttemptId: string; generation: number;
    note: string; noteSource: 'tool';
  }): string;
  closeContinuationHandoffAttempt(id: string, status: string): void;
  commitContinuationRelaunch(agentId: string, sessionId: string | null, generation: number, attemptId: string): void;
};
type Pending = {
  text: string;
  continuation?: { attemptId: string; correlationKey: string; successorSessionId: string | null };
};
type SupervisorLike = {
  continuationRelaunch(agentId: string, brick: Record<string, unknown>): Promise<void>;
  reconcile(): Promise<void>;
};

let db: DbModule;
let AgentSupervisorCtor: new () => SupervisorLike;
let workspaceId = '';
let workspacePath = '';
let sequence = 0;

function createAgent(provider: 'claude' | 'codex'): AgentRow {
  sequence += 1;
  return db.createAgent({
    workspaceId,
    title: `${provider}-successor-${sequence}`,
    roleDescription: '',
    workingDirectory: workspacePath,
    command: provider === 'codex' ? 'codex' : 'claude --dangerously-skip-permissions',
    provider,
    isSupervisor: true,
    tmuxSessionName: null,
    autoRestartEnabled: false,
    logPath: path.join(workspacePath, `${provider}-${sequence}.log`),
  });
}

function privateSupervisor(supervisor: SupervisorLike): Record<string, unknown> {
  return supervisor as unknown as Record<string, unknown>;
}

function pendingMap(supervisor: SupervisorLike): Map<string, Pending> {
  return privateSupervisor(supervisor).pendingInitialPrompts as Map<string, Pending>;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function assertCodexPayload(
  pending: Pending | undefined,
  attempt: Attempt,
  note: string,
): void {
  assert.ok(pending, 'the Codex successor has one staged initial prompt');
  const generation = `CONTINUATION #${attempt.generation}`;
  const memory = '[MEMORY INDEX FOR CODEX SUCCESSOR]';
  const kickoff = '[DASHBOARD] Continuation resume';
  const generationAt = pending!.text.indexOf(generation);
  const noteAt = pending!.text.indexOf(note);
  const memoryAt = pending!.text.indexOf(memory);
  const kickoffAt = pending!.text.indexOf(kickoff);
  assert.ok(generationAt >= 0, 'the real brick renderer uses the successor generation');
  assert.ok(generationAt < noteAt && noteAt < memoryAt && memoryAt < kickoffAt,
    'Codex stages brick/note, then memory index, then kickoff');
  assert.equal(occurrences(pending!.text, note), 1, 'note injected exactly once');
  assert.equal(occurrences(pending!.text, memory), 1, 'memory injected exactly once');
  assert.equal(occurrences(pending!.text, kickoff), 1, 'kickoff injected exactly once');
  assert.deepEqual(pending!.continuation, {
    attemptId: attempt.id,
    correlationKey: attempt.id,
    successorSessionId: null,
  });
}

function neutralizeSupervisor(supervisor: SupervisorLike): Record<string, unknown> {
  const mutable = privateSupervisor(supervisor);
  mutable.writeAgentRegistry = () => {};
  mutable.resolveWslGatewayIp = () => '10.0.0.42';
  mutable.retireStaleRootMcpConfig = () => {};
  mutable.computeSupervisorMemoryInjectText = () => '[MEMORY INDEX FOR CODEX SUCCESSOR]';
  return mutable;
}

test('post-commit relaunch stages one Codex note -> memory -> kickoff payload at successor generation', async () => {
  const agent = createAgent('codex');
  const attempt = db.createContinuationHandoffAttempt(agent.id, { reason: 'context-pressure' });
  db.freezeContinuationAttemptBinding(attempt.id, {
    planId: null, planItemId: null, source: 'continuation-carry',
  });
  const note = 'CODEX RELAUNCH NOTE';
  const noteId = db.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: attempt.id, generation: attempt.generation,
    note, noteSource: 'tool',
  });
  db.closeContinuationHandoffAttempt(attempt.id, 'committed');

  const supervisor = new AgentSupervisorCtor();
  const mutable = neutralizeSupervisor(supervisor);
  const tailCalls: unknown[][] = [];
  mutable.stopAgentLocked = async () => {};
  mutable.continuationLaunchTail = (...args: unknown[]) => { tailCalls.push(args); };
  (mutable.monitor as Record<string, unknown>).forgetAgent = () => {};
  (mutable.sessionLogReader as Record<string, unknown>).rebindAgent = () => {};

  await supervisor.continuationRelaunch(agent.id, {
    handoffAttemptId: attempt.id,
    noteId,
    reason: 'context-pressure',
    note,
    workspaceId,
  });

  const after = db.getAgent(agent.id)!;
  const slots = pendingMap(supervisor);
  assert.equal(after.resumeSessionId, null, 'Codex stays unbound until its real rollout id is discovered');
  assert.deepEqual(db.getAgentSessions(agent.id), [], 'the fake continuation correlation id never enters lineage');
  assert.deepEqual(tailCalls, [[agent.id, attempt.id, attempt.id, null, null]],
    'the attempt id correlates launch work while successorSessionId stays null');
  assert.equal(slots.size, 1, 'the relaunch path creates exactly one pending slot');
  assertCodexPayload(slots.get(agent.id), attempt, note);
  db.updateAgentStatus(agent.id, 'done');
});

test('boot reconcile stages the same payload and fresh-launches an unbound Codex successor', async () => {
  const agent = createAgent('codex');
  const attempt = db.createContinuationHandoffAttempt(agent.id, { reason: 'electron-death' });
  db.freezeContinuationAttemptBinding(attempt.id, {
    planId: null, planItemId: null, source: 'continuation-carry',
  });
  const note = 'CODEX RECONCILE NOTE';
  db.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: attempt.id, generation: attempt.generation,
    note, noteSource: 'tool',
  });
  db.closeContinuationHandoffAttempt(attempt.id, 'committed');
  db.commitContinuationRelaunch(agent.id, null, attempt.generation, attempt.id);

  const supervisor = new AgentSupervisorCtor();
  const mutable = neutralizeSupervisor(supervisor);
  const tailCalls: Array<[string, string]> = [];
  const launches: Array<{ resume: unknown; freshSession: unknown }> = [];
  const sessionLookups: Array<[string, string, string]> = [];
  mutable.continuationLaunchTail = (id: string, sessionId: string) => tailCalls.push([id, sessionId]);
  mutable.launchWindowsAgent = async (...args: unknown[]) => {
    launches.push({ resume: args[1], freshSession: args[5] });
  };
  (mutable.sessionLogReader as Record<string, unknown>).sessionFileExists =
    (provider: string, cwd: string, sessionId: string) => {
      sessionLookups.push([provider, cwd, sessionId]);
      return false;
    };
  await supervisor.reconcile();

  assert.deepEqual(sessionLookups, [], 'an unbound Codex continuation never probes a fabricated session id');
  assert.deepEqual(tailCalls, [], 'Codex continuation is not re-driven with a fake provider session id');
  assert.deepEqual(launches, [{ resume: false, freshSession: true }],
    'boot reconcile falls back to a fresh Codex launch that re-runs discovery');
  assert.equal(db.getAgent(agent.id)!.resumeSessionId, null);
  assert.deepEqual(db.getAgentSessions(agent.id), []);
  const slots = pendingMap(supervisor);
  assert.equal(slots.size, 1, 'the reconcile path creates exactly one pending slot');
  assertCodexPayload(slots.get(agent.id), attempt, note);
});

test('auto-restart never runs codex resume for a missing rollout and clears the fake pointer', async () => {
  const agent = createAgent('codex');
  const fakeId = '11111111-2222-4333-8444-555555555555';
  db.updateAgentResumeSessionId(agent.id, fakeId);
  const supervisor = new AgentSupervisorCtor();
  const mutable = neutralizeSupervisor(supervisor);
  const launches: Array<{ resume: unknown; freshSession: unknown; persistedSid: string | null | undefined }> = [];
  (mutable.sessionLogReader as Record<string, unknown>).sessionFileExists = () => false;
  (mutable.sessionLogReader as Record<string, unknown>).rebindAgent = () => {};
  mutable.launchWindowsAgent = async (...args: unknown[]) => {
    launches.push({
      resume: args[1], freshSession: args[5],
      persistedSid: (args[0] as AgentRow).resumeSessionId,
    });
  };

  await (mutable.autoRestartLocked as (a: AgentRow) => Promise<void>).call(
    supervisor, db.getAgent(agent.id)!,
  );

  assert.deepEqual(launches, [{ resume: false, freshSession: true, persistedSid: null }]);
  assert.equal(db.getAgent(agent.id)!.resumeSessionId, null);
});

test('real hook bind repairs a fake id and inserts the real rollout at the current generation', () => {
  const agent = createAgent('codex');
  const fakeId = '11111111-2222-4333-8444-555555555555';
  const realId = '0199a000-0000-7000-8000-000000000009';
  db.insertAgentSession(agent.id, 0, fakeId, workspacePath, 'codex');
  db.updateAgentResumeSessionId(agent.id, fakeId);
  const supervisor = new AgentSupervisorCtor();
  const mutable = neutralizeSupervisor(supervisor);
  (mutable.sessionLogReader as Record<string, unknown>).sessionFileExists = () => false;
  (mutable.sessionLogReader as Record<string, unknown>).rebindAgent = () => {};

  const decision = (supervisor as unknown as {
    bindCodexSessionFromHook(agentId: string, sessionId: string): unknown;
  }).bindCodexSessionFromHook(agent.id, realId);

  assert.deepEqual(decision, { action: 'bind', sessionId: realId });
  assert.equal(db.getAgent(agent.id)!.resumeSessionId, realId);
  const rows = db.getAgentSessions(agent.id);
  assert.deepEqual(rows.map((r) => [r.sessionId, r.generation]), [[fakeId, 0], [realId, 0]]);
  assert.ok(rows[0].endedAt, 'the replaced fake lineage row is closed');
  assert.equal(rows[1].endedAt, null, 'the real rollout is the live lineage row');
});

test('shared helper keeps Claude kickoff-only and null-guards a vanished agent', () => {
  const agent = createAgent('claude');
  const supervisor = new AgentSupervisorCtor();
  const mutable = neutralizeSupervisor(supervisor);
  const stage = mutable.stageContinuationSuccessor as (
    agentId: string, attemptId: string, correlationKey: string,
    successorSessionId: string | null, dispatch: unknown,
  ) => void;
  const dispatch = { planId: null, planItemId: null, source: 'continuation-carry' };
  stage.call(supervisor, agent.id, 'claude-attempt', 'claude-session', 'claude-session', dispatch);
  const staged = pendingMap(supervisor).get(agent.id);
  assert.ok(staged);
  assert.match(staged!.text, /note is in your system prompt/);
  assert.doesNotMatch(staged!.text, /MEMORY INDEX FOR CODEX SUCCESSOR/);
  assert.equal(occurrences(staged!.text, '[DASHBOARD] Continuation resume'), 1);

  const before = pendingMap(supervisor).size;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    stage.call(supervisor, 'missing-agent', 'missing-attempt', 'missing-session', 'missing-session', dispatch);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(pendingMap(supervisor).size, before, 'missing-agent guard stages nothing');
});

void (async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-codex-appdata-'));
  const wsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-codex-ws-'));
  process.env.APPDATA = appData;
  process.env.DASHBOARD_RECONCILE_STAGGER_MS = '1';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    SqlJsCtor = SQL.Database;
    const sqlitePath = require.resolve('better-sqlite3');
    require.cache[sqlitePath] = {
      id: sqlitePath,
      filename: sqlitePath,
      loaded: true,
      exports: FakeBetterSqlite,
    } as unknown as NodeJS.Module;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    db = require('../database') as DbModule;
    db.initDatabase();
    workspacePath = wsPath;
    workspaceId = db.createWorkspace({ title: 'codex-continuation', path: wsPath, pathType: 'windows' }).id;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    AgentSupervisorCtor = (require('./index') as { AgentSupervisor: new () => SupervisorLike }).AgentSupervisor;

    let passed = 0;
    let failed = 0;
    for (const entry of tests) {
      try {
        await entry.run();
        console.log(`  ok  ${entry.name}`);
        passed += 1;
      } catch (error) {
        console.error(`  FAIL ${entry.name}`);
        console.error(error instanceof Error ? error.stack || error.message : error);
        failed += 1;
      }
    }
    console.log(`REACHABILITY:continuation-codex-successor ${failed === 0 ? 'PASS' : 'FAIL'}`);
    console.log(`${passed} passed, ${failed} failed`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    try { fs.rmSync(appData, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(wsPath, { recursive: true, force: true }); } catch { /* best effort */ }
  }
})();
