// Self-contained smoke tests for Codex session discovery.
//
// Compile via:
//   npm run build:main
//   node dist/main/main/supervisor/session-id-discovery.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverNewCodexSession, type CodexSessionSnapshot } from './session-id-discovery';
import type { CodexRolloutFile, CodexSessionHome } from './log-readers/codex-rollout-reader';

interface TestCase {
  name: string;
  run(): void | Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

const SESSION_ID = '33333333-4444-5555-6666-777777777777';
const OTHER_ID = '44444444-5555-6666-7777-888888888888';

function makeRollout(root: string, sessionId: string, cwd: string, metaId = sessionId): CodexRolloutFile {
  const dir = path.join(root, '2026', '05', '02');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `rollout-2026-05-02T12-00-00-${sessionId}.jsonl`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify({
    timestamp: '2026-05-02T12:00:00.000Z',
    type: 'session_meta',
    payload: { id: metaId, cwd, model_provider: 'openai', cli_version: '0.128.0' },
  }) + '\n');
  return {
    path: filePath,
    filename,
    sessionId,
    home: 'windows',
    mtimeMs: fs.statSync(filePath).mtimeMs,
  };
}

function snapshot(home: CodexSessionHome, files: CodexRolloutFile[] = []): CodexSessionSnapshot {
  return { home, paths: new Set(files.map((f) => f.path)) };
}

test('discovers only new rollout matching cwd and filename/meta id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-good-'));
  try {
    const oldFile = makeRollout(root, OTHER_ID, 'C:\\Users\\fixture');
    const before = snapshot('windows', [oldFile]);
    const launchTime = Date.now() - 1;
    const newFile = makeRollout(root, SESSION_ID, 'C:\\Users\\fixture');
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: launchTime,
      timeoutMs: 700,
      listFiles: () => [oldFile, newFile],
    });
    assert.ok(result, 'expected discovery result');
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(result.path, newFile.path);
    assert.equal(result.cwd, 'C:\\Users\\fixture');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects concurrent new rollout with mismatched cwd', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-cwd-'));
  try {
    const before = snapshot('windows');
    const newFile = makeRollout(root, SESSION_ID, 'C:\\Other\\Repo');
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: Date.now() - 1,
      timeoutMs: 700,
      listFiles: () => [newFile],
    });
    assert.equal(result, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects filename/session_meta id mismatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-id-'));
  try {
    const before = snapshot('windows');
    const newFile = makeRollout(root, SESSION_ID, 'C:\\Users\\fixture', OTHER_ID);
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: Date.now() - 1,
      timeoutMs: 700,
      listFiles: () => [newFile],
    });
    assert.equal(result, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects files older than launch start', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-time-'));
  try {
    const before = snapshot('windows');
    const newFile = makeRollout(root, SESSION_ID, 'C:\\Users\\fixture');
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: newFile.mtimeMs + 10_000,
      timeoutMs: 700,
      listFiles: () => [newFile],
    });
    assert.equal(result, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
