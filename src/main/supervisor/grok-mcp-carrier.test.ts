import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { Agent, AgentStatus } from '../../shared/types';
import { workspaceStateDir } from '../workspace-state-dir';
import { AgentSupervisor } from './index';
import { AGY_DASHBOARD_MCP_LIMITATION, toolsetsForLane } from './mcp-config-builder';
import { getScriptPath } from './paths';
import { WindowsRunner } from './windows-runner';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import {
  assessGrokMcpDisposition,
  buildGrokMcpCarrierToml,
  isGrokCwdTrusted,
  tomlEscapeBasicString,
  type GrokMcpDispositionFacts,
} from './grok-mcp-carrier';

const SENTINEL = 'WP2_SENTINEL_NOT_A_REAL_TOKEN';
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function temporaryDirectory(label: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), `lares-${label}-`));
  cleanups.push(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function carrier(runtimePath = 'C:\\Program Files\\Lares\\Lares.exe', sidecarPath = 'C:\\Program Files\\Lares\\resources\\scripts\\mcp-dashboard.js'): string {
  return buildGrokMcpCarrierToml({ runtimePath, sidecarPath, toolsets: toolsetsForLane('worker') });
}

test('TOML basic strings escape paths, quotes, slashes, and controls', () => {
  assert.equal(tomlEscapeBasicString('a\\b"c\n\t\u007f'), 'a\\\\b\\"c\\n\\t\\u007f');
});

test('carrier TOML has production-safe paths, ordering, placeholders, and inline env', () => {
  const text = carrier();
  const lines = text.trimEnd().split('\n');
  assert.deepEqual(lines, [
    '[mcp_servers.agent-dashboard]',
    'command = "C:/Program Files/Lares/Lares.exe"',
    'args = ["C:/Program Files/Lares/resources/scripts/mcp-dashboard.js"]',
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 6000',
    'env = { ELECTRON_RUN_AS_NODE = "1", AGENT_DASHBOARD_API_TOKEN = "${AGENT_DASHBOARD_API_TOKEN}", AGENT_DASHBOARD_API_PORT = "${AGENT_DASHBOARD_API_PORT}", AGENT_DASHBOARD_API_HOST = "${AGENT_DASHBOARD_API_HOST}", AGENT_DASHBOARD_SELF_ID = "${AGENT_DASHBOARD_SELF_ID}", AGENT_DASHBOARD_WORKSPACE_ID = "${AGENT_DASHBOARD_WORKSPACE_ID}", DASHBOARD_MCP_TOOLSETS = "comms,observability-core,browser-present,plans-read,memory,checkpoints-read,library-read" }',
  ]);
  assert.equal(text.includes('command = "node"'), false);
  assert.ok(text.indexOf('tool_timeout_sec') < text.indexOf('env = {'));
  assert.equal(text.match(/startup_timeout_sec/g)?.length, 1);
  assert.equal(text.match(/tool_timeout_sec/g)?.length, 1);
});

test('packaged and dev-style runtime/sidecar paths with spaces are materialized', () => {
  for (const [runtimePath, sidecarPath] of [
    ['C:\\Program Files\\Lares\\Lares.exe', 'C:\\Program Files\\Lares\\resources\\scripts\\mcp-dashboard.js'],
    ['C:\\src trees\\lares\\node.exe', 'C:\\src trees\\lares\\scripts\\mcp-dashboard.js'],
  ]) {
    const text = carrier(runtimePath, sidecarPath);
    assert.ok(text.includes(runtimePath.replace(/\\/g, '/')));
    assert.ok(text.includes(sidecarPath.replace(/\\/g, '/')));
  }
});

test('every failed Grok disposition precondition has a specific degraded reason', () => {
  const expectedCarrierText = carrier();
  const healthy: GrokMcpDispositionFacts = {
    expectedCarrierText,
    actualCarrierText: expectedCarrierText,
    runtimeExists: true,
    sidecarExists: true,
    tokenWillBeInjected: true,
    canonicalWorkerCwd: true,
    trustEligible: true,
  };
  assert.deepEqual(assessGrokMcpDisposition(healthy), { status: 'available', reason: null });
  const cases: Array<[Partial<GrokMcpDispositionFacts>, RegExp]> = [
    [{ actualCarrierText: null }, /carrier is absent/i],
    [{ actualCarrierText: `${expectedCarrierText}# edited` }, /does not match/i],
    [{ runtimeExists: false }, /runtime path does not exist/i],
    [{ sidecarExists: false }, /sidecar path does not exist/i],
    [{ canonicalWorkerCwd: false }, /cwd is not the canonical/i],
    [{ trustEligible: false }, /cwd is not trusted/i],
    [{ tokenWillBeInjected: false }, /lacks the per-agent.*token/i],
  ];
  for (const [override, reason] of cases) {
    const result = assessGrokMcpDisposition({ ...healthy, ...override });
    assert.equal(result.status, 'degraded');
    assert.match(result.reason ?? '', reason);
  }
});

function tomlKey(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

test('trust eligibility reads the effective Grok trust record without changing it', () => {
  const fixture = temporaryDirectory('grok-trust');
  const cwd = path.join(fixture, 'worker');
  const grokHome = path.join(fixture, 'grok-home');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  fs.mkdirSync(grokHome, { recursive: true });
  const trustPath = path.join(grokHome, 'trusted_folders.toml');
  const key = fs.realpathSync.native(cwd);
  const body = `[folders."${tomlKey(key)}"]\ntrusted = true\n`;
  fs.writeFileSync(trustPath, body, 'utf8');
  const priorGrokHome = process.env.GROK_HOME;
  process.env.GROK_HOME = grokHome;
  cleanups.push(() => {
    if (priorGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = priorGrokHome;
  });
  assert.equal(isGrokCwdTrusted(cwd), true);
  assert.equal(fs.readFileSync(trustPath, 'utf8'), body);
});

interface LaunchCapture {
  agent: Agent;
  statuses: Array<{ id: string; status: string; message: string | null }>;
  environments: Array<Record<string, string>>;
  supervisor: AgentSupervisor;
}

function launchHarness(provider: 'grok' | 'agy'): LaunchCapture {
  const fixture = temporaryDirectory(`${provider}-launch`);
  const workspaceRoot = path.join(fixture, 'workspace');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const workingDirectory = path.join(workspaceStateDir(workspaceRoot, 'windows'), 'workers', provider);
  const agent = makeAgent(`${provider}-worker`, {
    provider,
    command: provider,
    workingDirectory,
    isSupervised: true,
    dashboardMcpStatus: 'unknown',
    dashboardMcpMessage: null,
  });
  const agents = new Map([[agent.id, agent]]);
  const statuses: LaunchCapture['statuses'] = [];
  const environments: LaunchCapture['environments'] = [];

  const db = require('../database') as Record<string, unknown>;
  const dbKeys = [
    'updateAgentStatus', 'applyStatusTransition', 'updateAgentHookStatus', 'updateAgentDashboardMcpStatus',
    'updateAgentPid', 'getAgent', 'addEvent', 'updateAgentLastOutput', 'updateAgentExitCode',
    'getActiveAgents', 'getAllAgents', 'getSupervisorAgent', 'addFileActivity', 'getTeamMembership',
    'getAgentTemplate', 'getCurrentBrick',
  ];
  const originalDb = new Map(dbKeys.map((key) => [key, db[key]]));
  db.updateAgentStatus = (id: string, status: AgentStatus) => { const value = agents.get(id); if (value) value.status = status; };
  db.applyStatusTransition = (id: string, status: AgentStatus) => {
    const value = agents.get(id); const prior = value?.status ?? 'idle'; if (value) value.status = status;
    return { prior, current: status, changed: prior !== status };
  };
  db.updateAgentHookStatus = () => {};
  db.updateAgentDashboardMcpStatus = (id: string, status: string, message: string | null) => {
    statuses.push({ id, status, message });
    const value = agents.get(id);
    if (value) { value.dashboardMcpStatus = status as Agent['dashboardMcpStatus']; value.dashboardMcpMessage = message; }
  };
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => agents.get(id) ?? null;
  db.addEvent = () => {};
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => [...agents.values()];
  db.getAllAgents = () => [...agents.values()];
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;
  db.getTeamMembership = () => null;
  db.getAgentTemplate = () => null;
  db.getCurrentBrick = () => null;

  const resolver = require('./provider-resolver') as Record<string, unknown>;
  const originalResolver = resolver.findWindowsProviderBinary;
  resolver.findWindowsProviderBinary = async () => `C:\\fixture\\${provider}.exe`;
  const discovery = require('./session-id-discovery') as Record<string, unknown>;
  const originalDiscovery = discovery.shouldDiscoverCodexSession;
  discovery.shouldDiscoverCodexSession = () => false;
  const originalLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner,
    _cwd: string,
    _command: string,
    _args: string[],
    _logPath: string,
    _directSpawn: boolean,
    extraEnv?: Record<string, string>,
  ) {
    environments.push({ ...(extraEnv ?? {}) });
    (this as unknown as { _pid: number; _alive: boolean })._pid = 2468;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };

  const supervisor = new AgentSupervisor();
  const privateSupervisor = supervisor as unknown as {
    writeAgentRegistry: () => void;
    ensureSpoolTailer: () => void;
    healLegacyStateDirScaffold: () => void;
    mintAgentCapabilityToken: () => string;
  };
  privateSupervisor.writeAgentRegistry = () => {};
  privateSupervisor.ensureSpoolTailer = () => {};
  privateSupervisor.healLegacyStateDirScaffold = () => {};
  privateSupervisor.mintAgentCapabilityToken = () => SENTINEL;

  cleanups.push(() => {
    (WindowsRunner.prototype as { launch: unknown }).launch = originalLaunch;
    resolver.findWindowsProviderBinary = originalResolver;
    discovery.shouldDiscoverCodexSession = originalDiscovery;
    for (const [key, value] of originalDb) db[key] = value;
  });
  return { agent, statuses, environments, supervisor };
}

async function launch(capture: LaunchCapture, resume = false): Promise<void> {
  await (capture.supervisor as unknown as { launchWindowsAgent: (agent: Agent, resume?: boolean) => Promise<void> })
    .launchWindowsAgent(capture.agent, resume);
}

test('real Grok scaffold and fresh/resume launch seams keep the token off disk and record disposition', async () => {
  const capture = launchHarness('grok');
  const workspaceRoot = path.dirname(path.dirname(path.dirname(capture.agent.workingDirectory)));
  const privateSupervisor = capture.supervisor as unknown as {
    ensureWorkerScaffold: (root: string, provider: string, pathType: string) => void;
  };
  const priorToken = process.env.AGENT_DASHBOARD_API_TOKEN;
  process.env.AGENT_DASHBOARD_API_TOKEN = SENTINEL;
  cleanups.push(() => {
    if (priorToken === undefined) delete process.env.AGENT_DASHBOARD_API_TOKEN;
    else process.env.AGENT_DASHBOARD_API_TOKEN = priorToken;
  });
  privateSupervisor.ensureWorkerScaffold(workspaceRoot, 'grok', 'windows');
  const carrierPath = path.join(capture.agent.workingDirectory, '.grok', 'config.toml');
  assert.ok(fs.existsSync(carrierPath),
    'REACHABILITY:grok-mcp-carrier-scaffold carrier must reach the real scaffold artifact');
  const artifact = fs.readFileSync(carrierPath, 'utf8');
  assert.ok(artifact.includes('${AGENT_DASHBOARD_API_TOKEN}'), 'REACHABILITY:grok-mcp-carrier-scaffold placeholder must reach the real scaffold artifact');
  assert.equal(artifact.includes(SENTINEL), false, 'the launch token must not be written to the carrier');
  assert.equal(artifact, carrier(process.execPath, getScriptPath('mcp-dashboard.js')));
  const scaffoldVersions = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, '.lares', '.scaffold-versions.json'), 'utf8'),
  ) as Record<string, number>;
  assert.equal(scaffoldVersions['workers/grok/.grok/config.toml'], 1,
    'REACHABILITY:grok-mcp-carrier-scaffold managed carrier entry must reach the scaffold ledger');

  const grokHome = path.join(path.dirname(workspaceRoot), 'grok-home');
  fs.mkdirSync(grokHome, { recursive: true });
  const trustKey = fs.realpathSync.native(capture.agent.workingDirectory);
  fs.writeFileSync(path.join(grokHome, 'trusted_folders.toml'), `[folders."${tomlKey(trustKey)}"]\ntrusted = true\n`, 'utf8');
  const priorGrokHome = process.env.GROK_HOME;
  process.env.GROK_HOME = grokHome;
  cleanups.push(() => {
    if (priorGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = priorGrokHome;
  });

  await launch(capture, false);
  await launch(capture, true);
  assert.deepEqual(capture.statuses.map(({ status }) => status), ['available', 'available'],
    'REACHABILITY:grok-mcp-status-seam fresh and resume must enter the production disposition write');
  assert.equal(capture.environments.length, 2);
  assert.equal(capture.environments.every((env) => env.AGENT_DASHBOARD_API_TOKEN === SENTINEL), true,
    'the same minted token assessed by the seam must reach the child env');

  fs.rmSync(carrierPath);
  await launch(capture, true);
  assert.equal(capture.statuses.at(-1)?.status, 'degraded', 'REACHABILITY:grok-mcp-status-seam missing carrier must degrade');
  assert.match(capture.statuses.at(-1)?.message ?? '', /carrier is absent/i);

  const persona = { ...capture.agent, id: 'grok-persona', workingDirectory: path.join(workspaceRoot, '.lares', 'agents', 'persona'), dashboardMcpStatus: 'unknown' as const };
  capture.agent.id = persona.id;
  capture.agent.workingDirectory = persona.workingDirectory;
  capture.agent.dashboardMcpStatus = persona.dashboardMcpStatus;
  fs.mkdirSync(capture.agent.workingDirectory, { recursive: true });
  const writesBefore = capture.statuses.length;
  await launch(capture, false);
  assert.equal(capture.statuses.length, writesBefore, 'REACHABILITY:grok-mcp-status-seam non-canonical worker-role persona must stay unknown');
});

test('canonical Antigravity worker launch records the version-qualified limitation', async () => {
  const capture = launchHarness('agy');
  const isolatedHome = temporaryDirectory('agy-home');
  const priorUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = isolatedHome;
  cleanups.push(() => {
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
  });
  fs.mkdirSync(capture.agent.workingDirectory, { recursive: true });
  await launch(capture);
  assert.deepEqual(capture.statuses.at(-1), {
    id: capture.agent.id,
    status: 'degraded',
    message: AGY_DASHBOARD_MCP_LIMITATION,
  });
  assert.equal(
    fs.existsSync(path.join(isolatedHome, '.gemini', 'config', 'mcp_config.json')),
    false,
    'Agy launch must not create a user-global MCP config',
  );
  assert.match(AGY_DASHBOARD_MCP_LIMITATION, /Agy 1\.1\.26/);
  assert.match(AGY_DASHBOARD_MCP_LIMITATION, /ALL dashboard MCP tools are unavailable/);
});
