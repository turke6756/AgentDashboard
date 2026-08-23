// WP-11 provider delivery gates. Runs from scripts/run-main-tests.mjs after a
// fresh main build and enters all three production call sites in index.ts.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentSupervisor } from './index';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import type { Agent, AgentProvider, AgentStatus, LaunchAgentInput, Workspace } from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

type Pending = Map<string, { text: string; expiresAt: number }>;
type PrivateSupervisor = {
  pendingInitialPrompts: Pending;
  computeSupervisorMemoryInjectText(agent: Agent): string;
  launchWindowsAgent(agent: Agent, resume?: boolean): Promise<void>;
  launchWslAgent(agent: Agent, resume?: boolean): Promise<void>;
  [key: string]: unknown;
};

const NON_CLAUDE: AgentProvider[] = ['codex', 'grok', 'agy'];
const MEMORY = 'PROJECTED-MEMORY';
const BASE = 'BASE-PROMPT';
const DOWNSTREAM = new Error('WP11 downstream stop');

function patchDb(agents: Map<string, Agent>, workspace: Workspace): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'updateAgentStatus', 'applyStatusTransition', 'updateAgentHookStatus',
    'updateAgentLastSendError', 'updateAgentPid', 'getAgent', 'addEvent',
    'updateAgentLastOutput', 'updateAgentExitCode', 'getActiveAgents',
    'getAllAgents', 'getSupervisorAgent', 'addFileActivity', 'getFileActivities',
    'getWorkspace', 'createAgent', 'getTeamMembership',
    'updateAgentResumeSessionId', 'insertAgentSession', 'closeAgentSession',
  ];
  const original: Record<string, unknown> = {};
  for (const key of keys) original[key] = db[key];

  let seq = 0;
  db.updateAgentStatus = (id: string, status: AgentStatus) => {
    const agent = agents.get(id);
    if (agent) agent.status = status;
  };
  db.updateAgentHookStatus = () => {};
  db.updateAgentLastSendError = () => {};
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => agents.get(id) ?? null;
  db.addEvent = () => {};
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => Array.from(agents.values());
  db.getAllAgents = () => Array.from(agents.values());
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;
  db.getFileActivities = () => [];
  db.getWorkspace = (id: string) => id === workspace.id ? workspace : null;
  db.getTeamMembership = () => null;
  db.updateAgentResumeSessionId = () => {};
  db.insertAgentSession = () => {};
  db.closeAgentSession = () => {};
  db.createAgent = (data: Record<string, unknown>): Agent => {
    const id = `wp11-${++seq}`;
    const agent = makeAgent(id, {
      workspaceId: String(data.workspaceId),
      title: String(data.title),
      provider: data.provider as AgentProvider,
      isSupervisor: !!data.isSupervisor,
      isSupervised: !!data.isSupervised,
      isWorker: !!data.isWorker,
      workingDirectory: String(data.workingDirectory),
      command: String(data.command),
      status: 'launching',
    });
    agents.set(id, agent);
    return agent;
  };
  patchApplyStatusTransition(db);

  return () => { for (const key of keys) db[key] = original[key]; };
}

interface Harness {
  supervisor: AgentSupervisor;
  priv: PrivateSupervisor;
  agents: Map<string, Agent>;
  workspace: Workspace;
  computeCalls: AgentProvider[];
  cleanup(): void;
}

function setup(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp11-launch-'));
  const workspace: Workspace = {
    id: `ws-${path.basename(root)}`,
    title: 'WP11',
    path: root,
    pathType: 'windows',
    description: '',
    defaultCommand: 'claude',
    createdAt: '2026-08-22T00:00:00Z',
    updatedAt: '2026-08-22T00:00:00Z',
    lastOpenedAt: null,
  };
  const agents = new Map<string, Agent>();
  const restoreDb = patchDb(agents, workspace);
  const supervisor = new AgentSupervisor();
  const priv = supervisor as unknown as PrivateSupervisor;
  const computeCalls: AgentProvider[] = [];

  priv.writeAgentRegistry = () => {};
  priv.ensureProviderDirTrust = () => {};
  priv.ensureSupervisorScaffold = () => {};
  priv.ensureResearchStoreScaffold = () => {};
  priv.ensureWorkspaceScripts = () => {};
  priv.retireStaleRootMcpConfig = () => {};
  priv.loadAgentMd = () => null;
  priv.launchWindowsAgent = async () => {};
  priv.computeSupervisorMemoryInjectText = (agent: Agent) => {
    computeCalls.push(agent.provider);
    return MEMORY;
  };

  return {
    supervisor, priv, agents, workspace, computeCalls,
    cleanup: () => {
      restoreDb();
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

function launchInput(h: Harness, provider: AgentProvider): LaunchAgentInput {
  return {
    workspaceId: h.workspace.id,
    title: `${provider} supervisor`,
    provider: provider as Exclude<AgentProvider, 'gemini'>,
    command: provider,
    isSupervisor: true,
    initialUserPrompt: BASE,
    autoRestartEnabled: false,
  };
}

function directAgent(h: Harness, provider: AgentProvider, pathType: 'windows' | 'wsl'): Agent {
  const id = `${pathType}-${provider}`;
  const agent = makeAgent(id, {
    workspaceId: h.workspace.id,
    provider,
    isSupervisor: true,
    workingDirectory: pathType === 'wsl' ? '/tmp/wp11' : h.workspace.path,
    command: provider,
    tmuxSessionName: pathType === 'wsl' ? `wp11-${provider}` : null,
    status: 'restarting',
  });
  h.agents.set(id, agent);
  return agent;
}

test('fresh launch stages memory on pendingInitialPrompts for grok, agy, and codex', async () => {
  for (const provider of NON_CLAUDE) {
    const h = setup();
    try {
      const agent = await h.supervisor.launchAgent(launchInput(h, provider));
      assert.equal(h.priv.pendingInitialPrompts.get(agent.id)?.text, `${MEMORY}\n\n${BASE}`,
        `${provider}: fresh call site composes memory ahead of the initial prompt`);
      assert.deepEqual(h.computeCalls, [provider], `${provider}: production staging seam executed once`);
    } finally { h.cleanup(); }
  }
});

test('fresh Claude launch keeps its pending user prompt and does not enter the staging seam', async () => {
  const h = setup();
  try {
    const agent = await h.supervisor.launchAgent(launchInput(h, 'claude'));
    assert.equal(h.priv.pendingInitialPrompts.get(agent.id)?.text, BASE);
    assert.deepEqual(h.computeCalls, [], 'Claude remains on its append-system-prompt-file route');
  } finally { h.cleanup(); }
});

test('Windows resume stages memory for grok, agy, and codex before downstream launch work', async () => {
  const launchWindowsAgent = (AgentSupervisor.prototype as unknown as PrivateSupervisor).launchWindowsAgent;
  for (const provider of NON_CLAUDE) {
    const h = setup();
    try {
      const agent = directAgent(h, provider, 'windows');
      h.priv.mintAgentCapabilityToken = () => 'token';
      h.priv.reclaimTerminalCheckpoint = () => { throw DOWNSTREAM; };
      await assert.rejects(() => launchWindowsAgent.call(h.supervisor, agent, true), DOWNSTREAM);
      assert.equal(h.priv.pendingInitialPrompts.get(agent.id)?.text, MEMORY,
        `${provider}: Windows resume call site staged the projected memory`);
      assert.deepEqual(h.computeCalls, [provider]);
    } finally { h.cleanup(); }
  }
});

test('Windows Claude resume does not stage memory', async () => {
  const launchWindowsAgent = (AgentSupervisor.prototype as unknown as PrivateSupervisor).launchWindowsAgent;
  const h = setup();
  try {
    const agent = directAgent(h, 'claude', 'windows');
    h.priv.mintAgentCapabilityToken = () => 'token';
    h.priv.reclaimTerminalCheckpoint = () => { throw DOWNSTREAM; };
    await assert.rejects(() => launchWindowsAgent.call(h.supervisor, agent, true), DOWNSTREAM);
    assert.equal(h.priv.pendingInitialPrompts.has(agent.id), false);
    assert.deepEqual(h.computeCalls, []);
  } finally { h.cleanup(); }
});

test('WSL resume enters staging for grok and agy before their unchanged transport refusals', async () => {
  for (const provider of ['grok', 'agy'] as const) {
    const h = setup();
    try {
      const agent = directAgent(h, provider, 'wsl');
      await assert.rejects(() => h.priv.launchWslAgent(agent, true), /not yet supported in WSL workspaces/);
      assert.equal(h.priv.pendingInitialPrompts.get(agent.id)?.text, MEMORY,
        `${provider}: WSL resume call site is reached before transport refusal`);
      assert.deepEqual(h.computeCalls, [provider]);
    } finally { h.cleanup(); }
  }
});

test('WSL resume stages Codex and leaves Claude on its unchanged splice behavior', async () => {
  for (const provider of ['codex', 'claude'] as const) {
    const h = setup();
    try {
      const agent = directAgent(h, provider, 'wsl');
      h.priv.mintAgentCapabilityToken = () => 'token';
      h.priv.reclaimTerminalCheckpoint = () => { throw DOWNSTREAM; };
      await assert.rejects(() => h.priv.launchWslAgent(agent, true));
      assert.equal(h.priv.pendingInitialPrompts.has(agent.id), provider === 'codex',
        `${provider}: WSL resume provider behavior remains unchanged`);
      assert.deepEqual(h.computeCalls, provider === 'codex' ? ['codex'] : []);
    } finally { h.cleanup(); }
  }
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const item of tests) {
    try { await item.run(); console.log(`  ok  ${item.name}`); passed++; }
    catch (error) {
      console.error(`  FAIL ${item.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed++;
    }
  }
  console.log(`\nsupervisor launch-injection: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
