import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { resolveProviderStateHome } from './types';
import { ClaudeJsonlReader, makeClaudeProjectSlug } from './claude-jsonl-reader';
import { resolveSpoolReadPath } from '../hook-spool-tailer';
import { discoverNewCodexSession, snapshotCodexSessions } from '../session-id-discovery';

test('per-agent-state-home-entry: Claude researcher discovery follows the derived sandbox home', () => {
  const stateRoot = path.resolve('C:\\fixture\\workspace\\.lares');
  const resolved = resolveProviderStateHome({
    agentId: 'researcher-17',
    provider: 'claude',
    roleLane: 'researcher',
    workspaceStateRoot: stateRoot,
  });
  assert.equal(
    resolved,
    path.join(stateRoot, 'agent-homes', 'researcher-17'),
    'REACHABILITY:per-agent-state-home',
  );
});

test('chat reader enters the per-agent state home instead of the account home', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp5-chat-'));
  try {
    const workspaceStateRoot = path.join(fixture, '.lares');
    const workingDirectory = path.join(fixture, '.lares', 'researcher');
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const providerStateHome = resolveProviderStateHome({
      agentId: 'researcher-chat',
      provider: 'claude',
      roleLane: 'researcher',
      workspaceStateRoot,
    });
    assert.ok(providerStateHome);
    const projectDir = path.join(providerStateHome, 'projects', makeClaudeProjectSlug(workingDirectory));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({
      uuid: 'entry-1',
      type: 'user',
      timestamp: '2026-08-11T12:00:00.000Z',
      message: { content: 'researcher-visible-turn' },
    })}\n`);

    const events = new ClaudeJsonlReader().pollSession({
      agentId: 'researcher-chat',
      sessionId,
      workingDirectory,
      provider: 'claude',
      providerStateHome,
      subscribed: true,
    });
    assert.ok(events.some((event) => event.type === 'user-text'
      && event.text === 'researcher-visible-turn'));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('ordinary Claude discovery retains the account-wide state root', () => {
  const previous = process.env.USERPROFILE;
  const account = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp5-account-'));
  process.env.USERPROFILE = account;
  try {
    const expected = path.join(account, '.claude');
    fs.mkdirSync(expected);
    assert.equal(resolveProviderStateHome({
      agentId: 'worker-1',
      provider: 'claude',
      roleLane: 'worker',
      workspaceStateRoot: path.resolve('C:\\fixture\\workspace\\.lares'),
    }), expected);
  } finally {
    if (previous === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous;
    fs.rmSync(account, { recursive: true, force: true });
  }
});

test('non-Claude providers are not activated by the shared resolver', () => {
  assert.equal(resolveProviderStateHome({
    agentId: 'worker-2',
    provider: 'codex',
    roleLane: 'worker',
    workspaceStateRoot: path.resolve('C:\\fixture\\workspace\\.lares'),
  }), null);
  assert.throws(
    () => resolveProviderStateHome({
      agentId: 'researcher-codex',
      provider: 'codex',
      roleLane: 'researcher',
      workspaceStateRoot: path.resolve('C:\\fixture\\workspace\\.lares'),
    }),
    /not-yet-activated/,
  );
});

test('researcher status recovery and tailing resolve the per-agent spool', () => {
  const home = path.resolve('C:\\fixture\\workspace\\.lares\\agent-homes\\researcher-status');
  assert.equal(
    resolveSpoolReadPath(path.resolve('C:\\fixture\\workspace'), home),
    path.join(home, 'spool', 'pending-status.jsonl'),
  );
});

test('researcher tailing keeps Windows homes native and converts WSL logical homes to UNC', () => {
  const readPath = resolveSpoolReadPath(
    '/home/u/proj',
    '/home/u/proj/.lares/agent-homes/researcher-wsl',
  );
  assert.match(readPath, /^\\\\wsl(?:\$|\.localhost)\\[^\\]+\\home\\u\\proj\\\.lares\\agent-homes\\researcher-wsl\\spool\\pending-status\.jsonl$/i);
  assert.doesNotMatch(readPath, /^\\home\\/i, 'the Electron reader must not receive a path.join-corrupted POSIX home');

  const home = 'C:\\fixture\\workspace\\.lares\\agent-homes\\researcher-windows';
  assert.equal(
    resolveSpoolReadPath('C:\\fixture\\workspace', home),
    path.join(home, 'spool', 'pending-status.jsonl'),
  );
});

test('Codex snapshot and SQLite discovery use an explicit per-agent state root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp5-codex-'));
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
    const launchedAfterMs = Date.now();
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\fixture\\workspace',
      launchedAfterMs,
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

test('Windows launch snapshots only after researcher home preparation and reset', () => {
  const source = fs.readFileSync(path.resolve('src/main/supervisor/index.ts'), 'utf8');
  const start = source.indexOf('private async launchWindowsAgent');
  const end = source.indexOf('private async launchWslAgent', start);
  assert.ok(start >= 0 && end > start);
  const launch = source.slice(start, end);
  const prepared = launch.indexOf('prepareResearcherSandboxHome({');
  const snapshot = launch.indexOf("snapshotCodexSessions('windows', codexStateRoot)");
  assert.ok(prepared >= 0, 'researcher preparation must remain in the Windows launch path');
  assert.ok(snapshot > prepared, 'Codex snapshot must run after the per-agent home reset');
});
