import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import type { Agent, AgentStatus } from '../../shared/types';
import { RESEARCHER_CODEX_MODEL } from '../../shared/constants';
import { AgentSupervisor } from './index';
import { WindowsRunner } from './windows-runner';
import { WslRunner } from './wsl-runner';
import { makeAgent } from './test-helpers/fake-bridge-deps';

const FIXED_TOKEN = 'WP3_SECRET_TOKEN_VALUE';
const TOKEN_ENV_NAME = 'AGENT_DASHBOARD_API_TOKEN';
const CODEX_SESSION_ID = '019e6787-dcdb-7193-8a27-71083315fc8e';
const cleanups: Array<() => void> = [];

interface WindowsLaunch {
  command: string;
  args: string[];
  directSpawn: boolean;
  extraEnv: Record<string, string>;
}

interface PtySpawn {
  command: string;
  args: string[];
}

interface DependencyOptions {
  providerBinary?: (provider: string) => Promise<string | null>;
  nativeCodexBinary?: (resolvedBinary?: string) => Promise<string | null>;
  useRealNativeCodexBinary?: boolean;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function patchDependencies(
  agents: Map<string, Agent>,
  windowsLaunches: WindowsLaunch[],
  wslLaunches: string[],
  options: DependencyOptions = {},
): (provider: string) => Promise<string | null> {
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
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => agents.get(id) ?? null;
  db.addEvent = () => {};
  db.updateAgentDashboardMcpStatus = (id: string, status: string, message: string | null) => {
    const agent = agents.get(id);
    if (agent) {
      agent.dashboardMcpStatus = status as Agent['dashboardMcpStatus'];
      agent.dashboardMcpMessage = message;
    }
  };
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
  const originalFindProvider = resolver.findWindowsProviderBinary as (provider: string) => Promise<string | null>;
  const originalFindNativeCodex = resolver.findWindowsCodexNativeBinary as (resolvedBinary?: string) => Promise<string | null>;
  resolver.findWindowsClaudePath = async () => 'C:\\fixture\\bin\\claude.exe';
  resolver.probeWindowsProvider = async () => true;
  resolver.findWindowsProviderBinary = options.providerBinary
    ?? (async (provider: string) => `C:\\fixture\\bin\\${provider}.exe`);
  resolver.findWindowsCodexNativeBinary = options.useRealNativeCodexBinary
    ? originalFindNativeCodex
    : options.nativeCodexBinary ?? (async () => 'C:\\fixture\\bin\\codex.exe');

  const originalWindowsLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner,
    _workDir: string,
    command: string,
    args: string[],
    _logPath: string,
    directSpawn?: boolean,
    extraEnv?: Record<string, string>,
  ) {
    windowsLaunches.push({ command, args: [...args], directSpawn: !!directSpawn, extraEnv: { ...(extraEnv ?? {}) } });
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
    for (const [key, value] of originalDb) db[key] = value;
  });
  return originalFindProvider;
}

/** Execute the shipping pty-host spawn planner with a fake node-pty sink. This
 *  crosses the quoteForCmd layer: directSpawn=false produces cmd.exe /c and
 *  transformed bytes; directSpawn=true must hand the exact argv to node-pty. */
function executePtyHostSpawn(launch: WindowsLaunch): PtySpawn {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'pty-host.js'), 'utf8');
  let onStdinData: ((chunk: string) => void) | undefined;
  let captured: PtySpawn | undefined;
  const fakePtyProcess = {
    pid: 77,
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  };
  const sandbox = {
    require: (id: string) => {
      if (id !== 'node-pty') throw new Error(`unexpected require from pty-host: ${id}`);
      return {
        spawn: (command: string, args: string[]) => {
          captured = { command, args: [...args] };
          return fakePtyProcess;
        },
      };
    },
    process: {
      platform: 'win32',
      env: {},
      cwd: () => 'C:\\fixture',
      on: () => {},
      stdout: { write: () => true },
      stdin: {
        setEncoding: () => {},
        on: (event: string, callback: (chunk: string) => void) => {
          if (event === 'data') onStdinData = callback;
        },
      },
    },
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: 'src/main/pty-host.js' });
  assert.ok(onStdinData, 'pty-host must register its stdin command listener');
  onStdinData(`${JSON.stringify({
    type: 'spawn', command: launch.command, args: launch.args,
    cwd: 'C:\\fixture', directSpawn: launch.directSpawn,
  })}\n`);
  assert.ok(captured, 'pty-host must reach node-pty.spawn');
  return captured;
}

function makeSupervisor(): AgentSupervisor {
  const supervisor = new AgentSupervisor();
  const privateSupervisor = supervisor as unknown as {
    writeAgentRegistry: () => void;
    ensureSpoolTailer: () => void;
    healLegacyStateDirScaffold: () => void;
    resolveWslGatewayIp: () => string;
    mintAgentCapabilityToken: () => string;
  };
  privateSupervisor.writeAgentRegistry = () => {};
  privateSupervisor.ensureSpoolTailer = () => {};
  privateSupervisor.healLegacyStateDirScaffold = () => {};
  privateSupervisor.resolveWslGatewayIp = () => '10.0.0.42';
  privateSupervisor.mintAgentCapabilityToken = () => FIXED_TOKEN;
  return supervisor;
}

function installProviderCredentials(): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-mcp-ungate-'));
  cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const accountHome = path.join(fixture, 'account');
  fs.mkdirSync(path.join(accountHome, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(accountHome, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(accountHome, '.claude', '.credentials.json'), '{}\n');
  fs.writeFileSync(path.join(accountHome, '.codex', 'auth.json'), '{}\n');
  const oldUserProfile = process.env.USERPROFILE;
  const oldHome = process.env.HOME;
  process.env.USERPROFILE = accountHome;
  process.env.HOME = accountHome;
  cleanups.push(() => {
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  });
  return fixture;
}

async function launchWindows(supervisor: AgentSupervisor, agent: Agent): Promise<void> {
  try {
    await (supervisor as unknown as { launchWindowsAgent: (value: Agent) => Promise<void> })
      .launchWindowsAgent(agent);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`REACHABILITY:mcp-injection-ungated-unreferenced ${detail}`, { cause: error });
  }
}

function configValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-c') values.push(args[i + 1] ?? '');
  }
  return values;
}

function shellConfigValues(command: string): string[] {
  return Array.from(command.matchAll(/(?:^|\s)(?:-c|'-c') '([^']*)'/g), (match) => match[1]);
}

test('production Windows codex launches receive their computed lane MCP toolset', async () => {
  const fixture = installProviderCredentials();
  const agents = new Map<string, Agent>();
  const launches: WindowsLaunch[] = [];
  const findRealProviderBinary = patchDependencies(agents, launches, []);
  const supervisor = makeSupervisor();

  const cases = [
    { id: 'codex-supervisor', flags: { isSupervisor: true }, toolsets: 'orchestration,comms,observability-core,plans,browser-present,checkpoints,memory,migration', model: null },
    { id: 'codex-worker', flags: { isSupervised: true }, toolsets: 'comms,observability-core,browser-present,plans-read,memory', model: null },
    { id: 'codex-researcher', flags: { isResearcher: true }, toolsets: 'browser', model: RESEARCHER_CODEX_MODEL },
  ] as const;

  for (const item of cases) {
    const agent = makeAgent(item.id, {
      provider: 'codex', command: 'codex',
      workingDirectory: path.join(fixture, 'workspace', item.id),
      ...item.flags,
    });
    fs.mkdirSync(agent.workingDirectory, { recursive: true });
    agents.set(agent.id, agent);
    await launchWindows(supervisor, agent);
    const launch = launches.at(-1)!;
    const configs = configValues(launch.args);
    const rendered = JSON.stringify(launch.args);
    const childSpawn = executePtyHostSpawn(launch);

    assert.ok(configs.length >= 4,
      'REACHABILITY:mcp-injection-ungated-unreferenced codex MCP config must use repeatable -c arguments');
    assert.deepEqual(childSpawn.args, launch.args,
      'REACHABILITY:mcp-injection-ungated-unreferenced pty-host must preserve every codex argv byte');
    assert.equal(childSpawn.command, launch.command,
      'REACHABILITY:mcp-injection-ungated-unreferenced pty-host must spawn the resolved codex executable directly');
    assert.equal(launch.directSpawn, true,
      'REACHABILITY:mcp-injection-ungated-unreferenced codex dotted config must bypass cmd.exe');
    assert.equal(rendered.includes(FIXED_TOKEN), false, 'F9: token value must never enter codex argv');
    assert.ok(configs.includes('mcp_servers.agent-dashboard.env.DASHBOARD_MCP_TOOLSETS=' + JSON.stringify(item.toolsets)));
    assert.ok(configs.includes('mcp_servers.agent-dashboard.env_vars=["AGENT_DASHBOARD_API_TOKEN"]'));
    assert.ok(configs.some((value) => value.startsWith('mcp_servers.agent-dashboard.command=')));
    assert.ok(configs.some((value) => value.startsWith('mcp_servers.agent-dashboard.args=')));
    assert.equal(launch.extraEnv[TOKEN_ENV_NAME], FIXED_TOKEN, 'proxy token remains available through inherited env');
    assert.equal(launch.args.includes('--mcp-config'), false, 'codex must not receive Claude MCP flags');
    assert.equal(launch.args.includes('--strict-mcp-config'), false, 'codex has no strict MCP isolation flag');
    assert.equal(launch.args.includes('--strict-config'), false, '--strict-config is schema strictness, not MCP isolation');
    const modelIndex = launch.args.indexOf('--model');
    if (item.model) {
      assert.equal(launch.args[modelIndex + 1], item.model,
        'REACHABILITY:codex-researcher-model-pin Windows researcher must enter through the production launcher with its pinned model');
    } else {
      assert.equal(modelIndex, -1,
        `${item.id} must remain unaffected by the researcher-only model pin`);
    }
    assert.equal(configs.every((value) => value.startsWith('mcp_servers.agent-dashboard.')), true,
      'codex overrides add only the dashboard server and leave shared global MCP servers additive');
  }
  assert.equal(fs.existsSync(path.join(fixture, 'account', '.codex', 'config.toml')), false,
    'per-launch delivery must not write or replace the shared codex config');

  const explicitAgent = makeAgent('codex-researcher-explicit-model', {
    provider: 'codex', command: 'codex --model gpt-explicit', isResearcher: true,
    workingDirectory: path.join(fixture, 'workspace', 'codex-researcher-explicit-model'),
  });
  fs.mkdirSync(explicitAgent.workingDirectory, { recursive: true });
  agents.set(explicitAgent.id, explicitAgent);
  await launchWindows(supervisor, explicitAgent);
  const explicitModelArgs = launches.at(-1)!.args.filter((arg) => arg === '--model' || arg.startsWith('--model='));
  assert.deepEqual(explicitModelArgs, ['--model'], 'an explicit Windows --model must not receive a second model option');
  assert.equal(launches.at(-1)!.args[launches.at(-1)!.args.indexOf('--model') + 1], 'gpt-explicit');

  // Exercise Codex's actual config loader, not an absence-of-strict-flags proxy:
  // the shared server and the injected dashboard server must coexist.
  const liveCodexHome = path.join(fixture, 'codex-additive-home');
  fs.mkdirSync(liveCodexHome, { recursive: true });
  fs.writeFileSync(path.join(liveCodexHome, 'config.toml'), [
    '[mcp_servers.shared-global-fixture]',
    'command = "shared-command"',
    'args = ["shared-arg"]',
    '',
  ].join('\n'));
  const realCodexBinary = await findRealProviderBinary('codex');
  assert.ok(realCodexBinary, 'installed codex binary is required for the additive config acceptance check');
  const emittedConfigArgs: string[] = [];
  const lastArgs = launches.at(-1)!.args;
  for (let i = 0; i < lastArgs.length; i += 1) {
    if (lastArgs[i] === '-c') emittedConfigArgs.push('-c', lastArgs[i + 1]);
  }
  let codexCommand = realCodexBinary;
  let codexPrefixArgs: string[] = [];
  if (/\.cmd$/i.test(realCodexBinary)) {
    const codexJs = path.join(path.dirname(realCodexBinary), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    assert.equal(fs.existsSync(codexJs), true, `codex npm launcher target is missing: ${codexJs}`);
    codexCommand = process.execPath;
    codexPrefixArgs = [codexJs];
  }
  const listed = spawnSync(codexCommand, [...codexPrefixArgs, 'mcp', 'list', '--json', ...emittedConfigArgs], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: liveCodexHome, [TOKEN_ENV_NAME]: FIXED_TOKEN },
  });
  assert.equal(listed.status, 0, `codex mcp list failed: ${listed.error?.message ?? listed.stderr}`);
  const servers = JSON.parse(listed.stdout) as Array<{ name?: string }>;
  const names = servers.map((server) => server.name);
  assert.ok(names.includes('shared-global-fixture'), 'shared codex MCP server must survive per-launch overrides');
  assert.ok(names.includes('agent-dashboard'), 'injected dashboard MCP server must merge beside shared servers');
});

test('Windows codex MCP injection selects a native fallback but degrades safely for a shim-only install', async () => {
  const fixture = installProviderCredentials();

  {
    const agents = new Map<string, Agent>();
    const launches: WindowsLaunch[] = [];
    const customPrefix = path.join(fixture, 'custom-npm-prefix');
    const shim = path.join(customPrefix, 'codex.cmd');
    const vendorExe = path.join(customPrefix, 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
      'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    fs.mkdirSync(path.dirname(vendorExe), { recursive: true });
    fs.writeFileSync(shim, '@echo off\r\n');
    fs.writeFileSync(vendorExe, 'fixture');
    patchDependencies(agents, launches, [], {
      providerBinary: async () => shim,
      useRealNativeCodexBinary: true,
    });
    const agent = makeAgent('codex-native-fallback', {
      provider: 'codex', command: 'codex', isSupervised: true,
      workingDirectory: path.join(fixture, 'workspace', 'native-fallback'),
    });
    fs.mkdirSync(agent.workingDirectory, { recursive: true });
    agents.set(agent.id, agent);
    await launchWindows(makeSupervisor(), agent);
    const launch = launches.at(-1)!;
    assert.equal(launch.command, vendorExe);
    assert.equal(launch.directSpawn, true);
    assert.ok(configValues(launch.args).length > 0, 'native fallback must retain dashboard MCP injection');
    assert.deepEqual(executePtyHostSpawn(launch).args, launch.args,
      'native fallback must preserve dotted-config bytes through pty-host');
  }

  {
    const agents = new Map<string, Agent>();
    const launches: WindowsLaunch[] = [];
    patchDependencies(agents, launches, [], {
      providerBinary: async () => 'C:\\fixture\\npm\\codex.cmd',
      nativeCodexBinary: async () => null,
    });
    const agent = makeAgent('codex-shim-degraded', {
      provider: 'codex', command: 'codex', isSupervised: true,
      workingDirectory: path.join(fixture, 'workspace', 'shim-degraded'),
    });
    fs.mkdirSync(agent.workingDirectory, { recursive: true });
    agents.set(agent.id, agent);
    await launchWindows(makeSupervisor(), agent);
    const launch = launches.at(-1)!;
    assert.equal(launch.command, 'C:\\fixture\\npm\\codex.cmd', 'shim remains launchable');
    assert.equal(launch.directSpawn, false, 'shim must stay behind cmd.exe');
    assert.deepEqual(configValues(launch.args), [], 'corruptible MCP arguments must be omitted');
    const child = executePtyHostSpawn(launch);
    assert.equal(child.command.toLowerCase().endsWith('cmd.exe'), true, 'pty-host must use the wrapped shim path');
    assert.notEqual(agent.status, 'crashed', 'degraded MCP must not strand or crash the agent');
    assert.equal(launches.length, 1, 'shim-only Codex must still reach the runner launch seam');
    assert.equal(agent.dashboardMcpStatus, 'degraded', 'degradation must persist on the agent DTO');
    assert.match(agent.dashboardMcpMessage ?? '', /launching without dashboard tools/);
    assert.match(agent.dashboardMcpMessage ?? '', /official Windows installer/);
  }
});

test('production WSL codex researcher preserves MCP bytes on fresh launch and resume', async () => {
  installProviderCredentials();
  const agents = new Map<string, Agent>();
  const wslLaunches: string[] = [];
  patchDependencies(agents, [], wslLaunches);
  const agent = makeAgent('codex-researcher-wsl-mcp', {
    provider: 'codex', command: 'ccodex', isResearcher: true,
    workingDirectory: '/home/fixture/workspace/.lares/researcher/codex',
    tmuxSessionName: 'lares-codex-researcher-wsl-mcp',
  });
  agents.set(agent.id, agent);
  const supervisor = makeSupervisor() as unknown as {
    launchWslAgent: (value: Agent, resume?: boolean) => Promise<void>;
    resolveCodexResumeSessionId: () => string;
  };
  supervisor.resolveCodexResumeSessionId = () => CODEX_SESSION_ID;
  await supervisor.launchWslAgent(agent);
  await supervisor.launchWslAgent(agent, true);

  const freshCommand = wslLaunches.at(-2) ?? '';
  const resumeCommand = wslLaunches.at(-1) ?? '';
  assert.match(freshCommand, /-c 'mcp_servers\.agent-dashboard\.command=/,
    'REACHABILITY:mcp-injection-ungated-unreferenced WSL codex launch must carry dotted MCP config');
  const freshConfigs = shellConfigValues(freshCommand);
  const resumeConfigs = shellConfigValues(resumeCommand);
  assert.deepEqual(resumeConfigs, freshConfigs,
    'REACHABILITY:mcp-injection-ungated-unreferenced resume must preserve every fresh-launch MCP value byte');
  assert.match(resumeCommand, /'ccodex' 'resume'/, 'resume rewriter must still place the codex subcommand');
  assert.ok(resumeConfigs.includes('mcp_servers.agent-dashboard.env_vars=["AGENT_DASHBOARD_API_TOKEN"]'));
  assert.ok(resumeConfigs.includes('mcp_servers.agent-dashboard.env.DASHBOARD_MCP_TOOLSETS="browser"'));
  assert.equal(resumeCommand.includes(`'\\''`), false, 'resume MCP values must not carry a second shell-quote layer');
  assert.equal(JSON.stringify(resumeConfigs).includes(FIXED_TOKEN), false,
    'F9: token value must not enter WSL codex MCP argv');
  assert.ok(resumeCommand.lastIndexOf(`'${CODEX_SESSION_ID}'`) > resumeCommand.lastIndexOf(" '-c' "),
    'WSL resume keeps its established SID-last ordering after MCP injection');
  assert.match(freshCommand, new RegExp(`(?:^|\\s)--model ${RESEARCHER_CODEX_MODEL}(?:\\s|$)`),
    'REACHABILITY:codex-researcher-model-pin fresh WSL researcher must enter through the production launcher with its pinned model');
  assert.match(resumeCommand, new RegExp(`'--model' '${RESEARCHER_CODEX_MODEL}'`),
    'REACHABILITY:codex-researcher-model-pin resumed WSL researcher must retain its pinned model');
});

test('production WSL codex researcher preserves an explicit model override', async () => {
  installProviderCredentials();
  const agents = new Map<string, Agent>();
  const wslLaunches: string[] = [];
  patchDependencies(agents, [], wslLaunches);
  const agent = makeAgent('codex-researcher-wsl-explicit-model', {
    provider: 'codex', command: 'ccodex --model=gpt-explicit', isResearcher: true,
    workingDirectory: '/home/fixture/workspace/.lares/researcher/codex',
    tmuxSessionName: 'lares-codex-researcher-wsl-explicit-model',
  });
  agents.set(agent.id, agent);
  await (makeSupervisor() as unknown as { launchWslAgent: (value: Agent) => Promise<void> }).launchWslAgent(agent);

  const command = wslLaunches.at(-1) ?? '';
  assert.equal((command.match(/--model(?:=|\s)/g) ?? []).length, 1,
    'an explicit WSL --model must not receive a second model option');
  assert.match(command, /--model=gpt-explicit/);
  assert.doesNotMatch(command, new RegExp(`--model ${RESEARCHER_CODEX_MODEL}`));
});

test('Claude worker argv matches the captured f4ca7231 baseline bytes', async () => {
  const fixture = installProviderCredentials();
  const agents = new Map<string, Agent>();
  const launches: WindowsLaunch[] = [];
  patchDependencies(agents, launches, []);
  const agent = makeAgent('claude-worker-baseline', {
    provider: 'claude', command: 'claude --dangerously-skip-permissions',
    isWorker: true, workingDirectory: path.join(fixture, 'workspace', 'claude-worker'),
  });
  fs.mkdirSync(agent.workingDirectory, { recursive: true });
  agents.set(agent.id, agent);
  await launchWindows(makeSupervisor(), agent);

  const scriptPath = path.join(process.cwd(), 'scripts', 'mcp-dashboard.js').replace(/\\/g, '/');
  const escapedExecPath = JSON.stringify(process.execPath).slice(1, -1);
  const syspromptPath = path.join(agent.workingDirectory, '.claude', `.sysprompt-${agent.id}.txt`);
  const normalizedActual = launches.at(-1)!.args.map((arg) => arg
    .replaceAll(escapedExecPath, '<EXEC>')
    .replaceAll(scriptPath, '<SCRIPT>')
    .replaceAll(syspromptPath, '<SYSPROMPT>')
    .replaceAll(agent.workingDirectory, '<WORKDIR>'));
  // Captured from the landed WP-1 tree before WP-3 edits. Only machine/temp
  // paths are normalized; the argument order and every config byte are frozen.
  const capturedBaseline = [
    '--dangerously-skip-permissions',
    '--mcp-config', '{"mcpServers":{"agent-dashboard":{"command":"<EXEC>","args":["<SCRIPT>"],"env":{"AGENT_DASHBOARD_SELF_ID":"claude-worker-baseline","AGENT_DASHBOARD_WORKSPACE_ID":"ws-1","ELECTRON_RUN_AS_NODE":"1","DASHBOARD_MCP_TOOLSETS":"comms,observability-core,browser-present,plans-read,memory","AGENT_DASHBOARD_API_PORT":"24678","AGENT_DASHBOARD_API_TOKEN":"WP3_SECRET_TOKEN_VALUE"}}}}',
    '--strict-mcp-config',
    '--model', 'claude-opus-4-8',
    '--add-dir', '<WORKDIR>',
    '--append-system-prompt-file', '<SYSPROMPT>',
  ];
  assert.deepEqual(normalizedActual, capturedBaseline,
    `Claude argv changed from captured f4ca7231 baseline:\n${JSON.stringify(normalizedActual)}`);
});
