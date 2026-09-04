import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { __setWslEnabledForTest } from './wsl-enabled';
import {
  __setWslProcessDepsForTest,
  getPassiveWslStatus,
  wslExec,
  wslSpawn,
} from './wsl-bridge';

let execCalls = 0;
let spawnCalls = 0;
__setWslProcessDepsForTest({
  execFile: ((..._args: any[]) => { execCalls++; }) as any,
  spawn: ((..._args: any[]) => { spawnCalls++; return new EventEmitter(); }) as any,
});
__setWslEnabledForTest(false);

(async () => {
  try {
    assert.deepEqual(await getPassiveWslStatus(), { state: 'disabled', distros: [] });
    const result = await wslExec('echo should-not-run');
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /WSL is disabled in Lares/);
    assert.throws(() => wslSpawn('echo should-not-run'), /WSL is disabled in Lares/);
    assert.equal(execCalls, 0, 'disabled passive status and exec never call execFile');
    assert.equal(spawnCalls, 0, 'disabled spawn never calls child_process.spawn');
    console.log('wsl-bridge-enabled: 5/5 passed');
  } finally {
    __setWslProcessDepsForTest(null);
    __setWslEnabledForTest(null);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
