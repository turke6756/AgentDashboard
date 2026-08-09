import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PlanWorkPackage } from '../database';
import type { PromotedPlanFolder } from '../../shared/types';
import {
  ARC_BOUNDS_CONTRACT,
  PROPOSAL_TO_PLAN_SCRIPT_PLAN_IDENTITY_MJS,
  PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS,
} from '../../shared/constants';
import { validateArcBounds } from './arc-bounds-validate';
import {
  buildPlanProgressProjection,
  PLAN_PROGRESS_LIMITS,
} from './plan-progress-projection';

const INSPECT_MAX_BYTES = 2 * 1024;
const SLICE_MAX_BYTES = 8 * 1024;

interface FixturePlan {
  root: string;
  planDir: string;
  helperPath: string;
  dispose(): void;
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

function createFixturePlan(): FixturePlan {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-progressive-ingestion-'));
  const planDir = path.join(root, 'plans', 'fixture-plan');
  const helperPath = path.join(root, 'plan-manifest.mjs');
  fs.mkdirSync(planDir, { recursive: true });
  write(path.join(planDir, 'plan.md'), [
    '# Fixture plan',
    '<!--PLAN-INTENT {"intent_id":"int_invalid"} -->',
    '<!--PLAN-INTENT {"intent_id":"int_open"} -->',
    ...Array.from({ length: 28 }, (_, index) =>
      `<!--PLAN-INTENT {"intent_id":"int_${String(index).padStart(2, '0')}${'wide'.repeat(20)}"} -->`),
    '## Work package source',
    'Package detail.',
    '## Intent overflow',
    'Overflow detail.',
    '',
  ].join('\n'));
  write(path.join(planDir, 'deliberations', 'review.md'), [
    '# Review deliberation',
    '## Review decision',
    '<a id="review-tab-decision"></a>',
    'The review tab was replaced with a progress checklist, while advanced review remained available.',
    '## Another concern',
    'This must not enter the requested slice.',
    '',
  ].join('\n'));
  write(path.join(planDir, 'ARC.md'), [
    '# ARC — Fixture plan',
    '<!--ARC-META {"source_cutoffs":{"folder_mtime_ms":1,"ledger_updated_at":null}} -->',
    '## Decisions',
    '- Review becomes a progress checklist. deliberations/review.md#review-decision',
    '## Work packages',
    '- Rollup: 1/2 complete.',
    '- WP-15 executing. plan.md#work-package-source',
    '- Overflow: 1 row omitted. plan.md#intent-overflow',
    '## Deliberations',
    '- int_invalid · invalid · broken ref. deliberations/review.md#review-decision',
    '- int_open · open · folded-in · review question. deliberations/review.md#review-decision',
    '- Overflow: 28 intents omitted. plan.md#intent-overflow',
    '## Who did what',
    '- Fixture author recorded the decision. deliberations/review.md#review-decision',
    '',
  ].join('\n'));
  write(path.join(planDir, 'plan.json'), JSON.stringify({
    schema_version: 2,
    plan_artifact_id: 'plan_fixture_progressive',
    source_proposal: { artifact_id: 'prop_fixture', rel_path: '.lares/proposals/fixture.md' },
    lifecycle_events: [
      { event_id: 'old', kind: 'promoted', at: 20 },
      { event_id: 'tie-first', kind: 'implementation_started', at: 40 },
      { event_id: 'tie-winner', kind: 'implementation_completed', at: 40 },
    ],
    responsibility_events: [
      { event_id: 'owner-a', event: 'assigned', agent_id: 'agent-a', display: 'A', at: 10 },
      { event_id: 'note', event: 'noted', agent_id: 'agent-x', display: 'X', at: 30 },
      { event_id: 'owner-b', event: 'assigned', agent_id: 'agent-b', display: 'B', at: 20 },
    ],
  }, null, 2) + '\n');
  write(helperPath, PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS);
  write(path.join(root, 'plan-identity.mjs'), PROPOSAL_TO_PLAN_SCRIPT_PLAN_IDENTITY_MJS);
  return {
    root,
    planDir,
    helperPath,
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function pkg(id: string, state: PlanWorkPackage['state'], order: number): PlanWorkPackage {
  return {
    id,
    workspaceId: 'fixture-workspace',
    planId: 'fixture-plan',
    intentId: null,
    schemaVersion: 2,
    contentHash: null,
    projectionStatus: 'synced',
    title: `${id}-${'🌍'.repeat(100)}`,
    acceptanceCondition: null,
    state,
    assigneeAgentId: null,
    revision: 1,
    createdAt: order,
    updatedAt: 1_786_000_000_000 + order,
  };
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function sliceAtExplicitAnchor(file: string, anchor: string): { content: string; bytes: number; truncated: boolean; continuation_required: boolean } {
  const body = fs.readFileSync(file, 'utf8');
  const marker = `<a id="${anchor}"></a>`;
  const start = body.indexOf(marker);
  assert.notEqual(start, -1, `fixture anchor ${anchor} must resolve`);
  const afterMarker = start + marker.length;
  const nextAnchor = body.indexOf('\n<a id="', afterMarker);
  const nextHeading = body.indexOf('\n## ', afterMarker);
  const candidates = [nextAnchor, nextHeading].filter((offset) => offset >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : body.length;
  const section = body.slice(start, end).trim() + '\n';
  const truncated = Buffer.byteLength(section, 'utf8') > SLICE_MAX_BYTES;
  const content = truncated ? utf8Prefix(section, SLICE_MAX_BYTES) : section;
  return { content, bytes: Buffer.byteLength(content, 'utf8'), truncated, continuation_required: truncated };
}

test('Layer A validates isolated fixture card, ARC, inspect summary, and one stage-2 slice', () => {
  const fixture = createFixturePlan();
  try {
    assert.ok(fixture.root.startsWith(os.tmpdir()), 'fixture must live under the test temp directory');
    assert.ok(!fixture.planDir.includes(`${path.sep}.lares${path.sep}plans${path.sep}`), 'fixture must never be a real workspace plan');

    const packages = [
      ...Array.from({ length: 45 }, (_, i) => pkg(`blocked-${i}`, 'blocked', i)),
      ...Array.from({ length: 5 }, (_, i) => pkg(`executing-${i}`, 'executing', 45 + i)),
      ...Array.from({ length: 12 }, (_, i) => pkg(`ready-${i}`, 'ready', 50 + i)),
    ];
    const card: PromotedPlanFolder = {
      planArtifactId: 'plan_fixture_progressive',
      planId: 'fixture-plan',
      folderName: 'fixture-plan',
      title: 'Fixture '.repeat(800),
      status: 'executing',
      archived: false,
      updatedAt: 1,
      responsibleSupervisor: { display: 'Fixture owner '.repeat(400), agentId: 'fixture-owner', source: 'manifest' },
      latestLifecycleKind: 'implementation_started',
      lifecycle: 'executing',
      rollup: { total: packages.length, landed: 0, remaining: packages.length, archived: 0, completed: false },
      activeVerifiedTurnCount: 0,
      activityTier: 'idle',
    };
    const plan = { id: 'fixture-plan', slug: 'fixture-plan', runState: 'executing', updatedAt: '2026-08-09 00:00:00' };
    const cardProjection = buildPlanProgressProjection({ detail: 'card', plan, card, packages });
    assert.ok(Buffer.byteLength(JSON.stringify(cardProjection), 'utf8') <= PLAN_PROGRESS_LIMITS.cardBytes);

    const packageProjection = buildPlanProgressProjection({ detail: 'packages', plan, card: null, packages }) as any;
    assert.ok(Buffer.byteLength(JSON.stringify(packageProjection), 'utf8') <= PLAN_PROGRESS_LIMITS.packagesBytes);
    assert.ok(packageProjection.packages.every((row: any) => row.state === 'blocked'));
    const includedByState = packageProjection.packages.reduce((counts: Record<string, number>, row: any) => {
      counts[row.state] = (counts[row.state] ?? 0) + 1;
      return counts;
    }, {});
    assert.deepEqual(packageProjection.packages_omitted_by_state, {
      blocked: 45 - (includedByState.blocked ?? 0),
      executing: 5 - (includedByState.executing ?? 0),
      ready: 12 - (includedByState.ready ?? 0),
      done: 0,
      archived: 0,
    });
    assert.ok(packageProjection.packages_omitted_by_state.blocked > 0, 'blocked rows themselves exceed the cap and disclose omissions');

    const arc = validateArcBounds(fixture.planDir);
    assert.equal(arc.ok, true, arc.errors.join('\n'));
    assert.ok(arc.measurements.artifactBytes <= ARC_BOUNDS_CONTRACT.artifactMaxBytes);

    const inspect = spawnSync(process.execPath, [fixture.helperPath, 'inspect', '--summary', '--dir', fixture.planDir], { encoding: 'utf8' });
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.ok(Buffer.byteLength(inspect.stdout, 'utf8') <= INSPECT_MAX_BYTES);
    const summary = JSON.parse(inspect.stdout);
    assert.equal(summary.title, null);
    assert.equal(summary.latest_lifecycle_event.event_id, 'tie-winner');
    assert.equal(summary.current_owner.event_id, 'owner-b');
    assert.ok(summary.intent_ids.length <= 20);
    assert.equal(summary.intents_omitted, summary.counts.intents - summary.intent_ids.length);
    assert.ok(!('listing' in summary) && !('manifest' in summary), 'summary must omit stage-3 history/listing fields');

    const healthySlice = sliceAtExplicitAnchor(path.join(fixture.planDir, 'deliberations', 'review.md'), 'review-tab-decision');
    assert.ok(healthySlice.bytes <= SLICE_MAX_BYTES);
    assert.equal(healthySlice.truncated, false);
    assert.doesNotMatch(healthySlice.content, /Another concern/u);

    write(path.join(fixture.planDir, 'deliberations', 'oversize.md'), [
      '# Oversize',
      '<a id="oversize"></a>',
      '🌍'.repeat(SLICE_MAX_BYTES),
      '',
    ].join('\n'));
    const degradedSlice = sliceAtExplicitAnchor(path.join(fixture.planDir, 'deliberations', 'oversize.md'), 'oversize');
    assert.equal(degradedSlice.bytes <= SLICE_MAX_BYTES, true);
    assert.deepEqual({ truncated: degradedSlice.truncated, continuation_required: degradedSlice.continuation_required }, {
      truncated: true,
      continuation_required: true,
    });
  } finally {
    fixture.dispose();
  }
});
