import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { devDiscoveryFilePath } from './dev-instance';
import { removeDevInstanceDiscovery, writeDevInstanceDiscovery } from './dev-instance-discovery';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp7-discovery-'));
const file = path.join(root, 'dev-instance.json');
const discovery = {
  port: 24679,
  host: '127.0.0.1',
  token: 'dev-token',
  pid: process.pid,
  userData: root,
  startedAt: '2026-09-03T12:00:00.000Z',
};

try {
  assert.equal(
    devDiscoveryFilePath('C:\\Users\\example\\AppData\\Roaming'),
    path.join('C:\\Users\\example\\AppData\\Roaming', 'lares-app-dev', 'dev-instance.json'),
  );

  writeDevInstanceDiscovery(file, discovery);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), discovery);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }

  removeDevInstanceDiscovery(file);
  assert.equal(fs.existsSync(file), false);
  removeDevInstanceDiscovery(file);

  console.log('dev-instance-discovery: write/remove pair passed');
  console.log('REACHABILITY:wp7-dev-target-routing discovery producer writes the consumed contract');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
