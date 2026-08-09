import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendImplementationLifecycleEvents,
  appendPromotedLifecycleEvent,
  casAppendLifecycleEvent,
  casMutate,
  latestLifecycleEvent,
  type LifecycleEvent,
  type PlanManifest,
} from './plan-manifest';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
const roots: string[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

async function fixture(name: string, manifest: PlanManifest = {}): Promise<{
  home: string;
  folder: string;
  rel: string;
}> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lares-lifecycle-'));
  roots.push(home);
  const rel = name;
  const folder = path.join(home, rel);
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'plan.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { home, folder, rel };
}

async function read(folder: string): Promise<PlanManifest> {
  return JSON.parse(await fs.readFile(path.join(folder, 'plan.json'), 'utf8')) as PlanManifest;
}

function event(eventId = 'ple_a'): LifecycleEvent {
  return { event_id: eventId, kind: 'promoted', at: 10, source: 'promotion-service' };
}

test('casAppendLifecycleEvent appends once and duplicate event_id is unchanged', async () => {
  const f = await fixture('append', { plan_artifact_id: 'plan_1234abcd', created_at: 1 });
  const first = await casAppendLifecycleEvent(f.home, f.rel, event());
  const bytesAfterFirst = await fs.readFile(path.join(f.folder, 'plan.json'), 'utf8');
  const duplicate = await casAppendLifecycleEvent(f.home, f.rel, { ...event(), at: 999 });
  const bytesAfterDuplicate = await fs.readFile(path.join(f.folder, 'plan.json'), 'utf8');

  assert.equal(first.changed, true,
    'REACHABILITY:wp1-lifecycle-append lifecycle append must report a write');
  assert.equal(duplicate.changed, false);
  assert.equal(bytesAfterDuplicate, bytesAfterFirst);
  assert.equal((await read(f.folder)).lifecycle_events?.length, 1,
    'REACHABILITY:wp1-lifecycle-append lifecycle append must reach plan.json');
});

test('latestLifecycleEvent orders by at and breaks ties by later array position', () => {
  const events: LifecycleEvent[] = [
    { event_id: 'ple_1', kind: 'promoted', at: 100, source: 'promotion-service' },
    { event_id: 'ple_2', kind: 'completed', at: 90, source: 'manual-skill' },
    { event_id: 'ple_3', kind: 'reopened', at: 100, source: 'manual-skill' },
  ];
  assert.equal(latestLifecycleEvent(events)?.event_id, 'ple_3');
  assert.equal(latestLifecycleEvent([]), null);
});

test('manifest without lifecycle_events parses unchanged', async () => {
  const original: PlanManifest = {
    schema_version: 1,
    plan_artifact_id: 'plan_1234abcd',
    responsibility_events: [],
    created_at: 1,
  };
  const f = await fixture('legacy', original);
  const result = await casMutate(f.home, f.rel, () => null);
  assert.equal(result.changed, false);
  assert.deepEqual(result.manifest, original);
  assert.equal(result.manifest.lifecycle_events, undefined);
});

test('promotion appender records a stable promoted event idempotently', async () => {
  const f = await fixture('promote', { plan_artifact_id: 'plan_1234abcd' });
  const input = {
    plansHomeRoot: f.home,
    planFolderRelPath: f.rel,
    planArtifactId: 'plan_1234abcd',
    agentId: 'supervisor-1',
    display: 'Supervisor One',
    at: 123,
  };
  await appendPromotedLifecycleEvent(input);
  await appendPromotedLifecycleEvent(input);
  const events = (await read(f.folder)).lifecycle_events ?? [];
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    event_id: events[0].event_id,
    kind: 'promoted',
    agent_id: 'supervisor-1',
    display: 'Supervisor One',
    at: 123,
    source: 'promotion-service',
  });
});

test('implement appender records started, then reopened + fresh started on a new run', async () => {
  const f = await fixture('implement', { plan_artifact_id: 'plan_1234abcd' });
  const common = {
    plansHomeRoot: f.home,
    planFolderRelPath: f.rel,
    agentId: 'app-user',
    at: 200,
  };
  await appendImplementationLifecycleEvents({ ...common, runId: 'run-1', isReimplementation: false });
  await appendImplementationLifecycleEvents({ ...common, runId: 'run-1', isReimplementation: false });
  await appendImplementationLifecycleEvents({ ...common, runId: 'run-2', isReimplementation: true, at: 300 });
  const events = (await read(f.folder)).lifecycle_events ?? [];
  assert.deepEqual(events.map(({ kind }) => kind), [
    'implementation_started',
    'reopened',
    'implementation_started',
  ]);
  assert.equal(new Set(events.map(({ event_id }) => event_id)).size, 3);
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      passed += 1;
    } catch (err) {
      failed += 1;
      console.error(`✗ ${t.name}\n  ${(err as Error).stack || (err as Error).message}`);
    }
  }
  for (const root of roots) {
    try { await fs.rm(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(`\nplan-manifest-lifecycle: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
