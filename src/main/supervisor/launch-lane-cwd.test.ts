import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { assertLaneLaunchCwd, resolveLaneCwd } from './launch-lane-cwd';

const workspaceRoot = path.resolve('C:\\work\\lares-workspace');

for (const provider of ['codex', 'claude'] as const) {
  test(`plan-bound ${provider} supervisor uses its provider child lane`, () => {
    const cwd = resolveLaneCwd({
      workspaceRoot,
      activityRoot: workspaceRoot,
      explicitCwd: workspaceRoot,
      stateDirName: '.lares',
      pathType: 'windows',
      provider,
      isSupervisor: true,
    });

    assert.equal(cwd, path.join(workspaceRoot, '.lares', 'supervisor', provider));
  });

  test(`plan-bound ${provider} worker without planning worktrees uses its workspace lane`, () => {
    const cwd = resolveLaneCwd({
      workspaceRoot,
      activityRoot: workspaceRoot,
      explicitCwd: workspaceRoot,
      stateDirName: '.lares',
      pathType: 'windows',
      provider,
      isWorkerLane: true,
    });

    assert.equal(cwd, path.join(workspaceRoot, '.lares', 'workers', provider));
  });
}

test('plan-bound worker with a planning activity uses the activity-rooted lane', () => {
  const activityRoot = path.resolve('C:\\work\\planning-activity');
  const cwd = resolveLaneCwd({
    workspaceRoot,
    activityRoot,
    explicitCwd: activityRoot,
    stateDirName: '.lares',
    pathType: 'windows',
    provider: 'codex',
    isWorkerLane: true,
  });

  assert.equal(cwd, path.join(activityRoot, '.lares', 'workers', 'codex'));
});

test('lane-classed launch refuses the workspace root', () => {
  assert.throws(() => assertLaneLaunchCwd({
    agentCwd: workspaceRoot,
    laneRoot: workspaceRoot,
    stateDirName: '.lares',
    pathType: 'windows',
  }), /is not a \.lares lane folder; refusing hookless launch/);
});

test('plain unsupervised launch may remain at the workspace root', () => {
  assert.equal(resolveLaneCwd({
    workspaceRoot,
    explicitCwd: workspaceRoot,
    stateDirName: '.lares',
    pathType: 'windows',
    provider: 'claude',
  }), workspaceRoot);
});
