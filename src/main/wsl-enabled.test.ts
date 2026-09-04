import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __setWslEnabledStoragePathForTest,
  assertWslEnabled,
  isWslEnabled,
  setWslEnabled,
  WSL_DISABLED_MESSAGE,
} from './wsl-enabled';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wsl-enabled-'));
const file = path.join(root, 'wsl-enabled.json');

try {
  __setWslEnabledStoragePathForTest(file);
  assert.equal(isWslEnabled(), true, 'missing setting defaults enabled');

  setWslEnabled(false);
  assert.equal(isWslEnabled(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { enabled: false });

  __setWslEnabledStoragePathForTest(file);
  assert.equal(isWslEnabled(), false, 'disabled setting survives a cache reset');
  assert.throws(() => assertWslEnabled(), new RegExp(WSL_DISABLED_MESSAGE));

  fs.writeFileSync(file, '{broken', 'utf8');
  __setWslEnabledStoragePathForTest(file);
  assert.equal(isWslEnabled(), true, 'unreadable setting defaults enabled');

  __setWslEnabledStoragePathForTest(root);
  const priorError = console.error;
  console.error = () => undefined;
  try {
    assert.doesNotThrow(() => setWslEnabled(false), 'persistence failure is non-fatal');
  } finally {
    console.error = priorError;
  }

  console.log('wsl-enabled: 5/5 passed');
} finally {
  __setWslEnabledStoragePathForTest(null);
  fs.rmSync(root, { recursive: true, force: true });
}
