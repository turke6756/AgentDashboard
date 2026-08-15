import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { Agent, AgentStatus } from '../../shared/types';
import { AgentSupervisor } from './index';
import { WindowsRunner } from './windows-runner';
import { WslRunner } from './wsl-runner';
import { makeAgent } from './test-helpers/fake-bridge-deps';

interface CapturedLaunch {
  workDir: string;
  args: string[];
  extraEnv: Record<string, string>;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function patchLaunchDependencies(agents: Map<string, Agent>, launches: CapturedLaunch[]): void {
  const db = require('../database') as Record<string, unknown>;
  const dbKeys = [
    'updateAgentStatus', 'applyStatusTransition', 'updateAgentHookStatus', 'updateAgentDashboardMcpStatus', 'updateAgentPid',
    'getAgent', 'addEvent', 'updateAgentLastOutput', 'updateAgentExitCode',
    'getActiveAgents', 'getAllAgents', 'getSupervisorAgent', 'addFileActivity',
    'updateAgentResumeSessionId', 'getTeamMembership', 'getAgentTemplate', 'getCurrentBrick',
  ];
  const originalDb = new Map(dbKeys.map((key) => [key, db[key]]));
  db.updateAgentStatus = (id: string, status: AgentStatus) => {
    const agent = agents.get(id);
    if (agent) agent.status = status;
  };
  db.applyStatusTransition = (id: string, status: AgentStatus) => {
    const agent = agents.get(id);
    const prior = agent?.status ?? 'idle';
    if (agent) agent.status = status;
    return { prior, current: status, changed: prior !== status };
  };
  db.updateAgentHookStatus = () => {};
  db.updateAgentDashboardMcpStatus = () => {};
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => agents.get(id) ?? null;
  db.addEvent = () => {};
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => Array.from(agents.values());
  db.getAllAgents = () => Array.from(agents.values());
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;
  db.updateAgentResumeSessionId = () => {};
  db.getTeamMembership = () => null;
  db.getAgentTemplate = () => null;
  db.getCurrentBrick = () => null;

  const discovery = require('./session-id-discovery') as Record<string, unknown>;
  const originalDiscovery = discovery.shouldDiscoverCodexSession;
  discovery.shouldDiscoverCodexSession = () => false;

  const resolver = require('./provider-resolver') as Record<string, unknown>;
  const originalFindClaude = resolver.findWindowsClaudePath;
  const originalProbe = resolver.probeWindowsProvider;
  const originalFindProvider = resolver.findWindowsProviderBinary;
  resolver.findWindowsClaudePath = async () => 'C:\\fixture\\bin\\claude.exe';
  resolver.probeWindowsProvider = async () => true;
  resolver.findWindowsProviderBinary = async (provider: string) => `C:\\fixture\\bin\\${provider}.exe`;

  const originalRunnerLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner,
    workDir: string,
    _command: string,
    args: string[],
    _logPath: string,
    _directSpawn?: boolean,
    extraEnv?: Record<string, string>,
  ) {
    launches.push({ workDir, args: [...args], extraEnv: { ...(extraEnv ?? {}) } });
    (this as unknown as { _pid: number; _alive: boolean })._pid = 4242;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };

  cleanups.push(() => {
    (WindowsRunner.prototype as { launch: unknown }).launch = originalRunnerLaunch;
    resolver.findWindowsClaudePath = originalFindClaude;
    resolver.probeWindowsProvider = originalProbe;
    resolver.findWindowsProviderBinary = originalFindProvider;
    discovery.shouldDiscoverCodexSession = originalDiscovery;
    for (const [key, value] of originalDb) db[key] = value;
  });
}

function makeSupervisor(): AgentSupervisor {
  const supervisor = new AgentSupervisor();
  const privateSupervisor = supervisor as unknown as {
    writeAgentRegistry: () => void;
    ensureSpoolTailer: () => void;
    healLegacyStateDirScaffold: () => void;
    resolveWslGatewayIp: () => string;
    launchWindowsAgent: (agent: Agent) => Promise<void>;
  };
  privateSupervisor.writeAgentRegistry = () => {};
  privateSupervisor.ensureSpoolTailer = () => {};
  privateSupervisor.healLegacyStateDirScaffold = () => {};
  privateSupervisor.resolveWslGatewayIp = () => '10.0.0.42';
  return supervisor;
}

function writeCredentials(accountHome: string, providers: readonly string[]): void {
  if (providers.includes('claude')) {
    fs.mkdirSync(path.join(accountHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(accountHome, '.claude', '.credentials.json'), '{}\n');
  }
  if (providers.includes('codex')) {
    fs.mkdirSync(path.join(accountHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(accountHome, '.codex', 'auth.json'), '{}\n');
  }
}

async function launchWindows(supervisor: AgentSupervisor, agent: Agent): Promise<void> {
  try {
    await (supervisor as unknown as { launchWindowsAgent: (value: Agent) => Promise<void> })
      .launchWindowsAgent(agent);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`REACHABILITY:researcher-home-redirect-unreferenced ${detail}`, { cause: error });
  }
}

test('production launch path gives researchers the worker provider home and preserves researcher cwd', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-researcher-shared-home-'));
  cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const accountHome = path.join(fixture, 'account');
  writeCredentials(accountHome, ['claude', 'codex']);
  const previousUserProfile = process.env.USERPROFILE;
  const previousHome = process.env.HOME;
  process.env.USERPROFILE = accountHome;
  process.env.HOME = accountHome;
  cleanups.push(() => {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const agents = new Map<string, Agent>();
  const launches: CapturedLaunch[] = [];
  patchLaunchDependencies(agents, launches);
  const supervisor = makeSupervisor();

  for (const provider of ['claude', 'codex', 'agy'] as const) {
    const researcherCwd = path.join(fixture, 'workspace', '.lares', 'researcher', provider);
    const workerCwd = path.join(fixture, 'workspace', '.lares', 'workers', provider);
    fs.mkdirSync(researcherCwd, { recursive: true });
    fs.mkdirSync(workerCwd, { recursive: true });
    const baselineFile = path.join(researcherCwd, 'baseline.bin');
    const baselineBytes = Buffer.from([0, 1, 2, 255]);
    fs.writeFileSync(baselineFile, baselineBytes);

    const worker = makeAgent(`worker-${provider}`, {
      provider, command: provider, workingDirectory: workerCwd,
      isSupervised: true, isWorker: false, isResearcher: false,
    });
    const researcher = makeAgent(`researcher-${provider}`, {
      provider, command: provider, workingDirectory: researcherCwd,
      isSupervised: false, isWorker: false, isResearcher: true,
    });
    agents.set(worker.id, worker);
    agents.set(researcher.id, researcher);

    await launchWindows(supervisor, worker);
    const workerLaunch = launches.at(-1)!;
    await launchWindows(supervisor, researcher);
    const researcherLaunch = launches.at(-1)!;

    const providerHomeNames = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME'];
    for (const name of providerHomeNames) {
      assert.equal(
        researcherLaunch.extraEnv[name],
        workerLaunch.extraEnv[name],
        `REACHABILITY:researcher-home-redirect-unreferenced ${provider} researcher must resolve the worker provider home`,
      );
    }
    assert.equal(
      researcherLaunch.args.some((arg) => arg.startsWith('--gemini_dir=')),
      workerLaunch.args.some((arg) => arg.startsWith('--gemini_dir=')),
      `REACHABILITY:researcher-home-redirect-unreferenced ${provider} researcher must not receive a home argv redirect`,
    );
    assert.equal(researcherLaunch.workDir, researcherCwd);
    assert.deepEqual(fs.readFileSync(baselineFile), baselineBytes, `${provider} researcher cwd content changed during launch construction`);
  }

  assert.equal(
    fs.existsSync(path.join(fixture, 'workspace', '.lares', 'agent-homes')),
    false,
    'REACHABILITY:researcher-home-redirect-unreferenced production launch must not create a per-agent home',
  );
});

test('codex researcher reads only the codex-rooted credential source', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-researcher-codex-home-'));
  cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const accountHome = path.join(fixture, 'account');
  writeCredentials(accountHome, ['codex']);
  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = accountHome;
  cleanups.push(() => {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  });

  const agents = new Map<string, Agent>();
  const launches: CapturedLaunch[] = [];
  patchLaunchDependencies(agents, launches);
  const agent = makeAgent('researcher-codex-root', {
    provider: 'codex', command: 'codex', isSupervised: false, isResearcher: true,
    workingDirectory: path.join(fixture, 'workspace', '.lares', 'researcher', 'codex'),
  });
  fs.mkdirSync(agent.workingDirectory, { recursive: true });
  agents.set(agent.id, agent);

  await launchWindows(makeSupervisor(), agent);

  assert.equal(fs.existsSync(path.join(accountHome, '.claude')), false, 'fixture must not contain a Claude state root');
  assert.equal(launches.length, 1, 'codex researcher must reach the runner with only ~/.codex/auth.json present');
});

test('WSL codex researcher uses the worker home while retaining its researcher cwd', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-researcher-wsl-home-'));
  cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const codexStateRoot = path.join(fixture, '.codex');
  fs.mkdirSync(codexStateRoot, { recursive: true });
  fs.writeFileSync(path.join(codexStateRoot, 'auth.json'), '{}\n');

  const agents = new Map<string, Agent>();
  const launches: CapturedLaunch[] = [];
  patchLaunchDependencies(agents, launches);

  const logReaderTypes = require('./log-readers/types') as Record<string, unknown>;
  const originalResolveWslHomeSubdir = logReaderTypes.resolveWslHomeSubdir;
  logReaderTypes.resolveWslHomeSubdir = (subpath: string) => subpath === '.codex' ? codexStateRoot : null;
  const wslBridge = require('../wsl-bridge') as Record<string, unknown>;
  const originalPassiveStatus = wslBridge.getPassiveWslStatus;
  wslBridge.getPassiveWslStatus = async () => ({ state: 'available', distro: 'fixture' });
  const wslLaunches: Array<{ workDir: string; command: string }> = [];
  const originalWslLaunch = (WslRunner.prototype as { launch: unknown }).launch;
  (WslRunner.prototype as { launch: unknown }).launch = async function (
    this: WslRunner,
    workDir: string,
    command: string,
  ) {
    wslLaunches.push({ workDir, command });
    (this as unknown as { _alive: boolean })._alive = true;
  };
  cleanups.push(() => {
    (WslRunner.prototype as { launch: unknown }).launch = originalWslLaunch;
    wslBridge.getPassiveWslStatus = originalPassiveStatus;
    logReaderTypes.resolveWslHomeSubdir = originalResolveWslHomeSubdir;
  });

  const worker = makeAgent('worker-codex-wsl', {
    provider: 'codex', command: 'ccodex', isSupervised: true, isResearcher: false,
    workingDirectory: '/home/fixture/workspace/.lares/workers/codex',
    tmuxSessionName: 'lares-worker-codex-wsl',
  });
  const researcher = makeAgent('researcher-codex-wsl', {
    provider: 'codex', command: 'ccodex', isSupervised: false, isResearcher: true,
    workingDirectory: '/home/fixture/workspace/.lares/researcher/codex',
    tmuxSessionName: 'lares-researcher-codex-wsl',
  });
  agents.set(worker.id, worker);
  agents.set(researcher.id, researcher);
  const supervisor = makeSupervisor();

  await (supervisor as unknown as { launchWslAgent: (agent: Agent) => Promise<void> }).launchWslAgent(worker);
  await (supervisor as unknown as { launchWslAgent: (agent: Agent) => Promise<void> }).launchWslAgent(researcher);

  assert.equal(wslLaunches.length, 2);
  assert.equal(wslLaunches[1].workDir, researcher.workingDirectory);
  assert.equal(/(?:^|\s)CODEX_HOME=/.test(wslLaunches[1].command), false,
    'REACHABILITY:researcher-home-redirect-unreferenced WSL researcher must not receive CODEX_HOME');
  assert.equal(/agent-homes/.test(wslLaunches[1].command), false,
    'REACHABILITY:researcher-home-redirect-unreferenced WSL launch command must not reference a per-agent home');
});

test('missing file credential fails before runner launch with a provider-named error', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-researcher-missing-credential-'));
  cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const accountHome = path.join(fixture, 'account');
  fs.mkdirSync(accountHome, { recursive: true });
  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = accountHome;
  cleanups.push(() => {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  });

  const agents = new Map<string, Agent>();
  const launches: CapturedLaunch[] = [];
  patchLaunchDependencies(agents, launches);
  const agent = makeAgent('researcher-codex-missing', {
    provider: 'codex', command: 'codex', isSupervised: false, isResearcher: true,
    workingDirectory: path.join(fixture, 'workspace', '.lares', 'researcher', 'codex'),
  });
  agents.set(agent.id, agent);

  await assert.rejects(
    () => launchWindows(makeSupervisor(), agent),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Cannot launch codex researcher: credential file is missing:/);
      assert.doesNotMatch(error.message, /ENOENT|statSync/);
      return true;
    },
  );
  assert.equal(launches.length, 0, 'credential preflight must fail before the runner starts');
});
