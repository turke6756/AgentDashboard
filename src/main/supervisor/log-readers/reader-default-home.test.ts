import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { Agent, AgentStatus } from '../../../shared/types';
import { createParseManagerDeps } from '../../skill-analytics/parse-manager-factory';
import { AgentSupervisor } from '../index';
import { WindowsRunner } from '../windows-runner';
import { makeAgent } from '../test-helpers/fake-bridge-deps';
import { makeClaudeProjectSlug, ClaudeJsonlReader } from './claude-jsonl-reader';
import { __setWslHomeDiscovererForTest } from './types';

const MARKER = 'REACHABILITY:reader-default-home-unreferenced';
const cleanups: Array<() => void> = [];

afterEach(() => {
  __setWslHomeDiscovererForTest(null);
  while (cleanups.length > 0) cleanups.pop()!();
});

function patchProductionEdges(agents: Map<string, Agent>): void {
  const db = require('../../database') as Record<string, unknown>;
  const dbKeys = [
    'updateAgentStatus', 'applyStatusTransition', 'updateAgentHookStatus',
    'updateAgentDashboardMcpStatus', 'updateAgentPid', 'getAgent', 'addEvent',
    'updateAgentLastOutput', 'updateAgentExitCode', 'getActiveAgents', 'getAllAgents',
    'getSupervisorAgent', 'addFileActivity', 'updateAgentResumeSessionId',
    'getTeamMembership', 'getAgentTemplate', 'getCurrentBrick', 'getDb', 'getWorkspaces',
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
  // The production dispatcher reads the database's active-agent projection.
  // Keep that I/O edge fake, but do not expose a fixture until the real launch
  // path has transitioned it to `launching`.
  db.getActiveAgents = () => Array.from(agents.values()).filter((agent) => agent.status === 'launching');
  db.getAllAgents = () => Array.from(agents.values());
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;
  db.updateAgentResumeSessionId = () => {};
  db.getTeamMembership = () => null;
  db.getAgentTemplate = () => null;
  db.getCurrentBrick = () => null;
  db.getDb = () => ({});
  db.getWorkspaces = () => [];

  const discovery = require('../session-id-discovery') as Record<string, unknown>;
  const originalDiscovery = discovery.shouldDiscoverCodexSession;
  discovery.shouldDiscoverCodexSession = () => false;

  const resolver = require('../provider-resolver') as Record<string, unknown>;
  const originalFindClaude = resolver.findWindowsClaudePath;
  const originalProbe = resolver.probeWindowsProvider;
  resolver.findWindowsClaudePath = async () => 'C:\\fixture\\bin\\claude.exe';
  resolver.probeWindowsProvider = async () => true;

  const originalLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (this: WindowsRunner) {
    (this as unknown as { _pid: number; _alive: boolean })._pid = 4242;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };

  cleanups.push(() => {
    (WindowsRunner.prototype as { launch: unknown }).launch = originalLaunch;
    resolver.findWindowsClaudePath = originalFindClaude;
    resolver.probeWindowsProvider = originalProbe;
    discovery.shouldDiscoverCodexSession = originalDiscovery;
    for (const [key, value] of originalDb) db[key] = value;
  });
}

function writeClaudeTurn(accountHome: string, agent: Agent, text: string): void {
  const projectDir = path.join(
    accountHome,
    '.claude',
    'projects',
    makeClaudeProjectSlug(agent.workingDirectory),
  );
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${agent.resumeSessionId}.jsonl`), `${JSON.stringify({
    uuid: `entry-${agent.id}`,
    type: 'user',
    timestamp: '2026-08-15T12:00:00.000Z',
    message: { content: text },
  })}\n`);
}

test('real launch, reader, analytics, skills, and spool seams use one default home for researcher and worker', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-reader-default-home-'));
  cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const accountHome = path.join(fixture, 'account');
  const appData = path.join(fixture, 'appdata');
  const workspace = path.join(fixture, 'workspace');
  fs.mkdirSync(path.join(accountHome, '.claude', 'skills', 'shared-skill'), { recursive: true });
  fs.writeFileSync(path.join(accountHome, '.claude', '.credentials.json'), '{}\n');
  fs.mkdirSync(path.join(workspace, '.lares'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.lares', 'pending-status.jsonl'), '');

  const previousEnv = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    APPDATA: process.env.APPDATA,
  };
  process.env.USERPROFILE = accountHome;
  process.env.HOME = accountHome;
  process.env.APPDATA = appData;
  cleanups.push(() => {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  __setWslHomeDiscovererForTest(() => null);

  const worker = makeAgent('reader-worker', {
    provider: 'claude', command: 'claude', isWorker: true, isSupervised: true,
    workingDirectory: path.join(workspace, '.lares', 'workers', 'claude'),
    resumeSessionId: '11111111-1111-4111-8111-111111111111',
  });
  const researcher = makeAgent('reader-researcher', {
    provider: 'claude', command: 'claude', isWorker: false, isSupervised: false,
    isResearcher: true,
    workingDirectory: path.join(workspace, '.lares', 'researcher', 'claude'),
    resumeSessionId: '22222222-2222-4222-8222-222222222222',
  });
  fs.mkdirSync(worker.workingDirectory, { recursive: true });
  fs.mkdirSync(researcher.workingDirectory, { recursive: true });
  writeClaudeTurn(accountHome, worker, 'worker-default-home-turn');
  writeClaudeTurn(accountHome, researcher, 'researcher-default-home-turn');

  const agents = new Map<string, Agent>([[worker.id, worker], [researcher.id, researcher]]);
  patchProductionEdges(agents);
  const supervisor = new AgentSupervisor();
  const privateSupervisor = supervisor as unknown as {
    writeAgentRegistry: () => void;
    healLegacyStateDirScaffold: () => void;
    launchWindowsAgent: (agent: Agent) => Promise<void>;
    spoolTailers: Map<string, { readPath: string }>;
    sessionLogReader: {
      pollNow: (agentId?: string) => void;
      getCachedEvents: (agentId: string) => { events: Array<{ type: string; text?: string }> };
    };
  };
  privateSupervisor.writeAgentRegistry = () => {};
  privateSupervisor.healLegacyStateDirScaffold = () => {};

  privateSupervisor.sessionLogReader.pollNow();
  assert.equal(privateSupervisor.sessionLogReader.getCachedEvents(worker.id).events.length, 0,
    'the stubbed active-agent projection must not expose the worker before launch');
  assert.equal(privateSupervisor.sessionLogReader.getCachedEvents(researcher.id).events.length, 0,
    'the stubbed active-agent projection must not expose the researcher before launch');

  await privateSupervisor.launchWindowsAgent(worker);
  await privateSupervisor.launchWindowsAgent(researcher);

  assert.equal(privateSupervisor.spoolTailers.size, 1,
    `${MARKER} researcher and worker must tail one workspace spool`);
  const [tailer] = privateSupervisor.spoolTailers.values();
  assert.equal(tailer.readPath, path.join(workspace, '.lares', 'pending-status.jsonl'),
    `${MARKER} production ensureSpoolTailer must read the workspace spool`);

  privateSupervisor.sessionLogReader.pollNow(worker.id);
  privateSupervisor.sessionLogReader.pollNow(researcher.id);
  const workerEvents = privateSupervisor.sessionLogReader.getCachedEvents(worker.id).events;
  const researcherEvents = privateSupervisor.sessionLogReader.getCachedEvents(researcher.id).events;
  assert.ok(workerEvents.some((event) => event.type === 'user-text' && event.text === 'worker-default-home-turn'),
    `${MARKER} worker transcript must resolve from the default account home`);
  assert.ok(researcherEvents.some((event) => event.type === 'user-text' && event.text === 'researcher-default-home-turn'),
    `${MARKER} researcher transcript must resolve from the same default account home`);

  const parseDeps = createParseManagerDeps();
  assert.ok(parseDeps.knownSkills.has('shared-skill'),
    `${MARKER} production parse-manager factory must scan skills from the default account home`);
  const streamIds = parseDeps.listStreams().map((stream) => stream.sessionId);
  assert.ok(streamIds.includes(worker.resumeSessionId!) && streamIds.includes(researcher.resumeSessionId!),
    `${MARKER} production analytics scanner must see worker and researcher transcripts in one default corpus`);
});

test('Claude reader ignores a reappearing runtime per-agent-home property', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-reader-no-override-'));
  cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = fixture;
  cleanups.push(() => {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  });
  __setWslHomeDiscovererForTest(() => null);

  const workingDirectory = path.join(fixture, 'workspace');
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const defaultProject = path.join(fixture, '.claude', 'projects', makeClaudeProjectSlug(workingDirectory));
  const privateHome = path.join(fixture, 'workspace', '.lares', 'agent-homes', 'reader-researcher');
  const privateProject = path.join(privateHome, 'projects', makeClaudeProjectSlug(workingDirectory));
  fs.mkdirSync(defaultProject, { recursive: true });
  fs.mkdirSync(privateProject, { recursive: true });
  const record = (text: string) => `${JSON.stringify({
    uuid: `entry-${text}`,
    type: 'user',
    timestamp: '2026-08-15T12:00:00.000Z',
    message: { content: text },
  })}\n`;
  fs.writeFileSync(path.join(defaultProject, `${sessionId}.jsonl`), record('default-home'));
  fs.writeFileSync(path.join(privateProject, `${sessionId}.jsonl`), record('private-home'));

  const events = new ClaudeJsonlReader().pollSession({
    agentId: 'runtime-extra-property',
    sessionId,
    workingDirectory,
    provider: 'claude',
    subscribed: true,
    providerStateHome: privateHome,
  } as Parameters<ClaudeJsonlReader['pollSession']>[0] & { providerStateHome: string });
  assert.ok(events.some((event) => event.type === 'user-text' && event.text === 'default-home'),
    `${MARKER} reader must use the default account home`);
  assert.ok(!events.some((event) => event.type === 'user-text' && event.text === 'private-home'),
    `${MARKER} reader must have no branch that follows a per-agent home`);
});
