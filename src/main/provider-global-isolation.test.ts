import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  resolveCodexHookArtifactNames,
  runStartupProviderRepairs,
  startProviderRepairWatcherIfOwner,
} from './provider-repairs';
import { ensureAgyPermissions, ensureAgyTrust } from './supervisor/agy-settings';

const REACHABILITY = 'REACHABILITY:wp5-provider-repairs-dev-skip';

test('dev skips startup repairs and the runtime repair watcher', () => {
  const calls: string[] = [];
  runStartupProviderRepairs({
    isDev: true,
    validateWindows: () => calls.push('windows'),
    validateWsl: () => calls.push('wsl'),
  });
  startProviderRepairWatcherIfOwner({
    isDev: true,
    startWatcher: () => calls.push('watcher'),
  });
  assert.deepEqual(calls, [], REACHABILITY);
});

test('stable runs the existing repair calls once and in order', () => {
  const calls: string[] = [];
  runStartupProviderRepairs({
    isDev: false,
    validateWindows: () => calls.push('windows'),
    validateWsl: () => calls.push('wsl'),
  });
  startProviderRepairWatcherIfOwner({
    isDev: false,
    startWatcher: () => calls.push('watcher'),
  });
  assert.deepEqual(calls, ['windows', 'wsl', 'watcher']);
});

test('Codex WSL hook artifacts share one stable or dev namespace', () => {
  assert.deepEqual(resolveCodexHookArtifactNames(false), {
    profileName: 'dashboard-worker',
    profileFile: 'dashboard-worker.config.toml',
    statusScript: 'dashboard-status.mjs',
    guardScript: 'guard-git-discard.mjs',
  });
  assert.deepEqual(resolveCodexHookArtifactNames(true), {
    profileName: 'dashboard-worker-dev',
    profileFile: 'dashboard-worker-dev.config.toml',
    statusScript: 'dashboard-status-dev.mjs',
    guardScript: 'guard-git-discard-dev.mjs',
  });
});

test('dev agy setup writes trust only and skips permission merging', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp5-agy-'));
  try {
    const trust = ensureAgyTrust(home, ['C:\\DevWorkspace'], 'windows');
    assert.equal(trust.action, 'written');
    const before = fs.readFileSync(trust.settingsPath, 'utf8');
    const permissions = ensureAgyPermissions(
      home,
      ['C:\\DevWorkspace'],
      'windows',
      true,
    );
    assert.equal(permissions.action, 'unchanged');
    assert.equal(fs.readFileSync(trust.settingsPath, 'utf8'), before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
