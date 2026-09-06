import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ApiServer } from '../api-server';
import { closeDatabaseForTests, createWorkspace, getAgentsByWorkspace, initDatabase } from '../database';
import { agentCapabilities } from '../security/agent-capabilities';
import { AgentSupervisor, roleLaneOf } from './index';
import { toolsetsForLane } from './mcp-config-builder';
import { WindowsRunner } from './windows-runner';
import type { Agent, AgentRoleLane } from '../../shared/types';

interface IdentityContext {
  workspaceId: string | null;
  supervisor: Agent | null;
  asserted: boolean;
  projectId: string | null;
  supervisorId: string | null;
}

const UNASSERTED: IdentityContext = {
  workspaceId: null, supervisor: null, asserted: false, projectId: null, supervisorId: null,
};

async function callLaunch(api: ApiServer, body: unknown): Promise<Agent> {
  const pathname = '/api/agents';
  const request = new http.IncomingMessage(null as any);
  request.method = 'POST';
  request.url = pathname;
  process.nextTick(() => {
    request.emit('data', Buffer.from(JSON.stringify(body)));
    request.emit('end');
  });
  return (api as unknown as {
    route: (method: string, url: URL, request: http.IncomingMessage, identity: IdentityContext) => Promise<Agent>;
  }).route('POST', new URL(pathname, 'http://127.0.0.1:24682'), request, UNASSERTED);
}

async function run(): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-peer-provider-'));
  const fakeBin = path.join(workspacePath, 'bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'codex.exe'), '');
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ''}`;

  const originalAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(workspacePath, 'appdata');
  initDatabase();
  const workspace = createWorkspace({ title: 'Peer route fixture', path: workspacePath, pathType: 'windows' });
  const originalRunnerLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
  let runnerCwd: string | null = null;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner, cwd: string,
  ) {
    runnerCwd = cwd;
    (this as unknown as { _pid: number; _alive: boolean })._pid = 4242;
    (this as unknown as { _alive: boolean })._alive = true;
  };

  const supervisor = new AgentSupervisor();
  const mutable = supervisor as unknown as Record<string, any>;
  let injectedLane: AgentRoleLane | null = null;
  let injectedToolsets: string | null = null;
  mutable.writeAgentRegistry = () => {};
  mutable.reclaimTerminalCheckpoint = () => {};
  mutable.ensureSpoolTailer = () => {};
  mutable.healLegacyStateDirScaffold = () => {};
  mutable.setupFileTracker = () => null;
  mutable.sweepStaleSyspromptFiles = () => {};
  mutable.buildContinuationBrickBlock = () => '';
  mutable.stageSupervisorMemoryInjection = () => {};
  mutable.computeSupervisorMemoryInjectText = () => '';
  mutable.ensureWorkspaceScripts = () => {};
  mutable.ensureSupervisorScaffold = () => {};
  mutable.ensureWorkerScaffold = () => {};
  mutable.ensureResearchStoreScaffold = () => {};
  mutable.ensureProviderDirTrust = () => {};
  mutable.retireStaleRootMcpConfig = () => {};
  mutable.loadAgentMd = () => null;
  mutable.mintAgentCapabilityToken = () => 'peer-capability-token';
  mutable.captureCodexSessionId = () => {};
  mutable.codexLaunchGate = { acquire: async () => ({ waitedMs: 0, queuedBehind: 0, release: () => {} }) };
  mutable.buildDashboardMcpConfigForLane = (lane: AgentRoleLane) => {
    injectedLane = lane;
    injectedToolsets = toolsetsForLane(lane);
    return JSON.stringify({ mcpServers: {} });
  };
  (mutable.monitor as Record<string, unknown>).recordHookCanary = () => {};
  (mutable.monitor as Record<string, unknown>).recordLaunch = () => {};

  agentCapabilities.clear();
  try {
    const agent = await callLaunch(new ApiServer(supervisor, 24682), {
      workspaceId: workspace.id,
      title: 'Codex Peer',
      provider: 'codex',
      mode: 'supervisor-peer',
    });
    const expectedCwd = path.join(workspacePath, '.lares', 'supervisor', 'codex');
    assert.equal(agent.provider, 'codex', 'REACHABILITY:supervisor-peer-provider');
    assert.equal(agent.workingDirectory, expectedCwd, 'REACHABILITY:supervisor-peer-provider');
    assert.equal(runnerCwd, expectedCwd, 'the runner receives the provider-specific supervisor cwd');
    assert.equal(getAgentsByWorkspace(workspace.id).length, 1, 'the real route creates exactly one supervisor peer');
    assert.equal(roleLaneOf(agent), 'supervisor');
    assert.equal(injectedLane, 'supervisor', 'the real launch preparation selects the supervisor lane');
    assert.equal(injectedToolsets, toolsetsForLane('supervisor'), 'the peer receives the supervisor toolset');
    console.log('  ok  codex supervisor-peer route resolves provider cwd and supervisor toolset');
    console.log('\n1 passed, 0 failed');
  } finally {
    (WindowsRunner.prototype as { launch: unknown }).launch = originalRunnerLaunch;
    closeDatabaseForTests();
    agentCapabilities.clear();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('  FAIL codex supervisor-peer route resolves provider cwd and supervisor toolset');
  console.error('       ', error instanceof Error ? error.stack || error.message : error);
  console.error('\n0 passed, 1 failed');
  process.exit(1);
});
