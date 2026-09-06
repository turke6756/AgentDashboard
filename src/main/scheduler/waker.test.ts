import assert from 'node:assert/strict';
import type { AgentProvider, AgentStatus } from '../../shared/types';
import type { ScheduledDeliveryResult, ScheduledFiring } from './agent-scheduler';
import { wakeScheduledFiring, type StagedFiring } from './waker';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

function firing(events: string[], generation = 7): ScheduledFiring {
  return {
    agentId: 'agent-1', scheduleId: 'schedule-1', text: 'wake me', dueAt: 123, generation,
    markReviving: () => { events.push('mark-reviving'); },
    markDelivering: () => { events.push('mark-delivering'); },
    finalizeFailure: (reason) => { events.push(`failed:${reason}`); },
  };
}

function depsFor(
  events: string[],
  provider: AgentProvider,
  status: AgentStatus,
  revive: () => Promise<unknown> = async () => {},
) {
  let staged: StagedFiring | null = null;
  return {
    get staged(): StagedFiring | null { return staged; },
    deps: {
      getAgent: () => ({ provider, status }),
      stage: (_agentId: string, value: StagedFiring) => { staged = value; events.push('stage'); },
      clearGeneration: (_agentId: string, generation: number) => {
        if (staged?.generation === generation) staged = null;
        events.push(`clear:${generation}`);
      },
      reviveAgent: (_agentId: string) => { events.push('revive'); return revive(); },
    },
  };
}

test('terminal Claude stages and marks reviving before reviveAgent', async () => {
  const events: string[] = [];
  let releaseRevive!: () => void;
  const h = depsFor(events, 'claude', 'done', () => new Promise<void>((resolve) => { releaseRevive = resolve; }));
  const result = wakeScheduledFiring(firing(events), h.deps);
  assert.ok(result instanceof Promise);
  assert.deepEqual(events, ['stage', 'mark-reviving', 'revive']);
  assert.ok(h.staged);
  h.staged!.onOutcome({ disposition: 'held' });
  assert.deepEqual(await result, { disposition: 'held' });
  releaseRevive();
});

test('revive rejection clears only the staged generation and finalizes revive-failed', async () => {
  const events: string[] = [];
  const h = depsFor(events, 'codex', 'crashed', async () => { throw new Error('no relaunch'); });
  const result = wakeScheduledFiring(firing(events, 11), h.deps);
  assert.ok(result instanceof Promise);
  assert.deepEqual(await result, { disposition: 'held' });
  assert.equal(h.staged, null);
  assert.deepEqual(events, ['stage', 'mark-reviving', 'revive', 'clear:11', 'failed:revive-failed']);
});

for (const provider of ['grok', 'agy', 'gemini'] as const) {
  test(`${provider} terminal firing fails without calling reviveAgent`, () => {
    const events: string[] = [];
    const h = depsFor(events, provider, 'done');
    const result = wakeScheduledFiring(firing(events), h.deps);
    assert.deepEqual(result, { disposition: 'held' });
    assert.deepEqual(events, ['failed:provider-no-revive']);
    assert.equal(h.staged, null);
  });
}

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed += 1; }
    catch (err) { console.error(`  FAIL  ${t.name}`); console.error(err); failed += 1; }
  }
  console.log(`waker.test: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
