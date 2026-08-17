import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { Agent, AgentStatus } from '../../shared/types';
import {
  CODEX_RESEARCHER_TOOL_DENY_HOOK,
  GUARD_GIT_DISCARD_MJS,
  RESEARCHER_CODEX_CONFIG_TOML,
} from '../../shared/constants';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import { AgentSupervisor } from './index';
import { AGY_GIT_DISCARD_DENY_RULES } from './agy-settings';
import { WindowsRunner } from './windows-runner';
import { WslRunner } from './wsl-runner';
import { makeAgent } from './test-helpers/fake-bridge-deps';

const MARKER = 'REACHABILITY:researcher-tool-boundary-unreferenced';
const cleanups: Array<() => void> = [];

interface WindowsLaunch {
  workDir: string;
  command: string;
  args: string[];
  extraEnv: Record<string, string>;
  agySettingsAtLaunch: string | null;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function invariant(message: string): string {
  return `CONFIGURATION INVARIANT: ${MARKER} ${message}`;
}

function patchEnvironment(home: string): void {
  const previousUserProfile = process.env.USERPROFILE;
  const previousHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  cleanups.push(() => {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
}

function patchDb(workspacePath: string, agents: Agent[]): void {
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'getWorkspace', 'createAgent', 'updateAgentStatus', 'applyStatusTransition',
    'updateAgentHookStatus', 'updateAgentDashboardMcpStatus', 'updateAgentPid',
    'getAgent', 'addEvent', 'updateAgentLastOutput', 'updateAgentExitCode',
    'getActiveAgents', 'getAllAgents', 'getSupervisorAgent', 'addFileActivity',
    'updateAgentResumeSessionId', 'getTeamMembership', 'getAgentTemplate',
    'getFileActivities', 'insertAgentSession', 'getCurrentBrick',
    'getContinuationAttempt',
  ];
  const originals = new Map(keys.map((key) => [key, db[key]]));
  db.getWorkspace = (id: string) => ({ id, path: workspacePath, defaultCommand: 'claude' });
  db.createAgent = (input: Partial<Agent>) => {
    const agent = makeAgent(`boundary-${agents.length}`, input);
    agents.push(agent);
    return agent;
  };
  db.updateAgentStatus = (id: string, status: AgentStatus) => {
    const agent = agents.find((candidate) => candidate.id === id);
    if (agent) agent.status = status;
  };
  db.updateAgentHookStatus = () => {};
  db.updateAgentDashboardMcpStatus = () => {};
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => agents.find((candidate) => candidate.id === id) ?? null;
  db.addEvent = () => {};
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => agents;
  db.getAllAgents = () => agents;
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;
  db.updateAgentResumeSessionId = () => {};
  db.getTeamMembership = () => null;
  db.getAgentTemplate = () => null;
  db.getFileActivities = () => [];
  db.insertAgentSession = () => {};
  db.getCurrentBrick = () => null;
  db.getContinuationAttempt = () => null;
  patchApplyStatusTransition(db);
  cleanups.push(() => {
    for (const [key, value] of originals) db[key] = value;
  });
}

function patchProcessEdges(windowsLaunches: WindowsLaunch[], wslLaunches: string[], accountHome: string): void {
  const childProcess = require('node:child_process') as Record<string, unknown>;
  const originalExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = () => '';
  const installationDescriptor = require('../installation-descriptor') as Record<string, unknown>;
  const originalEnsureInstallationLauncher = installationDescriptor.ensureInstallationLauncher;
  installationDescriptor.ensureInstallationLauncher = () => {};

  const discovery = require('./session-id-discovery') as Record<string, unknown>;
  const originalDiscovery = discovery.shouldDiscoverCodexSession;
  discovery.shouldDiscoverCodexSession = () => false;

  const resolver = require('./provider-resolver') as Record<string, unknown>;
  const originalFindClaude = resolver.findWindowsClaudePath;
  const originalProbe = resolver.probeWindowsProvider;
  const originalFindProvider = resolver.findWindowsProviderBinary;
  const originalFindNativeCodex = resolver.findWindowsCodexNativeBinary;
  resolver.findWindowsClaudePath = async () => 'C:\\fixture\\bin\\claude.exe';
  resolver.probeWindowsProvider = async () => true;
  resolver.findWindowsProviderBinary = async (provider: string) => `C:\\fixture\\bin\\${provider}.exe`;
  resolver.findWindowsCodexNativeBinary = async () => 'C:\\fixture\\bin\\codex.exe';

  const originalWindowsLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner,
    workDir: string,
    command: string,
    args: string[],
    _logPath: string,
    _directSpawn?: boolean,
    extraEnv?: Record<string, string>,
  ) {
    const settingsPath = path.join(accountHome, '.gemini', 'antigravity-cli', 'settings.json');
    windowsLaunches.push({
      workDir,
      command,
      args: [...args],
      extraEnv: { ...(extraEnv ?? {}) },
      agySettingsAtLaunch: fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null,
    });
    (this as unknown as { _pid: number; _alive: boolean })._pid = 4242;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };

  const originalWslLaunch = (WslRunner.prototype as { launch: unknown }).launch;
  (WslRunner.prototype as { launch: unknown }).launch = async function (
    this: WslRunner,
    _workDir: string,
    command: string,
  ) {
    wslLaunches.push(command);
    (this as unknown as { _alive: boolean })._alive = true;
  };

  cleanups.push(() => {
    (WslRunner.prototype as { launch: unknown }).launch = originalWslLaunch;
    (WindowsRunner.prototype as { launch: unknown }).launch = originalWindowsLaunch;
    resolver.findWindowsClaudePath = originalFindClaude;
    resolver.probeWindowsProvider = originalProbe;
    resolver.findWindowsProviderBinary = originalFindProvider;
    resolver.findWindowsCodexNativeBinary = originalFindNativeCodex;
    discovery.shouldDiscoverCodexSession = originalDiscovery;
    childProcess.execFileSync = originalExecFileSync;
    installationDescriptor.ensureInstallationLauncher = originalEnsureInstallationLauncher;
  });
}

function makeSupervisor(): AgentSupervisor {
  const supervisor = new AgentSupervisor();
  const privateSupervisor = supervisor as unknown as {
    writeAgentRegistry: () => void;
    ensureSpoolTailer: () => void;
    setupFileTracker: () => null;
    resolveWslGatewayIp: () => string;
  };
  // Complete non-DB stub list (including patchProcessEdges): process runners,
  // provider binary probes, Codex session discovery, WSL subprocess execution,
  // installation-descriptor file output, user-global registry write, background
  // spool watcher, filesystem activity watcher, WSL gateway subprocess lookup,
  // and the WSL home-subdirectory lookup used by the credential fixture.
  // The restriction builders, scaffold writers, trust/config writers, and both
  // launch methods remain real.
  privateSupervisor.writeAgentRegistry = () => {};
  privateSupervisor.ensureSpoolTailer = () => {};
  privateSupervisor.setupFileTracker = () => null;
  privateSupervisor.resolveWslGatewayIp = () => '10.0.0.42';
  cleanups.push(() => supervisor.stop());
  return supervisor;
}

function installCredentialFixtures(accountHome: string): void {
  fs.mkdirSync(path.join(accountHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(accountHome, '.claude', '.credentials.json'), '{}\n');
  fs.mkdirSync(path.join(accountHome, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(accountHome, '.codex', 'auth.json'), '{}\n');
}

test('CONFIGURATION INVARIANT: Claude native allowlist and denylist reach Windows launch construction', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-researcher-tool-boundary-claude-'));
  cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const accountHome = path.join(fixture, 'account');
  installCredentialFixtures(accountHome);
  patchEnvironment(accountHome);
  const agents: Agent[] = [];
  const windowsLaunches: WindowsLaunch[] = [];
  patchDb(path.join(fixture, 'workspace'), agents);
  patchProcessEdges(windowsLaunches, [], accountHome);

  const supervisor = makeSupervisor();
  const windowsAgent = makeAgent('claude-boundary-windows', {
    provider: 'claude', command: 'claude', isResearcher: true,
    workingDirectory: path.join(fixture, 'workspace', '.lares', 'researcher', 'claude'),
  });
  agents.push(windowsAgent);
  await (supervisor as unknown as { launchWindowsAgent(agent: Agent): Promise<void> }).launchWindowsAgent(windowsAgent);

  const windows = windowsLaunches.at(-1);
  assert.ok(windows, invariant('Windows Claude researcher must reach the process-launch edge'));
  assert.deepEqual(
    windows.args.slice(windows.args.indexOf('--tools'), windows.args.indexOf('--tools') + 2),
    ['--tools', 'WebSearch,WebFetch,Read,Grep,Glob,Task,Skill,Write,mcp__agent-dashboard__browser_*,mcp__claude-in-chrome__*'],
    invariant('Windows Claude researcher launch must carry the configured native allowlist'),
  );
  assert.deepEqual(
    windows.args.slice(windows.args.indexOf('--disallowedTools'), windows.args.indexOf('--disallowedTools') + 2),
    ['--disallowedTools', 'Bash,Edit,MultiEdit,NotebookEdit'],
    invariant('Windows Claude researcher launch must carry the configured native denylist'),
  );
});

test('CONFIGURATION INVARIANT: Claude native allowlist and denylist reach WSL launch construction', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-researcher-tool-boundary-claude-wsl-'));
  cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const accountHome = path.join(fixture, 'account');
  installCredentialFixtures(accountHome);
  patchEnvironment(accountHome);
  const agents: Agent[] = [];
  const wslLaunches: string[] = [];
  patchDb(path.join(fixture, 'workspace'), agents);
  patchProcessEdges([], wslLaunches, accountHome);

  const logReaderTypes = require('./log-readers/types') as Record<string, unknown>;
  const originalResolveWslHomeSubdir = logReaderTypes.resolveWslHomeSubdir;
  logReaderTypes.resolveWslHomeSubdir = (subpath: string) => subpath === '.claude'
    ? path.join(accountHome, '.claude')
    : null;
  cleanups.push(() => { logReaderTypes.resolveWslHomeSubdir = originalResolveWslHomeSubdir; });

  const supervisor = makeSupervisor();
  const wslAgent = makeAgent('claude-boundary-wsl', {
    provider: 'claude', command: 'ccode', isResearcher: true,
    workingDirectory: '/home/fixture/workspace/.lares/researcher/claude',
    tmuxSessionName: 'lares-claude-boundary-wsl',
  });
  agents.push(wslAgent);
  await (supervisor as unknown as { launchWslAgent(agent: Agent): Promise<void> }).launchWslAgent(wslAgent);
  const wsl = wslLaunches.at(-1) ?? '';
  assert.match(
    wsl,
    /--tools 'WebSearch,WebFetch,Read,Grep,Glob,Task,Skill,Write,mcp__agent-dashboard__browser_\*,mcp__claude-in-chrome__\*'/,
    invariant('WSL Claude researcher launch must carry the configured native allowlist'),
  );
  assert.match(
    wsl,
    /--disallowedTools 'Bash,Edit,MultiEdit,NotebookEdit'/,
    invariant('WSL Claude researcher launch must carry the configured native denylist'),
  );
});

test('CONFIGURATION INVARIANT: Agy deny-regex configuration reaches the real researcher launch path as a degraded config reading', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-researcher-tool-boundary-agy-'));
  cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const accountHome = path.join(fixture, 'account');
  const workspace = path.join(fixture, 'workspace');
  fs.mkdirSync(accountHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  patchEnvironment(accountHome);
  const agents: Agent[] = [];
  const windowsLaunches: WindowsLaunch[] = [];
  patchDb(workspace, agents);
  patchProcessEdges(windowsLaunches, [], accountHome);

  await makeSupervisor().launchAgent({
    workspaceId: 'ws-1', title: 'agy configuration fixture', provider: 'agy',
    command: 'agy', isResearcher: true,
  });

  const launch = windowsLaunches.at(-1);
  assert.ok(launch, invariant('Agy researcher must reach the process-launch edge'));
  assert.ok(launch.agySettingsAtLaunch, invariant('Agy settings must exist before the researcher process-launch edge'));
  const settings = JSON.parse(launch.agySettingsAtLaunch) as { permissions?: { deny?: string[] } };
  assert.deepEqual(
    settings.permissions?.deny,
    AGY_GIT_DISCARD_DENY_RULES,
    invariant('Agy researcher launch must carry the configured reviewed deny-regex list; this does not observe a denial'),
  );
});

test('REACHABILITY: Grok researcher is refused by the real launch seam before process spawn', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-researcher-tool-boundary-grok-'));
  cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const accountHome = path.join(fixture, 'account');
  const workspace = path.join(fixture, 'workspace');
  fs.mkdirSync(accountHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  patchEnvironment(accountHome);
  const agents: Agent[] = [];
  const windowsLaunches: WindowsLaunch[] = [];
  patchDb(workspace, agents);
  patchProcessEdges(windowsLaunches, [], accountHome);

  await assert.rejects(
    () => makeSupervisor().launchAgent({
      workspaceId: 'ws-1', title: 'grok refusal fixture', provider: 'grok',
      command: 'grok', isResearcher: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /researcher lane is not-yet-activated for grok/);
      assert.match(error.message, /no tool-restriction mechanism exists/);
      return true;
    },
  );

  assert.equal(agents.length, 1, 'fixture must reach production researcher classification before refusal');
  assert.equal(agents[0].provider, 'grok');
  assert.equal(agents[0].isResearcher, true);
  assert.equal(windowsLaunches.length, 0, 'Grok researcher refusal must happen before WindowsRunner.launch');
});

test('CONFIGURATION INVARIANT: Codex researcher has a production config consumer for consistency and dependability', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-researcher-tool-boundary-codex-'));
  cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const accountHome = path.join(fixture, 'account');
  const workspace = path.join(fixture, 'workspace');
  installCredentialFixtures(accountHome);
  fs.mkdirSync(workspace, { recursive: true });
  patchEnvironment(accountHome);
  const agents: Agent[] = [];
  const windowsLaunches: WindowsLaunch[] = [];
  patchDb(workspace, agents);
  patchProcessEdges(windowsLaunches, [], accountHome);

  const agent = await makeSupervisor().launchAgent({
    workspaceId: 'ws-1', title: 'codex config fixture', provider: 'codex',
    command: 'codex', isResearcher: true,
  });
  const launch = windowsLaunches.at(-1);
  assert.ok(launch, invariant('Codex researcher must reach the process-launch edge before config is evaluated'));
  assert.equal(agent.wantsCodexHooks, true,
    invariant('Codex researcher launch must opt into the production hook configuration seam'));
  assert.ok(launch.args.includes('--dangerously-bypass-hook-trust'),
    invariant('Codex researcher launch must load hook-capable project config without an interactive trust prompt'));
  assert.equal(
    CODEX_RESEARCHER_TOOL_DENY_HOOK,
    GUARD_GIT_DISCARD_MJS,
    invariant('CODEX_RESEARCHER_TOOL_DENY_HOOK must remain explicitly recorded as an alias of the shared git-discard guard'),
  );

  const researcherConfig = path.join(agent.workingDirectory, '.codex', 'config.toml');
  const researcherConfigBody = fs.existsSync(researcherConfig) ? fs.readFileSync(researcherConfig, 'utf8') : '';
  const launchArtifact = JSON.stringify({
    command: launch.command,
    args: launch.args,
    env: launch.extraEnv,
    researcherConfig: researcherConfigBody,
  });
  assert.equal(
    fs.existsSync(researcherConfig),
    true,
    invariant('Codex researcher cwd must carry the production project config consumer'),
  );
  assert.equal(
    researcherConfigBody,
    RESEARCHER_CODEX_CONFIG_TOML,
    invariant('Codex researcher config must match the versioned production scaffold body'),
  );
  assert.match(
    launchArtifact,
    /guard-git-discard|CODEX_RESEARCHER_TOOL_DENY_HOOK|hooks\.PreToolUse|\[\[hooks\.PreToolUse\]\]|dashboard-worker/,
    invariant('Codex researcher launch artifacts must expose the configured PreToolUse consumer; this does not observe a denial'),
  );
  assert.match(
    researcherConfigBody,
    /failing open[\s\S]*consistency and dependability[\s\S]*never a researcher write boundary/,
    invariant('Codex researcher config must state the observed fail-open posture without an enforcement claim'),
  );
  const sharedGuard = path.join(workspace, '.lares', 'scripts', 'guard-git-discard.mjs');
  assert.equal(
    fs.readFileSync(sharedGuard, 'utf8'),
    GUARD_GIT_DISCARD_MJS,
    invariant('the configured shared guard artifact must be present; config presence does not establish an observed denial'),
  );
});
