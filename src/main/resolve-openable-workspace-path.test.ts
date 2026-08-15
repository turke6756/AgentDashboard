import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Resolver = typeof import('./index').resolveOpenableWorkspacePath;

function callableProxy(): any {
  const target = () => undefined;
  return new Proxy(target, {
    get: (_value, key) => key === 'then' ? undefined : callableProxy(),
    apply: () => callableProxy(),
    construct: () => callableProxy(),
  });
}

function loadProductionModule(): typeof import('./index') {
  const electronPath = require.resolve('electron');
  const indexPath = require.resolve('./index');
  const priorElectron = require.cache[electronPath];
  const inert = callableProxy();
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: new Proxy({}, {
    get: (_target, key) => {
      if (key === 'app') return {
        getPath: () => os.tmpdir(),
        whenReady: () => new Promise<void>(() => undefined),
        requestSingleInstanceLock: () => true,
        setAppUserModelId: () => undefined,
        on: () => undefined,
        commandLine: { appendSwitch: () => undefined },
      };
      if (key === 'crashReporter') return { start: () => undefined };
      if (key === 'ipcMain') return { handle: () => undefined, on: () => undefined };
      return inert;
    },
  }) } as any;
  delete require.cache[indexPath];
  const priorChromeVersion = process.versions.chrome;
  Object.defineProperty(process.versions, 'chrome', { configurable: true, value: '146.0.0.0' });
  try {
    return require('./index') as typeof import('./index');
  } finally {
    if (priorChromeVersion === undefined) delete (process.versions as { chrome?: string }).chrome;
    else Object.defineProperty(process.versions, 'chrome', { configurable: true, value: priorChromeVersion });
    if (priorElectron) require.cache[electronPath] = priorElectron; else delete require.cache[electronPath];
  }
}

async function main(): Promise<void> {
  const production = loadProductionModule();
  const resolveOpenableWorkspacePath: Resolver = production.resolveOpenableWorkspacePath;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-openable-'));
  const workspaceRoot = path.join(fixture, 'workspace');
  const prefixSibling = path.join(fixture, 'workspace-outside');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(prefixSibling);
  const inside = path.join(workspaceRoot, 'proposal.md');
  const outside = path.join(prefixSibling, 'outside.md');
  fs.writeFileSync(inside, 'inside');
  fs.writeFileSync(outside, 'outside');
  const getWorkspaceById = (id: string) => id === 'ws'
    ? { path: workspaceRoot, pathType: 'local' as const }
    : null;
  const deps = { getWorkspaceById: getWorkspaceById as any, realpath: fs.promises.realpath };

  try {
    assert.deepEqual(
      await resolveOpenableWorkspacePath({ workspaceId: 'ws', path: 'proposal.md' }, deps),
      { ok: true, canonicalPath: await fs.promises.realpath(inside) },
    );
    assert.deepEqual(
      await resolveOpenableWorkspacePath({ workspaceId: 'ws', path: path.join('..', 'workspace-outside', 'outside.md') }, deps),
      { ok: false, reason: 'outside-workspace' },
    );
    assert.deepEqual(
      await resolveOpenableWorkspacePath({ workspaceId: 'ws', path: outside }, deps),
      { ok: false, reason: 'outside-workspace' },
    );

    const link = path.join(workspaceRoot, 'outside-link');
    fs.symlinkSync(prefixSibling, link, 'junction');
    assert.deepEqual(
      await resolveOpenableWorkspacePath({ workspaceId: 'ws', path: path.join(link, 'outside.md') }, deps),
      { ok: false, reason: 'outside-workspace' },
    );

    fs.unlinkSync(inside);
    assert.deepEqual(
      await resolveOpenableWorkspacePath({ workspaceId: 'ws', path: inside }, deps),
      { ok: false, reason: 'missing' },
    );

    const unreadableRealpath = async (candidate: string): Promise<string> => {
      if (candidate.endsWith('unreadable.md')) {
        const error = new Error('access denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return fs.promises.realpath(candidate);
    };
    assert.deepEqual(
      await resolveOpenableWorkspacePath(
        { workspaceId: 'ws', path: 'unreadable.md' },
        { getWorkspaceById: getWorkspaceById as any, realpath: unreadableRealpath },
      ),
      { ok: false, reason: 'unreadable' },
    );
    assert.deepEqual(
      await resolveOpenableWorkspacePath(
        { workspaceId: 'ws', path: 'proposal.md' },
        { getWorkspaceById: (() => { throw new Error('lookup failed'); }) as any, realpath: fs.promises.realpath },
      ),
      { ok: false, reason: 'unreadable' },
    );
    assert.deepEqual(
      await resolveOpenableWorkspacePath(undefined as any, deps),
      { ok: false, reason: 'unreadable' },
    );

    const handlers = new Map<string, (...args: any[]) => unknown>();
    const sentinel = { ok: true as const, canonicalPath: 'C:\\canonical\\proposal.md' };
    production.registerResolveOpenableWorkspacePathIpc(
      { handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); } } as any,
      async () => sentinel,
    );
    const handler = handlers.get('files:resolveOpenableWorkspacePath');
    assert.ok(handler, 'REACHABILITY:resolve-openable-path production main registration');
    assert.deepEqual(
      await handler({}, { workspaceId: 'ws', path: 'proposal.md' }),
      sentinel,
      'production handler must invoke its resolver and return the typed result',
    );

    const electronPath = require.resolve('electron');
    const preloadPath = require.resolve('../preload/index');
    const priorElectron = require.cache[electronPath];
    const priorPreload = require.cache[preloadPath];
    let exposedApi: any;
    let invoked: unknown[] | undefined;
    const noop = () => undefined;
    require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {
      contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { exposedApi = api; } },
      ipcRenderer: { invoke: (...args: unknown[]) => { invoked = args; }, on: noop, removeListener: noop },
      webUtils: { getPathForFile: () => '' },
    }} as any;
    delete require.cache[preloadPath];
    try {
      require('../preload/index');
      exposedApi.files.resolveOpenableWorkspacePath({ workspaceId: 'ws', path: 'proposal.md' });
      assert.deepEqual(invoked, [
        'files:resolveOpenableWorkspacePath',
        { workspaceId: 'ws', path: 'proposal.md' },
      ], 'REACHABILITY:resolve-openable-path preload bridge');
    } finally {
      if (priorElectron) require.cache[electronPath] = priorElectron; else delete require.cache[electronPath];
      if (priorPreload) require.cache[preloadPath] = priorPreload; else delete require.cache[preloadPath];
    }

    console.log('  ok  resolve openable workspace path acceptance (8 cases)');
    console.log('REACHABILITY:resolve-openable-path production registration and preload bridge');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
