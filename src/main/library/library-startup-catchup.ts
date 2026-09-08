import type { LibraryRescanResult } from '../../shared/library';

export interface LibraryStartupWebContents {
  on(event: 'did-finish-load', listener: () => void): unknown;
  removeListener(event: 'did-finish-load', listener: () => void): unknown;
  getURL(): string;
  isLoadingMainFrame?(): boolean;
}

export interface LibraryStartupScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface LibraryStartupCoordinator {
  run(workspaceId: string, initiator: 'automatic'): Promise<LibraryRescanResult>;
}

export interface LibraryStartupCatchup {
  stop(): void;
  done: Promise<void>;
}

const realScheduler: LibraryStartupScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function createLibraryMainWindowInteractiveBarrier(
  webContents: LibraryStartupWebContents,
  options: { scheduler?: LibraryStartupScheduler; diagnosticTimeoutMs?: number; log?: (message: string) => void } = {},
): Promise<void> {
  const scheduler = options.scheduler ?? realScheduler;
  const log = options.log ?? ((message) => console.warn(`[library-startup] ${message}`));
  const diagnosticTimeoutMs = options.diagnosticTimeoutMs ?? 15_000;
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      scheduler.clearTimeout(diagnosticTimer);
      webContents.removeListener('did-finish-load', finish);
      resolve();
    };
    webContents.on('did-finish-load', finish);
    const diagnosticTimer = scheduler.setTimeout(() => {
      log('main-window interactive barrier is still waiting for did-finish-load');
    }, diagnosticTimeoutMs);
    const url = webContents.getURL();
    if (url && url !== 'about:blank' && webContents.isLoadingMainFrame?.() === false) finish();
  });
}

export function startLibraryStartupCatchup(options: {
  watcherAttached: Promise<unknown>;
  mainWindowInteractive: Promise<unknown>;
  listWorkspaceIds: () => string[];
  coordinator: LibraryStartupCoordinator;
  log?: (message: string, error?: unknown) => void;
}): LibraryStartupCatchup {
  let stopped = false;
  const log = options.log ?? ((message, error) => error === undefined
    ? console.log(`[library-startup] ${message}`)
    : console.error(`[library-startup] ${message}`, error));
  const done = Promise.all([options.watcherAttached, options.mainWindowInteractive])
    .then(async () => {
      if (stopped) return;
      for (const workspaceId of options.listWorkspaceIds()) {
        if (stopped) return;
        try { await options.coordinator.run(workspaceId, 'automatic'); }
        catch (error) { log(`catch-up failed for ${workspaceId}`, error); }
      }
    })
    .catch((error) => log('startup barrier failed', error));
  return { stop: () => { stopped = true; }, done };
}
