import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BASELINE_JSON,
  BROWSER_OPENED,
  CHECK_IDS,
  COMMENT_ACK,
  COMMENT_READY,
  CONTROL_JSON,
  DONE,
  evaluateChecks,
  exitCodeFor,
  MONITOR_STDERR_LOG,
  MONITOR_STDOUT_LOG,
  READY,
  REPORT_JSON,
  REPORT_TXT,
  runMonitor,
  SENTINELS,
} from './monitor.mjs';

const RUN_ID = 'accept-abc123';
const WORKSPACE_ID = 'workspace-1';
const SUPERVISOR_ID = 'supervisor-1';
const WORKER_ID = 'worker-claude-1';
const PLAN_FILE = `C:/fixture/.lares/plans/${RUN_ID}/plan.json`;

function manifest() {
  return {
    runId: RUN_ID,
    repoRoot: 'C:/fixture',
    proposalArtifactId: 'prop_1234abcd',
    proposalTitle: `VM acceptance run ${RUN_ID}`,
    intentId: 'int_1234abcd',
    planArtifactId: 'plan_1234abcd',
    seededBug: { file: 'src/index.js' },
    trackedBytes: 9001,
  };
}

function passingEvidence() {
  const data = manifest();
  return {
    manifest: data,
    workspaceId: WORKSPACE_ID,
    supervisorId: SUPERVISOR_ID,
    timedOut: false,
    disk: {
      proposal: { exists: true, path: `C:/fixture/.lares/proposals/${RUN_ID}.md`, contents: `${RUN_ID} ${data.proposalArtifactId}` },
      plan: { exists: true, path: PLAN_FILE, title: `VM acceptance ${RUN_ID}`, contents: data.planArtifactId },
      deliberations: [{ exists: true, path: `C:/fixture/.lares/plans/${RUN_ID}/deliberations/${RUN_ID}.md`, contents: RUN_ID }],
    },
    http: {
      plans: [{ artifact_id: data.planArtifactId, title: `VM acceptance ${RUN_ID}`, path: PLAN_FILE }],
      activity: [{ agent_id: WORKER_ID, file_path: 'src/index.js', operation: 'write' }],
    },
    db: {
      proposals: [{ id: 'proposal-row', workspace_id: WORKSPACE_ID, artifact_id: data.proposalArtifactId, title: `VM acceptance ${RUN_ID}`, path: `${RUN_ID}.md` }],
      plans: [{ id: 'plan-row', workspace_id: WORKSPACE_ID, artifact_id: data.planArtifactId, path: PLAN_FILE }],
      orchestrations: [{ run_id: `orch-${RUN_ID}`, workspace_id: WORKSPACE_ID, plan_artifact_id: data.planArtifactId, planning_intent_id: data.intentId, status: 'complete' }],
      agents: [{ id: WORKER_ID, workspace_id: WORKSPACE_ID, provider: 'claude', is_worker: 1, title: `worker ${RUN_ID}`, owner_agent_id: SUPERVISOR_ID, is_supervised: 1 }],
      events: [
        { id: 1, agent_id: WORKER_ID, event_type: 'agent-idle' },
        { id: 2, agent_id: WORKER_ID, event_type: 'agent-idle' },
      ],
      turn_records: [
        { id: 'turn-1', workspace_id: WORKSPACE_ID, agent_id: WORKER_ID, turn_seq: 41, session_id: 'session-1', status: 'accepted', before_ready: 1, after_ready: 1, before_oid: 'a'.repeat(40), after_oid: 'b'.repeat(40), before_ref: 'refs/heads/main', after_ref: 'refs/heads/main' },
        { id: 'turn-2', workspace_id: WORKSPACE_ID, agent_id: WORKER_ID, turn_seq: 42, session_id: 'session-2', status: 'accepted' },
      ],
      capture_attempts: [{ id: 'capture-1', workspace_id: WORKSPACE_ID, agent_id: WORKER_ID, turn_id: 'turn-1', status: 'completed' }],
      selection_comments: [{ id: 'comment-1', workspace_id: WORKSPACE_ID, body: `please inspect ${RUN_ID}`, file_path: PLAN_FILE }],
      browser_history: [],
    },
    fixtureHits: [{ timestamp: 200, path: `/fixture/${RUN_ID}`, userAgent: 'Mozilla/5.0 Chrome/140.0 Electron/39.0' }],
    sentinels: { browserOpenedAt: 100 },
    gitDiff: ['M\tsrc/index.js'],
  };
}

const failMutations = [
  (value) => { value.disk.proposal.exists = false; },
  (value) => { value.http.plans = []; },
  (value) => { value.db.orchestrations[0].status = 'running'; },
  (value) => { value.http.activity = []; },
  (value) => { value.fixtureHits[0].userAgent = 'curl/8'; },
  (value) => { value.db.agents[0].owner_agent_id = 'somebody-else'; },
  (value) => { value.db.selection_comments = []; },
  (value) => { value.gitDiff.push(`M\tgenerated/${RUN_ID}.txt`, 'M\tassets/big.bin', 'M\tnode_modules/pkg/index.js'); },
];

for (let index = 0; index < CHECK_IDS.length; index += 1) {
  test(`check ${index + 1} ${CHECK_IDS[index]} has PASS and FAIL branches`, () => {
    const evidence = passingEvidence();
    assert.equal(evaluateChecks(evidence)[index].status, 'PASS');
    failMutations[index](evidence);
    assert.equal(evaluateChecks(evidence)[index].status, 'FAIL', `REACHABILITY:wp2-vm-monitor-checkpoint-predicate check ${index + 1}`);
  });
}

test('checkpoint FAIL branch rejects each ignored prefix and explicit sentinel independently', () => {
  for (const forbiddenPath of [`generated/${RUN_ID}.txt`, 'generated/other.txt', 'node_modules/pkg/index.js', 'assets/big.bin', 'assets/other.bin']) {
    const evidence = passingEvidence();
    evidence.gitDiff.push(`M\t${forbiddenPath}`);
    assert.equal(evaluateChecks(evidence)[7].status, 'FAIL', forbiddenPath);
  }
});

test('comment check resolves the canonical logical plan-document key', () => {
  const evidence = passingEvidence();
  const payload = Buffer.from(JSON.stringify({
    doc_rel_path_within_folder: 'plan.md',
    plan_artifact_id: evidence.manifest.planArtifactId,
  }), 'utf8').toString('base64url');
  evidence.db.selection_comments[0].file_path = `lares-plan-doc:v1:${payload}`;
  assert.equal(evaluateChecks(evidence)[6].status, 'PASS');
  evidence.db.selection_comments[0].file_path = 'lares-plan-doc:v1:not-valid-base64';
  assert.equal(evaluateChecks(evidence)[6].status, 'FAIL');
});

test('activity check reads the real projected /api/activity page shape', () => {
  const evidence = passingEvidence();
  evidence.http.activity = {
    workspaceId: WORKSPACE_ID,
    items: [{
      kind: 'file-group',
      repoPath: 'src/index.js',
      members: [{ kind: 'turn', agentId: WORKER_ID, witnessedPaths: [{ repoPath: 'src/index.js' }] }],
    }],
  };
  assert.equal(evaluateChecks(evidence)[3].status, 'PASS');
  evidence.http.activity.items[0].members[0].agentId = 'unrelated-worker';
  evidence.http.activity.items[0].repoPath = 'src/other.js';
  assert.equal(evaluateChecks(evidence)[3].status, 'FAIL');
});

test('timeout turns every otherwise missing required check into INCOMPLETE', () => {
  const evidence = passingEvidence();
  evidence.timedOut = true;
  for (const mutate of failMutations) mutate(evidence);
  const results = evaluateChecks(evidence);
  assert.equal(results.length, 8);
  assert.equal(results.every((result) => result.status === 'INCOMPLETE'), true);
});

test('exit-state matrix returns zero only for all required PASS', () => {
  const allPass = evaluateChecks(passingEvidence());
  assert.equal(exitCodeFor(allPass), 0);
  for (const status of ['FAIL', 'INCOMPLETE']) {
    const changed = allPass.map((result, index) => index === 3 ? { ...result, status } : result);
    assert.equal(exitCodeFor(changed), 1, status);
  }
  assert.equal(exitCodeFor(allPass.slice(1)), 1);
});

function tempRun(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function goodEnv(token = 'literal-secret-token-DO-NOT-LEAK') {
  return {
    AGENT_DASHBOARD_API_HOST: '127.0.0.1',
    AGENT_DASHBOARD_API_PORT: '43123',
    AGENT_DASHBOARD_API_TOKEN: token,
    AGENT_DASHBOARD_WORKSPACE_ID: WORKSPACE_ID,
    AGENT_DASHBOARD_SELF_ID: SUPERVISOR_ID,
  };
}

function monitorFakes(evidence = passingEvidence()) {
  return {
    httpClient: {
      async get(route) {
        if (route === '/api/agents') return evidence.db.agents;
        if (route === '/api/plans') return evidence.http.plans;
        if (route === '/api/activity') return evidence.http.activity;
        return [];
      },
    },
    dbReader: {
      baseline: () => Object.fromEntries(Object.keys(evidence.db).map((table) => [table, { primaryKey: 'id', identities: [] }])),
      deltas: () => evidence.db,
      close() {},
    },
    gitRunner: { preflight() {}, diff: () => evidence.gitDiff },
    fixtureFactory: async () => ({
      url: `http://127.0.0.1:49152/fixture/${RUN_ID}`,
      hits: evidence.fixtureHits,
      server: { close() {} },
    }),
    diskReader: () => evidence.disk,
  };
}

test('watch lifecycle atomically publishes control before READY and reports after DONE', async (t) => {
  const runDir = tempRun(t, 'lares-monitor-lifecycle-');
  fs.writeFileSync(path.join(runDir, DONE), '');
  fs.writeFileSync(path.join(runDir, BROWSER_OPENED), '');
  const operations = [];
  const wrappedFs = {
    ...fs,
    writeFileSync(file, ...args) { operations.push(['write', path.basename(file)]); return fs.writeFileSync(file, ...args); },
    renameSync(from, to) { operations.push(['rename', path.basename(from), path.basename(to)]); return fs.renameSync(from, to); },
  };
  const evidence = passingEvidence();
  evidence.fixtureHits[0].timestamp = Date.now() + 10_000;
  const report = await runMonitor({ runDir, manifest: manifest(), manifestPath: path.join(runDir, 'MANIFEST.json'), timeoutMs: 1000, env: goodEnv() }, { ...monitorFakes(evidence), io: { fs: wrappedFs } });
  assert.equal(report.exitCode, 0);
  const renameControl = operations.findIndex((entry) => entry[0] === 'rename' && entry[2] === CONTROL_JSON);
  const writeReady = operations.findIndex((entry) => entry[0] === 'write' && entry[1] === READY);
  assert.ok(renameControl >= 0 && renameControl < writeReady, JSON.stringify(operations));
  assert.equal(fs.existsSync(path.join(runDir, `${CONTROL_JSON}.tmp`)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, CONTROL_JSON), 'utf8')).pid, process.pid);
  assert.equal(fs.existsSync(path.join(runDir, BASELINE_JSON)), true);
  assert.equal(fs.existsSync(path.join(runDir, REPORT_JSON)), true);
  assert.equal(fs.readFileSync(path.join(runDir, REPORT_TXT), 'utf8').split(/\r?\n/).filter((line) => /^(PASS|FAIL|INCOMPLETE)/.test(line)).length, 8);
});

test('missing endpoint, token, workspace, or self environment is a FAIL preflight and never creates READY', async (t) => {
  for (const key of ['AGENT_DASHBOARD_API_HOST', 'AGENT_DASHBOARD_API_PORT', 'AGENT_DASHBOARD_API_TOKEN', 'AGENT_DASHBOARD_WORKSPACE_ID', 'AGENT_DASHBOARD_SELF_ID']) {
    const runDir = tempRun(t, `lares-monitor-env-${key}-`);
    const env = goodEnv();
    delete env[key];
    const report = await runMonitor({ runDir, manifest: manifest(), timeoutMs: 1, env });
    assert.equal(report.preflight[0].status, 'FAIL', key);
    assert.equal(report.checks.some((result) => result.status === 'FAIL'), true);
    assert.equal(fs.existsSync(path.join(runDir, READY)), false);
  }
});

test('unreachable GET /api/agents is a FAIL preflight', async (t) => {
  const runDir = tempRun(t, 'lares-monitor-http-');
  const report = await runMonitor({ runDir, manifest: manifest(), timeoutMs: 1, env: goodEnv() }, {
    httpClient: { async get() { throw new Error('connection refused'); } },
  });
  assert.equal(report.preflight.at(-1).status, 'FAIL');
  assert.match(report.preflight.at(-1).detail, /connection refused/);
});

test('unopenable read-only SQLite is a FAIL preflight', async (t) => {
  const runDir = tempRun(t, 'lares-monitor-db-');
  const report = await runMonitor({ runDir, manifest: manifest(), timeoutMs: 1, env: goodEnv() }, {
    httpClient: { async get() { return []; } },
    createDbReader() { throw new Error('readonly open failed'); },
  });
  assert.equal(report.preflight.at(-1).status, 'FAIL');
  assert.match(report.preflight.at(-1).detail, /readonly open failed/);
});

test('unresolvable Git is a FAIL preflight', async (t) => {
  const runDir = tempRun(t, 'lares-monitor-git-');
  const fakes = monitorFakes();
  fakes.gitRunner.preflight = () => { throw new Error('git unavailable'); };
  const report = await runMonitor({ runDir, manifest: manifest(), timeoutMs: 1, env: goodEnv() }, fakes);
  assert.equal(report.preflight.at(-1).status, 'FAIL');
  assert.match(report.preflight.at(-1).detail, /git unavailable/);
});

test('watch timeout writes INCOMPLETE required lines and exits nonzero', async (t) => {
  const runDir = tempRun(t, 'lares-monitor-timeout-');
  let now = 1_000;
  const empty = passingEvidence();
  for (const mutate of failMutations) mutate(empty);
  const report = await runMonitor({ runDir, manifest: manifest(), timeoutMs: 10, env: goodEnv() }, {
    ...monitorFakes(empty),
    clock: { now: () => now, sleep: async () => { now += 11; } },
  });
  assert.equal(report.timedOut, true);
  assert.equal(report.checks.every((result) => result.status === 'INCOMPLETE'), true);
  assert.equal(report.exitCode, 1);
});

test('literal capability token never appears in any persisted or redirected monitor artifact', async (t) => {
  const token = 'literal-secret-token-DO-NOT-LEAK-5f764b';
  const runDir = tempRun(t, 'lares-monitor-secret-');
  fs.writeFileSync(path.join(runDir, DONE), '');
  fs.writeFileSync(path.join(runDir, BROWSER_OPENED), '');
  fs.writeFileSync(path.join(runDir, MONITOR_STDOUT_LOG), 'monitor started\n');
  fs.writeFileSync(path.join(runDir, MONITOR_STDERR_LOG), '');
  const evidence = passingEvidence();
  evidence.fixtureHits[0].timestamp = Date.now() + 10_000;
  await runMonitor({ runDir, manifest: manifest(), manifestPath: path.join(runDir, 'MANIFEST.json'), timeoutMs: 100, env: goodEnv(token) }, monitorFakes(evidence));
  for (const name of [CONTROL_JSON, BASELINE_JSON, REPORT_JSON, REPORT_TXT, MONITOR_STDOUT_LOG, MONITOR_STDERR_LOG]) {
    assert.equal(fs.readFileSync(path.join(runDir, name), 'utf8').includes(token), false, name);
  }
});

test('sentinel exports are stable and complete for the WP-3 consumer', () => {
  assert.deepEqual(SENTINELS, {
    READY, BROWSER_OPENED, COMMENT_READY, COMMENT_ACK, DONE,
    CONTROL: CONTROL_JSON, BASELINE: BASELINE_JSON, REPORT_JSON,
    REPORT_TEXT: REPORT_TXT, STDOUT_LOG: MONITOR_STDOUT_LOG, STDERR_LOG: MONITOR_STDERR_LOG,
  });
  assert.equal(CHECK_IDS.length, 8);
});
