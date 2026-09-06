import assert from 'node:assert/strict';
import { AgentSupervisor } from './index';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import { __setWslEnabledForTest, WSL_DISABLED_MESSAGE } from '../wsl-enabled';
import type { Agent } from '../../shared/types';

const source = makeAgent('wsl-source', {
  workspaceId: 'wsl-workspace',
  provider: 'claude',
  command: 'claude',
  workingDirectory: '/home/test/project',
  tmuxSessionName: 'lares_wsl_source',
  resumeSessionId: '11111111-1111-4111-8111-111111111111',
  status: 'crashed',
  autoRestartEnabled: true,
});

const database = require('../database') as Record<string, unknown>;
const keys = ['getAgent', 'getWorkspace', 'createAgent', 'incrementRestartCount', 'getTeamMembership'];
const original = Object.fromEntries(keys.map((key) => [key, database[key]]));
let createCalls = 0;
let restartIncrements = 0;
database.getAgent = (id: string) => id === source.id ? source : null;
database.getWorkspace = () => ({ id: 'wsl-workspace', path: '/home/test/project', pathType: 'wsl' });
database.createAgent = () => { createCalls++; throw new Error('createAgent must not run while WSL is disabled'); };
database.incrementRestartCount = () => { restartIncrements++; };
database.getTeamMembership = () => null;

const supervisor = new AgentSupervisor();
(supervisor as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
(supervisor as unknown as { reclaimTerminalCheckpoint: () => void }).reclaimTerminalCheckpoint = () => {};
const warnings: unknown[][] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args); };

(async () => {
  try {
    __setWslEnabledForTest(false);

    await assert.rejects(
      () => (supervisor as unknown as { launchWslAgent: (agent: Agent) => Promise<void> }).launchWslAgent(source),
      (error: Error & { statusCode?: number }) =>
        error.message === WSL_DISABLED_MESSAGE && error.statusCode === 409,
      'the WslRunner construction choke point must refuse while disabled',
    );
    assert.equal(
      (supervisor as unknown as { wslRunners: Map<string, unknown> }).wslRunners.has(source.id),
      false,
      'spawn-point refusal happens before a runner enters the live map',
    );

    await assert.rejects(
      () => supervisor.restartAgent(source.id),
      (error: Error & { statusCode?: number }) =>
        error.message === WSL_DISABLED_MESSAGE && error.statusCode === 409,
      'restart must reject at supervisor admission before stopping or relaunching',
    );
    assert.equal(source.status, 'crashed');

    await assert.rejects(
      () => supervisor.forkAgent(source.id),
      (error: Error & { statusCode?: number }) =>
        error.message === WSL_DISABLED_MESSAGE && error.statusCode === 409,
      'fork must reject before creating its agent row',
    );
    assert.equal(createCalls, 0, 'a refused fork leaves no launching agent row');

    const autoRestart = (supervisor as unknown as { handleAutoRestart: (agent: Agent) => Promise<void> })
      .handleAutoRestart.bind(supervisor);
    await autoRestart(source);
    await autoRestart(source);
    assert.equal(restartIncrements, 0, 'disabled WSL does not enter the auto-restart loop');
    assert.equal(source.status, 'crashed');
    assert.equal(
      warnings.filter((args) => String(args[0]).includes('auto-restart disabled for WSL agent')).length,
      1,
      'repeated crash signals log the disabled auto-restart refusal once',
    );

    console.log('wsl-spawn-gate: 4/4 passed');
    console.log('REACHABILITY:wsl-spawn-gate restart/fork/auto-restart entered through AgentSupervisor');
  } finally {
    __setWslEnabledForTest(null);
    console.warn = originalWarn;
    for (const key of keys) database[key] = original[key];
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
