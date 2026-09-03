import assert from 'node:assert/strict';
import path from 'node:path';
import { getDbPathExisting } from './database';
import {
  devApiPort,
  devAppUserModelId,
  devDbDirName,
  devJupyterBasePort,
  devProfileDirName,
  devRegistryFileName,
  devWsPort,
  isDevInstance,
  isForbiddenDevWorkspaceRoot,
} from './dev-instance';

const ENV_KEYS = [
  'LARES_DEV_INSTANCE',
  'LARES_DEV_API_PORT',
  'LARES_DEV_WS_PORT',
  'LARES_DEV_JUPYTER_PORT',
] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => void): void {
  const prior = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = prior.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

let passed = 0;

withEnv({}, () => {
  assert.equal(isDevInstance(), false);
  assert.equal(devProfileDirName(), 'lares-app');
  assert.equal(devDbDirName(), 'AgentDashboard');
  assert.equal(devRegistryFileName(), 'agent-registry.json');
  assert.equal(devApiPort(), undefined);
  assert.equal(devWsPort(), 4545);
  assert.equal(devWsPort(9000), 9000);
  assert.equal(devJupyterBasePort(), 18888);
  assert.equal(devJupyterBasePort(9001), 9001);
  assert.equal(devAppUserModelId(), 'com.lares.app');
  const appData = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
  assert.equal(getDbPathExisting(), path.join(appData, 'AgentDashboard', 'dashboard.db'));
  assert.equal(isForbiddenDevWorkspaceRoot('C:\\repo', 'C:\\repo'), false);
  passed += 1;
});

withEnv({ LARES_DEV_INSTANCE: '1' }, () => {
  assert.equal(isDevInstance(), true);
  assert.equal(devProfileDirName(), 'lares-app-dev');
  assert.equal(devDbDirName(), 'AgentDashboard-dev');
  assert.equal(devRegistryFileName(), 'agent-registry-dev.json');
  assert.equal(devApiPort(), 24679);
  assert.equal(devWsPort(), 4546);
  assert.equal(devJupyterBasePort(), 18939);
  assert.equal(devAppUserModelId(), 'com.lares.app.dev');
  const appData = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
  assert.equal(getDbPathExisting(), path.join(appData, 'AgentDashboard-dev', 'dashboard.db'));
  assert.equal(isForbiddenDevWorkspaceRoot('C:\\repo', 'C:\\repo'), true);
  assert.equal(isForbiddenDevWorkspaceRoot('C:\\', 'C:\\repo\\dist-dev'), true);
  assert.equal(isForbiddenDevWorkspaceRoot('C:\\smoke', 'C:\\repo\\dist-dev'), false);
  passed += 1;
});

withEnv({
  LARES_DEV_INSTANCE: '1',
  LARES_DEV_API_PORT: '31001',
  LARES_DEV_WS_PORT: '31002',
  LARES_DEV_JUPYTER_PORT: '31003',
}, () => {
  assert.equal(devApiPort(), 31001);
  assert.equal(devWsPort(), 31002);
  assert.equal(devJupyterBasePort(), 31003);
  passed += 1;
});

for (const invalid of ['0', '65536', '-1', '1.5', 'nope', '']) {
  withEnv({
    LARES_DEV_INSTANCE: '1',
    LARES_DEV_API_PORT: invalid,
    LARES_DEV_WS_PORT: invalid,
    LARES_DEV_JUPYTER_PORT: invalid,
  }, () => {
    assert.equal(devApiPort(), 24679);
    assert.equal(devWsPort(), 4546);
    assert.equal(devJupyterBasePort(), 18939);
  });
}
passed += 1;

console.log(`dev-instance: ${passed} test groups passed`);
