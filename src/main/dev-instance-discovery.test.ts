import assert from 'node:assert/strict';
import path from 'node:path';
import { devDiscoveryFilePath } from './dev-instance';
import { removeDevInstanceDiscovery, writeDevInstanceDiscovery } from './dev-instance-discovery';

const root = 'C:\\fake-app-data';
const file = path.join(root, 'dev-instance.json');
const discovery = {
  port: 24679,
  host: '127.0.0.1',
  token: 'dev-token',
  pid: process.pid,
  userData: root,
  startedAt: '2026-09-03T12:00:00.000Z',
};

let stored: string | undefined;
let chmodMode: number | undefined;
let writeCount = 0;
const missingFile = (): NodeJS.ErrnoException => Object.assign(new Error('missing'), { code: 'ENOENT' });
const fileSystem = {
  readFileSync(_file: string, encoding: 'utf8'): string {
    assert.equal(encoding, 'utf8');
    if (stored === undefined) throw missingFile();
    return stored;
  },
  writeFileSync(_file: string, data: string, options: { encoding: 'utf8'; mode: number }): void {
    assert.deepEqual(options, { encoding: 'utf8', mode: 0o600 });
    stored = data;
    writeCount += 1;
  },
  chmodSync(_file: string, mode: number): void {
    chmodMode = mode;
  },
  unlinkSync(): void {
    if (stored === undefined) throw missingFile();
    stored = undefined;
  },
};

assert.equal(
  devDiscoveryFilePath('C:\\Users\\example\\AppData\\Roaming'),
  path.join('C:\\Users\\example\\AppData\\Roaming', 'lares-app-dev', 'dev-instance.json'),
);

writeDevInstanceDiscovery(file, discovery, fileSystem);
assert.deepEqual(JSON.parse(stored!), discovery);
assert.equal(chmodMode, 0o600);

removeDevInstanceDiscovery(file, process.pid + 1, fileSystem);
assert.notEqual(stored, undefined, 'a different pid must not remove the discovery record');
removeDevInstanceDiscovery(file, process.pid, fileSystem);
assert.equal(stored, undefined, 'the owning pid removes its discovery record');
removeDevInstanceDiscovery(file, process.pid, fileSystem);

const livePid = process.pid + 10_000;
stored = JSON.stringify({ ...discovery, pid: livePid, token: 'live-token' });
const beforeRefusedWrite = stored;
let checkedPid: number | undefined;
writeDevInstanceDiscovery(file, discovery, fileSystem, (pid) => {
  checkedPid = pid;
  return true;
});
assert.equal(checkedPid, livePid);
assert.equal(stored, beforeRefusedWrite, 'a live foreign pid record must not be overwritten');
assert.equal(writeCount, 1, 'the refused overwrite must be a no-op');

console.log('dev-instance-discovery: pid-guarded write/remove tests passed');
console.log('REACHABILITY:wp7-dev-target-routing discovery producer writes the consumed contract');
