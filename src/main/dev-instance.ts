import path from 'node:path';

const DEV_PROFILE_DIR = 'lares-app-dev';
const STABLE_DB_DIR = 'AgentDashboard';
const DEV_DB_DIR = 'AgentDashboard-dev';
const STABLE_REGISTRY_FILE = 'agent-registry.json';
const DEV_REGISTRY_FILE = 'agent-registry-dev.json';

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

export function isDevInstance(): boolean {
  return process.env.LARES_DEV_INSTANCE === '1';
}

export function devProfileDirName(): string {
  return isDevInstance() ? DEV_PROFILE_DIR : 'lares-app';
}

export function devDbDirName(): string {
  return isDevInstance() ? DEV_DB_DIR : STABLE_DB_DIR;
}

export function devRegistryFileName(): string {
  return isDevInstance() ? DEV_REGISTRY_FILE : STABLE_REGISTRY_FILE;
}

export function devApiPort(): number | undefined {
  return isDevInstance() ? readPort('LARES_DEV_API_PORT', 24679) : undefined;
}

export function devWsPort(stablePort = 4545): number {
  return isDevInstance() ? readPort('LARES_DEV_WS_PORT', 4546) : stablePort;
}

export function devJupyterBasePort(stablePort = 18888): number {
  return isDevInstance() ? readPort('LARES_DEV_JUPYTER_PORT', 18939) : stablePort;
}

export function devAppUserModelId(): string {
  return isDevInstance() ? 'com.lares.app.dev' : 'com.lares.app';
}

/** True when a proposed workspace root is the checkout, or an ancestor of it. */
export function isForbiddenDevWorkspaceRoot(requestedRoot: string, appPath: string): boolean {
  if (!isDevInstance()) return false;
  const relative = path.relative(path.resolve(requestedRoot), path.resolve(appPath));
  return relative === '' || (!path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}
