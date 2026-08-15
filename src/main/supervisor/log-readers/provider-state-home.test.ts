import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveSpoolReadPath } from '../hook-spool-tailer';
import { discoverNewCodexSession, snapshotCodexSessions } from '../session-id-discovery';

test('workspace spool resolution has no provider-home override', () => {
  const workspace = path.resolve('C:\\fixture\\workspace');
  assert.equal(
    resolveSpoolReadPath(workspace),
    path.join(workspace, '.lares', 'pending-status.jsonl'),
  );
  assert.equal(resolveSpoolReadPath.length, 1,
    'spool resolution must not expose a per-agent provider-home argument');
});

test('Codex snapshot and SQLite discovery retain the explicit state-root adapter contract', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-provider-state-adapter-'));
  try {
    const now = new Date();
    const dateDir = path.join(
      root,
      'sessions',
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(dateDir, { recursive: true });
    const oldId = '22222222-2222-4222-8222-222222222222';
    const oldPath = path.join(dateDir, `rollout-2026-08-11T00-00-00-${oldId}.jsonl`);
    fs.writeFileSync(oldPath, '{}\n');

    const before = await snapshotCodexSessions('windows', root);
    assert.equal(before.stateRoot, root);
    assert.ok(before.paths.has(oldPath));

    let openedPath = '';
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\fixture\\workspace',
      launchedAfterMs: Date.now(),
      firstUserMessagePrefix: 'hello',
      openSqliteDb: (dbPath) => {
        openedPath = dbPath;
        return {
          prepare: () => ({
            get: () => null,
            all: () => [{
              id: '33333333-3333-4333-8333-333333333333',
              rollout_path: path.join(root, 'sessions', 'new.jsonl'),
              cwd: 'C:\\fixture\\workspace',
              cli_version: '0.133.0',
            }],
          }),
          close: () => {},
        };
      },
    });
    assert.equal(openedPath, path.join(root, 'state_5.sqlite'));
    assert.equal(result?.sessionId, '33333333-3333-4333-8333-333333333333');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows launch snapshots the default Codex home without researcher preparation', () => {
  const source = fs.readFileSync(path.resolve('src/main/supervisor/index.ts'), 'utf8');
  const start = source.indexOf('private async launchWindowsAgent');
  const end = source.indexOf('private async launchWslAgent', start);
  assert.ok(start >= 0 && end > start);
  const launch = source.slice(start, end);
  assert.doesNotMatch(launch, /prepareResearcherSandboxHome\s*\(/,
    'post-WP-1 launch must not prepare a per-agent researcher home');
  assert.match(launch, /snapshotCodexSessions\('windows'\)/,
    'Codex discovery must snapshot through its default-home overload');
  assert.doesNotMatch(launch, /snapshotCodexSessions\('windows'\s*,/,
    'Windows launch must not pass a per-agent state-root override');
});
