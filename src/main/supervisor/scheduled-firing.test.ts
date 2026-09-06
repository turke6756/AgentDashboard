import assert from 'node:assert/strict';
import { AgentSupervisor } from './index';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import type { Agent, SendOutcome } from '../../shared/types';
import type { ScheduledDeliveryResult, ScheduledFiring } from '../scheduler/agent-scheduler';
import type { StagedFiring } from '../scheduler/waker';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

function makeFiring(overrides: Partial<ScheduledFiring> = {}): ScheduledFiring {
  return {
    agentId: 'cron-agent', scheduleId: 'cron-schedule', text: '  original\r\nbytes  ',
    dueAt: 100, generation: 3,
    markReviving: () => {}, markDelivering: () => {}, finalizeFailure: () => {},
    ...overrides,
  };
}

function confirmed(agentId: string): SendOutcome {
  return {
    disposition: 'confirmed', agentId, delivered: true,
    confirmationSource: 'status', completedAt: 500,
  };
}

async function withSupervisor(fn: (supervisor: AgentSupervisor, agent: Agent) => Promise<void> | void): Promise<void> {
  const agents = new Map<string, Agent>();
  const agent = makeAgent('cron-agent', { status: 'idle', isSupervised: false });
  agents.set(agent.id, agent);
  const supervisor = new AgentSupervisor({ scheduledGetAgent: (id) => agents.get(id) ?? null });
  (supervisor as unknown as { writeAgentRegistry: unknown }).writeAgentRegistry = () => {};
  const bridge = (supervisor as unknown as { bridge: { resolveScheduledNotificationRoute: unknown } }).bridge;
  bridge.resolveScheduledNotificationRoute = () => ({ route: 'unavailable', subscriberAgentId: null });
  const runners = (supervisor as unknown as { windowsRunners: Map<string, unknown> }).windowsRunners;
  runners.set(agent.id, {});
  await fn(supervisor, agent);
}

test('REACHABILITY:cron-deliver enters deliverScheduledFiring and sends the framed original bytes', async () => {
  await withSupervisor(async (supervisor) => {
    const calls: Array<{ agentId: string; text: string; dispatch: unknown }> = [];
    (supervisor as unknown as { sendInputWithOutcome: unknown }).sendInputWithOutcome = (
      agentId: string, text: string, _opts: unknown, dispatch: unknown,
    ) => {
      calls.push({ agentId, text, dispatch });
      return Promise.resolve(confirmed(agentId));
    };
    let route: string | null = null;
    const result = await supervisor.deliverScheduledFiring(makeFiring({
      markDelivering: (value) => { route = value ?? null; },
    }));
    assert.equal(result.disposition, 'sent');
    assert.equal(calls.length, 1, 'the production send seam must be called exactly once');
    assert.equal(calls[0].text, '[DASHBOARD EVENT] Scheduled message\n\n  original\r\nbytes  ');
    assert.deepEqual(calls[0].dispatch, { origin: 'scheduled-firing', scheduleId: 'cron-schedule' });
    assert.equal(route, 'unavailable');
  });
});

test('synchronous liveness and priority checks hold without entering the send', async () => {
  await withSupervisor(async (supervisor, agent) => {
    let sends = 0;
    (supervisor as unknown as { sendInputWithOutcome: unknown }).sendInputWithOutcome = () => {
      sends += 1;
      return Promise.resolve(confirmed(agent.id));
    };
    const runners = (supervisor as unknown as { windowsRunners: Map<string, unknown> }).windowsRunners;
    runners.delete(agent.id);
    assert.deepEqual(supervisor.deliverScheduledFiring(makeFiring()), { disposition: 'held' });
    runners.set(agent.id, {});
    for (const status of ['working', 'waiting', 'launching', 'restarting'] as const) {
      agent.status = status;
      assert.deepEqual(supervisor.deliverScheduledFiring(makeFiring()), { disposition: 'held' });
    }
    agent.status = 'idle';
    (supervisor as unknown as { pendingInitialPrompts: Map<string, unknown> }).pendingInitialPrompts.set(agent.id, {});
    assert.deepEqual(supervisor.deliverScheduledFiring(makeFiring()), { disposition: 'held' });
    (supervisor as unknown as { pendingInitialPrompts: Map<string, unknown> }).pendingInitialPrompts.delete(agent.id);
    (supervisor as unknown as { inputInFlight: Set<string> }).inputInFlight.add(agent.id);
    assert.deepEqual(supervisor.deliverScheduledFiring(makeFiring()), { disposition: 'held' });
    assert.equal(sends, 0);
  });
});

test('a non-confirmed send cancels the transient notification subscription', async () => {
  await withSupervisor(async (supervisor, agent) => {
    const bridge = (supervisor as unknown as { bridge: Record<string, unknown> }).bridge;
    let registrations = 0;
    let cancellations = 0;
    bridge.resolveScheduledNotificationRoute = () => ({
      route: 'subscription', subscriberAgentId: 'schedule-supervisor',
    });
    bridge.registerTransientTurnSubscription = () => { registrations += 1; return { registered: true }; };
    bridge.cancelTransientTurnSubscriptionsForPair = () => { cancellations += 1; };
    (supervisor as unknown as { sendInputWithOutcome: unknown }).sendInputWithOutcome = () => Promise.resolve({
      disposition: 'delivered-unconfirmed', agentId: agent.id, delivered: true,
      reason: 'confirmation-timeout', completedAt: 500,
    } satisfies SendOutcome);

    const result = await supervisor.deliverScheduledFiring(makeFiring());
    assert.equal(result.disposition, 'sent');
    assert.equal(registrations, 1);
    assert.equal(cancellations, 1);
  });
});

test('a rejected send becomes a complete failed outcome', async () => {
  await withSupervisor(async (supervisor, agent) => {
    (supervisor as unknown as { sendInputWithOutcome: unknown }).sendInputWithOutcome = () => Promise.reject(new Error('runner lost'));
    const before = Date.now();
    const result = await supervisor.deliverScheduledFiring(makeFiring());
    assert.equal(result.disposition, 'sent');
    const outcome = (result as Extract<ScheduledDeliveryResult, { disposition: 'sent' }>).outcome;
    assert.equal(outcome.disposition, 'failed');
    assert.equal(outcome.agentId, agent.id);
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.reason, 'delivery-failed');
    assert.ok(outcome.completedAt >= before);
  });
});

test('REACHABILITY:cron-held-release status listener drains initial prompt before releasing the held firing', async () => {
  await withSupervisor(async (supervisor, agent) => {
    const sent: string[] = [];
    (supervisor as unknown as { sendInputWithOutcome: unknown }).sendInputWithOutcome = (
      agentId: string, text: string,
    ) => {
      sent.push(text);
      (supervisor as unknown as { inputInFlight: Set<string> }).inputInFlight.add(agentId);
      if (text === 'initial first') return new Promise<SendOutcome>(() => {});
      return Promise.resolve(confirmed(agentId));
    };
    (supervisor as unknown as { pendingInitialPrompts: Map<string, unknown> }).pendingInitialPrompts.set(agent.id, {
      text: 'initial first', expiresAt: Date.now() + 60_000,
      dispatch: { origin: 'human-terminal' },
    });
    let released: ScheduledDeliveryResult | null = null;
    const base = makeFiring();
    const staged: StagedFiring = { ...base, onOutcome: (value) => { released = value; } };
    (supervisor as unknown as { stagedScheduledFirings: Map<string, StagedFiring> })
      .stagedScheduledFirings.set(agent.id, staged);

    supervisor.emit('statusChanged', { agentId: agent.id, status: 'idle', fromStatus: 'launching', source: 'monitor' });
    assert.deepEqual(sent, ['initial first'], 'initial prompt synchronously claims priority');
    assert.equal(
      (supervisor as unknown as { stagedScheduledFirings: Map<string, StagedFiring> }).stagedScheduledFirings.has(agent.id),
      true,
      'scheduled firing remains held while initial input is in flight',
    );

    (supervisor as unknown as { inputInFlight: Set<string> }).inputInFlight.delete(agent.id);
    supervisor.emit('statusChanged', { agentId: agent.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 2, 'the next accepting transition releases the staged firing');
    assert.match(sent[1], /^\[DASHBOARD EVENT\] Scheduled message/);
    assert.equal(
      (supervisor as unknown as { stagedScheduledFirings: Map<string, StagedFiring> }).stagedScheduledFirings.has(agent.id),
      false,
    );
    assert.equal((released as ScheduledDeliveryResult | null)?.disposition, 'sent');
  });
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed += 1; }
    catch (err) { console.error(`  FAIL  ${t.name}`); console.error(err); failed += 1; }
  }
  console.log(`scheduled-firing.test: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
