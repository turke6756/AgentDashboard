#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export const SENTINELS = Object.freeze({
  READY: 'READY',
  BROWSER_OPENED: 'BROWSER_OPENED',
  COMMENT_READY: 'COMMENT_READY',
  COMMENT_ACK: 'COMMENT_ACK',
  DONE: 'DONE',
  CONTROL: 'control.json',
  BASELINE: 'baseline.json',
  REPORT_JSON: 'report.json',
  REPORT_TEXT: 'report.txt',
  STDOUT_LOG: 'monitor.stdout.log',
  STDERR_LOG: 'monitor.stderr.log',
});

export const READY = SENTINELS.READY;
export const BROWSER_OPENED = SENTINELS.BROWSER_OPENED;
export const COMMENT_READY = SENTINELS.COMMENT_READY;
export const COMMENT_ACK = SENTINELS.COMMENT_ACK;
export const DONE = SENTINELS.DONE;
export const CONTROL_JSON = SENTINELS.CONTROL;
export const BASELINE_JSON = SENTINELS.BASELINE;
export const REPORT_JSON = SENTINELS.REPORT_JSON;
export const REPORT_TXT = SENTINELS.REPORT_TEXT;
export const MONITOR_STDOUT_LOG = SENTINELS.STDOUT_LOG;
export const MONITOR_STDERR_LOG = SENTINELS.STDERR_LOG;

export const CHECK_IDS = Object.freeze([
  'proposal-creation',
  'plan-promotion',
  'groupthink',
  'activity-ingestion',
  'built-in-browser',
  'worker-supervision',
  'comment-authorization',
  'checkpoint-scope',
]);

export const CHECK_NAMES = Object.freeze({
  'proposal-creation': 'Proposal creation',
  'plan-promotion': 'Plan promotion',
  groupthink: 'GroupThink',
  'activity-ingestion': 'Activity ingestion',
  'built-in-browser': 'Built-in browser',
  'worker-supervision': 'Worker supervision',
  'comment-authorization': 'Comment authorization',
  'checkpoint-scope': 'Checkpoint scope',
});

export const TABLE_PRIMARY_KEYS = Object.freeze({
  proposals: 'id',
  plans: 'id',
  plan_events: 'id',
  orchestrations: 'run_id',
  agents: 'id',
  events: 'id',
  turn_records: 'id',
  capture_attempts: 'id',
  selection_comments: 'id',
  selection_comment_replies: 'id',
  file_activities: 'id',
  browser_history: 'id',
});

const TERMINAL_TURN_STATUSES = new Set(['accepted', 'crashed', 'complete', 'completed', 'failed', 'cancelled', 'canceled', 'interrupted', 'timeout', 'timed_out']);
const SUCCESS_CAPTURE_STATUSES = new Set(['completed']);
const WS_CONTROL_PORT = 4545;
const JUPYTER_CONTROL_PORT_RANGE = Object.freeze([18888, 18938]);

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['items', 'data', 'agents', 'plans', 'orchestrations', 'activities', 'activity']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function includesRunId(value, runId) {
  return typeof value === 'string' && value.includes(runId);
}

function normalizePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function logicalPlanArtifactId(filePath) {
  const prefix = 'lares-plan-doc:v1:';
  if (typeof filePath !== 'string' || !filePath.startsWith(prefix)) return '';
  try {
    const payload = JSON.parse(Buffer.from(filePath.slice(prefix.length), 'base64url').toString('utf8'));
    return typeof payload.plan_artifact_id === 'string' ? payload.plan_artifact_id : '';
  } catch {
    return '';
  }
}

function terminal(status) {
  return TERMINAL_TURN_STATUSES.has(String(status ?? '').toLowerCase());
}

function successfulCapture(row) {
  return SUCCESS_CAPTURE_STATUSES.has(String(row?.status ?? '').toLowerCase());
}

function activityHasEdit(value, workerIds, trackedEdit) {
  if (Array.isArray(value)) return value.some((entry) => activityHasEdit(entry, workerIds, trackedEdit));
  if (!value || typeof value !== 'object') return false;
  const agentId = value.agent_id ?? value.agentId;
  const directPath = normalizePath(value.file_path ?? value.filePath ?? value.repoPath);
  if (agentId && workerIds.has(agentId) && directPath.endsWith(trackedEdit)) return true;
  const pathList = [...asArray(value.paths), ...asArray(value.witnessedPaths)];
  if (agentId && workerIds.has(agentId) && pathList.some((entry) => normalizePath(entry.repoPath ?? entry.path ?? entry).endsWith(trackedEdit))) return true;
  return [...asArray(value.items), ...asArray(value.members), ...asArray(value.ancillary?.toolUnjoined)]
    .some((entry) => activityHasEdit(entry, workerIds, trackedEdit));
}

function pass(id, detail, extra = {}) {
  return { id, name: CHECK_NAMES[id], status: 'PASS', detail, ...extra };
}

function fail(id, detail, extra = {}) {
  return { id, name: CHECK_NAMES[id], status: 'FAIL', detail, ...extra };
}

function incomplete(id, detail) {
  return { id, name: CHECK_NAMES[id], status: 'INCOMPLETE', detail };
}

/** Pure check evaluator. All filesystem, HTTP, SQLite, Git, fixture, and clock I/O
 * is represented by the supplied evidence object. */
export function evaluateChecks(evidence) {
  const manifest = evidence.manifest ?? {};
  const runId = String(manifest.runId ?? evidence.runId ?? '');
  const workspaceId = String(evidence.workspaceId ?? '');
  const supervisorId = String(evidence.supervisorId ?? '');
  const trackedEdit = normalizePath(manifest.seededBug?.file ?? 'src/index.js');
  const db = evidence.db ?? {};
  const httpEvidence = evidence.http ?? {};
  const disk = evidence.disk ?? {};
  const timedOut = evidence.timedOut === true;
  const missing = (id, detail) => timedOut ? incomplete(id, detail) : fail(id, detail);
  const results = [];

  const proposalRow = asArray(db.proposals).find((row) =>
    row.workspace_id === workspaceId
      && row.artifact_id === manifest.proposalArtifactId
      && (includesRunId(row.title, runId) || includesRunId(row.path, runId)),
  );
  if (proposalRow && disk.proposal?.exists && includesRunId(`${disk.proposal.path ?? ''} ${disk.proposal.contents ?? ''}`, runId)) {
    results.push(pass(CHECK_IDS[0], `artifact ${manifest.proposalArtifactId} exists on disk and in proposals`));
  } else results.push(missing(CHECK_IDS[0], 'reserved run-stamped proposal was not found on disk and in post-baseline proposals'));

  const apiPlan = asArray(httpEvidence.plans).find((row) =>
    (row.artifact_id === manifest.planArtifactId || row.artifactId === manifest.planArtifactId || row.id === manifest.planArtifactId)
      && includesRunId(`${row.title ?? ''} ${row.path ?? ''}`, runId),
  );
  const postBaselinePlan = asArray(db.plans).find((row) => row.workspace_id === workspaceId && row.artifact_id === manifest.planArtifactId);
  if (disk.plan?.exists && apiPlan && postBaselinePlan && includesRunId(`${disk.plan.path ?? ''} ${disk.plan.title ?? ''} ${disk.plan.contents ?? ''}`, runId)) {
    results.push(pass(CHECK_IDS[1], `plan ${manifest.planArtifactId} exists on disk and in /api/plans`));
  } else results.push(missing(CHECK_IDS[1], 'run-stamped promoted plan was not found on disk and in /api/plans'));

  const orchestration = asArray(db.orchestrations).find((row) =>
    row.workspace_id === workspaceId
      && row.plan_artifact_id === manifest.planArtifactId
      && row.planning_intent_id === manifest.intentId
      && String(row.status).toLowerCase() === 'complete',
  );
  const deliberation = asArray(disk.deliberations).find((entry) => entry.exists !== false && includesRunId(`${entry.path ?? ''} ${entry.contents ?? ''}`, runId));
  if (orchestration && deliberation) results.push(pass(CHECK_IDS[2], `orchestration ${orchestration.run_id} completed with a deliberation output`));
  else results.push(missing(CHECK_IDS[2], 'completed plan/intent orchestration and run-stamped deliberation output were not both found'));

  const claudeWorkers = asArray(db.agents).filter((row) =>
    row.workspace_id === workspaceId && row.provider === 'claude' && row.is_worker === 1 && includesRunId(`${row.title ?? ''} ${row.slug ?? ''}`, runId),
  );
  const workerIds = new Set(claudeWorkers.map((row) => row.id));
  if (activityHasEdit(httpEvidence.activity, workerIds, trackedEdit)) results.push(pass(CHECK_IDS[3], `Claude worker activity includes ${trackedEdit}`));
  else results.push(missing(CHECK_IDS[3], `post-baseline /api/activity lacks the Claude worker edit ${trackedEdit}`));

  const browserOpenedAt = Number(evidence.sentinels?.browserOpenedAt ?? 0);
  const fixtureHit = asArray(evidence.fixtureHits).find((hit) =>
    Number(hit.timestamp) >= browserOpenedAt
      && normalizePath(hit.path).replace(/^\//, '') === `fixture/${runId}`
      && /(Chrome|Electron)\//i.test(String(hit.userAgent ?? '')),
  );
  if (browserOpenedAt > 0 && fixtureHit) results.push(pass(CHECK_IDS[4], 'fixture GET arrived after BROWSER_OPENED with a Chrome/Electron user-agent'));
  else results.push(missing(CHECK_IDS[4], 'no qualifying fixture GET arrived after BROWSER_OPENED'));

  const worker = claudeWorkers.find((row) => row.owner_agent_id === supervisorId && row.is_supervised === 1);
  const workerTurns = worker ? asArray(db.turn_records).filter((row) => row.workspace_id === workspaceId && row.agent_id === worker.id && terminal(row.status)) : [];
  const distinctTurns = new Set(workerTurns.map((row) => row.id));
  const distinctSessions = new Set(workerTurns.map((row) => row.session_id).filter(Boolean));
  const idleEvents = worker ? asArray(db.events).filter((row) => row.agent_id === worker.id && /idle/i.test(String(row.event_type))) : [];
  if (worker && distinctTurns.size >= 2 && distinctSessions.size >= 2 && idleEvents.length >= 2) results.push(pass(CHECK_IDS[5], `worker ${worker.id} is supervised and has two terminal turns/sessions with idle transitions`));
  else results.push(missing(CHECK_IDS[5], 'owned supervised Claude worker with two terminal turns and two idle transitions was not found'));

  const planFileName = path.basename(String(disk.plan?.path ?? ''));
  const comment = asArray(db.selection_comments).find((row) =>
    row.workspace_id === workspaceId
      && includesRunId(row.body, runId)
      && (logicalPlanArtifactId(row.file_path) === manifest.planArtifactId
        || normalizePath(row.file_path) === normalizePath(disk.plan?.path)
        || (planFileName && path.basename(String(row.file_path ?? '')) === planFileName)),
  );
  if (comment) results.push(pass(CHECK_IDS[6], `selection comment ${comment.id} targets the promoted plan`));
  else results.push(missing(CHECK_IDS[6], 'post-baseline run-stamped selection comment targeting the promoted plan was not found'));

  const turnOne = worker ? asArray(db.turn_records)
    .filter((row) => row.workspace_id === workspaceId && row.agent_id === worker.id)
    .sort((left, right) => Number(left.turn_seq) - Number(right.turn_seq))[0] : undefined;
  const capture = turnOne ? asArray(db.capture_attempts).find((row) => row.turn_id === turnOne.id && row.workspace_id === workspaceId && successfulCapture(row)) : undefined;
  const healthyTurn = turnOne && terminal(turnOne.status) && turnOne.before_ready === 1 && turnOne.after_ready === 1
    && turnOne.before_oid && turnOne.after_oid && turnOne.before_ref && turnOne.after_ref && capture;
  const changedPaths = asArray(evidence.gitDiff).map((row) => normalizePath(typeof row === 'string' ? row.replace(/^[A-Z?]+\s+/, '') : row.path));
  const trackedPresent = changedPaths.includes(trackedEdit);
  const forbidden = new Set([`generated/${runId}.txt`, 'assets/big.bin']);
  const ignoredAbsent = changedPaths.every((entry) => !entry.startsWith('node_modules/') && !entry.startsWith('generated/') && !entry.endsWith('.bin') && !forbidden.has(entry));
  if (healthyTurn && trackedPresent && ignoredAbsent) {
    const capturableBytes = Number(manifest.trackedBytes ?? 0);
    results.push(pass(CHECK_IDS[7], `turn ${turnOne.id} captured ${trackedEdit} only (${capturableBytes} tracked bytes)`, { capturableBytes }));
  } else results.push(missing(CHECK_IDS[7], 'turn-1 health/capture or Git checkpoint path-scope predicate failed'));

  return results;
}

export function exitCodeFor(results) {
  return CHECK_IDS.every((id) => results.some((result) => result.id === id && result.status === 'PASS')) ? 0 : 1;
}

function atomicJson(filePath, value, fileSystem = fs) {
  const temporary = `${filePath}.tmp`;
  fileSystem.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
  fileSystem.renameSync(temporary, filePath);
}

function defaultHttpClient({ host, port, token, workspaceId, supervisorId }) {
  return {
    async get(route) {
      const response = await fetch(`http://${host}:${port}${route}`, { headers: {
        authorization: `Bearer ${token}`,
        'x-workspace-id': workspaceId,
        'x-supervisor-id': supervisorId,
      } });
      if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}`);
      return response.json();
    },
  };
}

function resolveBetterSqlite(laresExe) {
  if (laresExe) {
    return require(path.join(path.dirname(path.resolve(laresExe)), 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3'));
  }
  return require('C:\\Users\\turke\\Projects\\AgentDashboard\\node_modules\\better-sqlite3');
}

export function resolveGit(laresExe) {
  return laresExe ? path.join(path.dirname(path.resolve(laresExe)), 'resources', 'mingit', 'cmd', 'git.exe') : 'git';
}

function defaultDbReader({ dbPath, laresExe }) {
  const Database = resolveBetterSqlite(laresExe);
  const database = new Database(dbPath, { readonly: true, fileMustExist: true });
  database.pragma('query_only = ON');
  return {
    baseline() {
      return Object.fromEntries(Object.entries(TABLE_PRIMARY_KEYS).map(([table, primaryKey]) => [table, {
        primaryKey,
        identities: database.prepare(`SELECT ${primaryKey} AS identity FROM ${table}`).all().map((row) => row.identity),
      }]));
    },
    deltas(baseline) {
      return Object.fromEntries(Object.entries(TABLE_PRIMARY_KEYS).map(([table, primaryKey]) => {
        const prior = new Set(baseline[table]?.identities ?? []);
        return [table, database.prepare(`SELECT * FROM ${table}`).all().filter((row) => !prior.has(row[primaryKey]))];
      }));
    },
    close() { database.close(); },
  };
}

function defaultGitRunner(git) {
  return {
    preflight() {
      const result = spawnSync(git, ['--version'], { encoding: 'utf8', windowsHide: true });
      if (result.error || result.status !== 0) throw result.error ?? new Error((result.stderr || 'git unavailable').trim());
    },
    diff(repoRoot, beforeOid, afterOid) {
      const result = spawnSync(git, ['-C', repoRoot, 'diff', '--name-status', beforeOid, afterOid], { encoding: 'utf8', windowsHide: true });
      if (result.error || result.status !== 0) throw result.error ?? new Error((result.stderr || 'git diff failed').trim());
      return result.stdout.trim() ? result.stdout.trim().split(/\r?\n/) : [];
    },
  };
}

function inControlRange(port, apiPort) {
  return port === Number(apiPort)
    || port === WS_CONTROL_PORT
    || (port >= JUPYTER_CONTROL_PORT_RANGE[0] && port <= JUPYTER_CONTROL_PORT_RANGE[1]);
}

async function defaultFixtureFactory(runId, clock, apiPort) {
  const hits = [];
  for (;;) {
    const server = http.createServer((request, response) => {
      hits.push({ timestamp: clock.now(), path: request.url ?? '', userAgent: request.headers['user-agent'] ?? '' });
      if (request.method === 'GET' && request.url === `/fixture/${runId}`) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><title>Lares VM acceptance ${runId}</title><h1>${runId}</h1>\n`);
      } else {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found\n');
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    if (!inControlRange(port, apiPort)) return { server, hits, url: `http://127.0.0.1:${port}/fixture/${runId}` };
    await new Promise((resolve) => server.close(resolve));
  }
}

function inspectDisk(manifest) {
  const repoRoot = manifest.repoRoot;
  const proposalCandidates = [];
  const planCandidates = [];
  const deliberations = [];
  const visit = (directory, depth = 0) => {
    if (!fs.existsSync(directory) || depth > 6) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, depth + 1);
      else if (/\.md$|plan\.json$/i.test(entry.name)) {
        const contents = fs.readFileSync(absolute, 'utf8');
        const item = { exists: true, path: absolute, contents, title: contents };
        if (absolute.includes(`${path.sep}proposals${path.sep}`) && contents.includes(manifest.proposalArtifactId)) proposalCandidates.push(item);
        if (absolute.includes(`${path.sep}plans${path.sep}`) && (contents.includes(manifest.planArtifactId) || contents.includes(manifest.proposalArtifactId))) planCandidates.push(item);
        if (absolute.includes(`${path.sep}deliberations${path.sep}`)) deliberations.push(item);
      }
    }
  };
  visit(path.join(repoRoot, '.lares'));
  return { proposal: proposalCandidates[0], plan: planCandidates[0], deliberations };
}

function renderReport(results, observations) {
  const lines = results.map((result, index) => `${result.status.padEnd(10)} [${index + 1}] ${result.name} — ${result.detail}`);
  for (const observation of observations) lines.push(`${observation.kind.padEnd(10)} ${observation.detail}`);
  const counts = Object.fromEntries(['PASS', 'FAIL', 'INCOMPLETE'].map((status) => [status.toLowerCase(), results.filter((result) => result.status === status).length]));
  lines.push(`monitor: ${counts.pass} passed, ${counts.fail} failed, ${counts.incomplete} incomplete`);
  return `${lines.join('\n')}\n`;
}

function preflightResult(name, error) {
  return { id: `preflight-${name}`, name: `Preflight: ${name}`, status: error ? 'FAIL' : 'PASS', detail: error ? error.message : 'ready' };
}

export async function runMonitor(options, injected = {}) {
  const io = injected.io ?? { fs };
  const clock = injected.clock ?? { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
  const env = options.env ?? process.env;
  const runDir = path.resolve(options.runDir);
  io.fs.mkdirSync(runDir, { recursive: true });
  const manifestPath = path.resolve(options.manifestPath ?? path.join(runDir, 'MANIFEST.json'));
  let manifest;
  try { manifest = options.manifest ?? JSON.parse(io.fs.readFileSync(manifestPath, 'utf8')); }
  catch (error) { manifest = { runId: 'unknown' }; }
  const requiredEnv = {
    host: env.AGENT_DASHBOARD_API_HOST,
    port: env.AGENT_DASHBOARD_API_PORT,
    token: env.AGENT_DASHBOARD_API_TOKEN,
    workspaceId: env.AGENT_DASHBOARD_WORKSPACE_ID,
    supervisorId: env.AGENT_DASHBOARD_SELF_ID,
  };
  const preflight = [];
  const missingEnv = Object.entries(requiredEnv).filter(([, value]) => value === undefined || value === '').map(([key]) => key);
  preflight.push(preflightResult('environment', missingEnv.length ? new Error(`missing ${missingEnv.join(', ')}`) : null));
  if (missingEnv.length) return finishPreflightFailure(runDir, manifest, preflight, io.fs);

  const httpClient = injected.httpClient ?? defaultHttpClient(requiredEnv);
  try { await httpClient.get('/api/agents'); preflight.push(preflightResult('GET /api/agents')); }
  catch (error) { preflight.push(preflightResult('GET /api/agents', error)); return finishPreflightFailure(runDir, manifest, preflight, io.fs); }

  let dbReader;
  try {
    dbReader = injected.dbReader ?? (injected.createDbReader ?? defaultDbReader)({ dbPath: options.dbPath, laresExe: options.laresExe });
    preflight.push(preflightResult('read-only SQLite'));
  } catch (error) { preflight.push(preflightResult('read-only SQLite', error)); return finishPreflightFailure(runDir, manifest, preflight, io.fs); }

  const gitRunner = injected.gitRunner ?? defaultGitRunner(resolveGit(options.laresExe));
  try { gitRunner.preflight(); preflight.push(preflightResult('Git resolution')); }
  catch (error) { preflight.push(preflightResult('Git resolution', error)); dbReader.close?.(); return finishPreflightFailure(runDir, manifest, preflight, io.fs); }

  const baseline = dbReader.baseline();
  atomicJson(path.join(runDir, SENTINELS.BASELINE), { runId: manifest.runId, capturedAt: clock.now(), tables: baseline }, io.fs);
  const fixture = injected.fixtureFactory ? await injected.fixtureFactory(manifest.runId, clock, requiredEnv.port) : await defaultFixtureFactory(manifest.runId, clock, requiredEnv.port);
  atomicJson(path.join(runDir, SENTINELS.CONTROL), {
    runId: manifest.runId,
    workspaceId: requiredEnv.workspaceId,
    browserFixtureUrl: fixture.url,
    manifestPath,
    pid: process.pid,
  }, io.fs);
  io.fs.writeFileSync(path.join(runDir, SENTINELS.READY), '');

  const deadline = clock.now() + (options.timeoutMs ?? 30 * 60_000);
  let timedOut = false;
  while (!io.fs.existsSync(path.join(runDir, SENTINELS.DONE))) {
    if (clock.now() >= deadline) { timedOut = true; break; }
    await clock.sleep(options.pollMs ?? 250);
  }

  const db = dbReader.deltas(baseline);
  const httpEvidence = {
    plans: await safeGet(httpClient, '/api/plans'),
    activity: await safeGet(httpClient, '/api/activity'),
  };
  const disk = (injected.diskReader ?? inspectDisk)(manifest);
  const claudeWorker = asArray(db.agents).find((row) => row.workspace_id === requiredEnv.workspaceId && row.provider === 'claude' && row.is_worker === 1);
  const turnOne = claudeWorker && asArray(db.turn_records)
    .filter((row) => row.agent_id === claudeWorker.id)
    .sort((left, right) => Number(left.turn_seq) - Number(right.turn_seq))[0];
  let gitDiff = [];
  if (turnOne?.before_oid && turnOne?.after_oid) {
    try { gitDiff = gitRunner.diff(manifest.repoRoot, turnOne.before_oid, turnOne.after_oid); } catch { gitDiff = []; }
  }
  const browserOpenedPath = path.join(runDir, SENTINELS.BROWSER_OPENED);
  const results = evaluateChecks({
    manifest, workspaceId: requiredEnv.workspaceId, supervisorId: requiredEnv.supervisorId,
    db, http: httpEvidence, disk, fixtureHits: fixture.hits, gitDiff, timedOut,
    sentinels: { browserOpenedAt: io.fs.existsSync(browserOpenedPath) ? io.fs.statSync(browserOpenedPath).mtimeMs : 0 },
  });
  const ignoredActivity = asArray(httpEvidence.activity).some((row) => {
    const activityPath = normalizePath(row.file_path ?? row.filePath);
    return activityPath.startsWith('generated/') || activityPath.includes('/generated/');
  });
  const ackPath = path.join(runDir, SENTINELS.COMMENT_ACK);
  const ack = io.fs.existsSync(ackPath) ? io.fs.readFileSync(ackPath, 'utf8').trim() : '';
  const commentId = asArray(db.selection_comments).find((row) => includesRunId(row.body, manifest.runId))?.id ?? '';
  const observations = [
    { kind: 'KNOWN GAP', detail: `ignored activity visibility: ${ignoredActivity ? 'present' : 'absent'}` },
    { kind: 'KNOWN GAP', detail: `comment ack-id parity: ${ack && ack === commentId ? 'match' : 'not observed/mismatch'}` },
    { kind: 'KNOWN GAP', detail: `browser_history fixture row: ${asArray(db.browser_history).some((row) => row.url === fixture.url) ? 'present' : 'absent'}` },
    { kind: 'HUMAN', detail: 'confirm ignored folders are visible in the file tree' },
    { kind: 'HUMAN', detail: 'confirm the *.zip gitignore suggestion appears in the UI' },
    { kind: 'HUMAN', detail: 'confirm the browser tab is visible and comment replies behave as expected' },
  ];
  const report = { runId: manifest.runId, completedAt: clock.now(), timedOut, preflight, fixtureHits: fixture.hits, checks: results, observations, exitCode: exitCodeFor(results) };
  atomicJson(path.join(runDir, SENTINELS.REPORT_JSON), report, io.fs);
  io.fs.writeFileSync(path.join(runDir, SENTINELS.REPORT_TEXT), renderReport(results, observations), 'utf8');
  fixture.server?.close?.();
  dbReader.close?.();
  return report;
}

async function safeGet(client, route) {
  try { return await client.get(route); } catch { return []; }
}

function finishPreflightFailure(runDir, manifest, preflight, fileSystem) {
  const results = CHECK_IDS.map((id) => fail(id, 'monitor preflight failed'));
  const report = { runId: manifest.runId, preflight, checks: results, observations: [], exitCode: 1 };
  atomicJson(path.join(runDir, SENTINELS.REPORT_JSON), report, fileSystem);
  fileSystem.writeFileSync(path.join(runDir, SENTINELS.REPORT_TEXT), renderReport(results, []), 'utf8');
  return report;
}

function parseArgs(argv) {
  const args = [...argv];
  const options = { timeoutMs: 30 * 60_000 };
  let watch = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--watch') { watch = true; continue; }
    const value = args.shift();
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === '--run-dir') options.runDir = value;
    else if (flag === '--manifest') options.manifestPath = value;
    else if (flag === '--db') options.dbPath = value;
    else if (flag === '--lares-exe') options.laresExe = value;
    else if (flag === '--timeout-min') options.timeoutMs = Number(value) * 60_000;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!watch || !options.runDir || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('usage: monitor.mjs --watch --run-dir <dir> [--manifest <MANIFEST.json>] [--db <dashboard.db>] [--lares-exe <Lares.exe>] [--timeout-min <n>]');
  }
  options.dbPath ??= path.join(process.env.APPDATA ?? '', 'AgentDashboard', 'dashboard.db');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = await runMonitor(parseArgs(process.argv.slice(2)));
    for (const [index, result] of report.checks.entries()) {
      const tag = result.status === 'PASS' ? '  ok  ' : result.status === 'INCOMPLETE' ? ' inc  ' : ' FAIL ';
      console.log(`${tag} [${index + 1}] ${result.name} — ${result.detail}`);
    }
    const passed = report.checks.filter((result) => result.status === 'PASS').length;
    const failed = report.checks.filter((result) => result.status === 'FAIL').length;
    const incompleteCount = report.checks.filter((result) => result.status === 'INCOMPLETE').length;
    console.log(`\nmonitor: ${passed} passed, ${failed} failed, ${incompleteCount} incomplete`);
    process.exitCode = report.exitCode;
  } catch (error) {
    console.error(` FAIL  [0] monitor — ${error instanceof Error ? error.message : String(error)}`);
    console.error('\nmonitor: 0 passed, 1 failed, 0 incomplete');
    process.exitCode = 1;
  }
}
