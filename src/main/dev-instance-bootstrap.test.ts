import assert from 'node:assert/strict';
import path from 'node:path';
import { bootstrapMain } from './bootstrap';

const key = 'LARES_DEV_INSTANCE';
const prior = process.env[key];

try {
  process.env[key] = '1';
  const calls: string[] = [];
  const appData = path.join('C:\\', 'Users', 'tester', 'AppData', 'Roaming');
  const expected = path.join(appData, 'lares-app-dev');
  bootstrapMain(
    {
      getPath(name) {
        assert.equal(name, 'appData');
        calls.push('get:appData');
        return appData;
      },
      setPath(name, value) {
        calls.push(`set:${name}:${value}`);
      },
    },
    {
      mkdirSync(value, options) {
        assert.deepEqual(options, { recursive: true });
        calls.push(`mkdir:${String(value)}`);
        return undefined;
      },
    },
    () => calls.push('require:index'),
  );
  assert.deepEqual(calls, [
    'get:appData',
    `mkdir:${expected}`,
    `set:userData:${expected}`,
    `set:sessionData:${expected}`,
    'require:index',
  ], 'REACHABILITY:wp1-dev-instance-bootstrap');

  delete process.env[key];
  const stableCalls: string[] = [];
  bootstrapMain(
    {
      getPath() { throw new Error('stable bootstrap must not read appData'); },
      setPath() { throw new Error('stable bootstrap must not set paths'); },
    },
    { mkdirSync() { throw new Error('stable bootstrap must not create a profile'); } },
    () => stableCalls.push('require:index'),
  );
  assert.deepEqual(stableCalls, ['require:index']);
} finally {
  if (prior === undefined) delete process.env[key];
  else process.env[key] = prior;
}

console.log('dev-instance-bootstrap: 2 test groups passed');
