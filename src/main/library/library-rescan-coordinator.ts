import type { LibraryProgressEvent, LibraryRescanInitiator, LibraryRescanResult } from '../../shared/library';
import { rescanLibraryReportsDetailed, type LibraryRescanExecutionResult } from './library-rescan';
import { closeLibraryStore, openLibraryStore, type LibraryStore } from './library-store';

export const LIBRARY_MAX_AUTOMATIC_ATTEMPTS = 3;
export const LIBRARY_RETRY_DELAYS_MS = [1_000, 4_000] as const;

export interface LibraryCoordinatorWorkspace { id: string; path: string }

export interface LibraryRescanCoordinatorScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface LibraryRescanCoordinatorDependencies {
  resolveWorkspace(workspaceId: string): LibraryCoordinatorWorkspace | null;
  openStore?: (workspaceRoot: string) => LibraryStore;
  closeStore?: (store: LibraryStore) => void;
  scheduler?: LibraryRescanCoordinatorScheduler;
  now?: () => number;
  publish?: (event: LibraryProgressEvent & { workspace_id: string }) => void;
  rescan?: (args: {
    workspaceRoot: string;
    store: LibraryStore;
    initiator: LibraryRescanInitiator;
    publish: (event: LibraryProgressEvent) => void;
  }) => Promise<LibraryRescanExecutionResult>;
  log?: (message: string, error?: unknown) => void;
}

interface QueuedRun {
  initiator: LibraryRescanInitiator;
  resolve: (result: LibraryRescanResult) => void;
  reject: (error: unknown) => void;
}

interface WorkspaceQueue {
  active: Promise<void> | null;
  queued: QueuedRun[];
  retryTimer: unknown | null;
  retryDueAt: number | null;
}

const realScheduler: LibraryRescanCoordinatorScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const publicSummary = ({ scanned, ingested, skipped, failed }: LibraryRescanExecutionResult): LibraryRescanResult =>
  ({ scanned, ingested, skipped, failed });

export class LibraryRescanCoordinator {
  private readonly deps: Required<LibraryRescanCoordinatorDependencies>;
  private readonly workspaces = new Map<string, WorkspaceQueue>();
  private stopped = false;

  constructor(deps: LibraryRescanCoordinatorDependencies) {
    this.deps = {
      resolveWorkspace: deps.resolveWorkspace,
      openStore: deps.openStore ?? openLibraryStore,
      closeStore: deps.closeStore ?? closeLibraryStore,
      scheduler: deps.scheduler ?? realScheduler,
      now: deps.now ?? (() => Date.now()),
      publish: deps.publish ?? (() => undefined),
      rescan: deps.rescan ?? rescanLibraryReportsDetailed,
      log: deps.log ?? ((message, error) => error === undefined
        ? console.log(`[library-rescan] ${message}`)
        : console.error(`[library-rescan] ${message}`, error)),
    };
  }

  run(workspaceId: string, initiator: LibraryRescanInitiator): Promise<LibraryRescanResult> {
    if (this.stopped) return Promise.reject(new Error('Library rescan coordinator is stopped'));
    const state = this.stateFor(workspaceId);
    if (initiator === 'manual') this.cancelRetry(state);
    return new Promise<LibraryRescanResult>((resolve, reject) => {
      const request = { initiator, resolve, reject };
      if (initiator === 'manual') {
        const firstAutomatic = state.queued.findIndex((queued) => queued.initiator === 'automatic');
        if (firstAutomatic < 0) state.queued.push(request);
        else state.queued.splice(firstAutomatic, 0, request);
      } else {
        state.queued.push(request);
      }
      this.pump(workspaceId, state);
    });
  }

  scheduleAutomatic(workspaceId: string): void {
    if (this.stopped) return;
    void this.run(workspaceId, 'automatic').catch((error) => {
      this.deps.log(`automatic rescan failed for ${workspaceId}`, error);
    });
  }

  onAutomaticFailure(workspaceId: string, attemptCount = 1): void {
    if (attemptCount <= 0 || attemptCount >= LIBRARY_MAX_AUTOMATIC_ATTEMPTS) return;
    this.scheduleRetryDelay(workspaceId, LIBRARY_RETRY_DELAYS_MS[attemptCount - 1]);
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      const stoppedError = new Error('Library rescan coordinator stopped before queued work began');
      for (const state of this.workspaces.values()) {
        this.cancelRetry(state);
        for (const request of state.queued.splice(0)) request.reject(stoppedError);
      }
    }
    await Promise.all([...this.workspaces.values()].map((state) => state.active).filter((run): run is Promise<void> => run !== null));
  }

  private stateFor(workspaceId: string): WorkspaceQueue {
    let state = this.workspaces.get(workspaceId);
    if (!state) {
      state = { active: null, queued: [], retryTimer: null, retryDueAt: null };
      this.workspaces.set(workspaceId, state);
    }
    return state;
  }

  private pump(workspaceId: string, state: WorkspaceQueue): void {
    if (state.active || this.stopped) return;
    const request = state.queued.shift();
    if (!request) return;
    const execution = this.execute(workspaceId, request.initiator)
      .then(request.resolve, request.reject)
      .finally(() => {
        state.active = null;
        this.pump(workspaceId, state);
      });
    state.active = execution.then(() => undefined, () => undefined);
  }

  private async execute(workspaceId: string, initiator: LibraryRescanInitiator): Promise<LibraryRescanResult> {
    const workspace = this.deps.resolveWorkspace(workspaceId);
    if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
    const store = this.deps.openStore(workspace.path);
    try {
      const result = await this.deps.rescan({
        workspaceRoot: workspace.path,
        store,
        initiator,
        publish: (event) => this.deps.publish({ ...event, workspace_id: workspace.id }),
      });
      if (initiator === 'automatic') this.scheduleRetry(workspaceId, result);
      return publicSummary(result);
    } finally {
      this.deps.closeStore(store);
    }
  }

  private scheduleRetry(workspaceId: string, result: LibraryRescanExecutionResult): void {
    if (this.stopped) return;
    const delays = result.retryable_failures
      .filter(({ attempt_count }) => attempt_count > 0 && attempt_count < LIBRARY_MAX_AUTOMATIC_ATTEMPTS)
      .map(({ attempt_count }) => LIBRARY_RETRY_DELAYS_MS[attempt_count - 1]);
    if (delays.length === 0) return;
    const delay = Math.min(...delays);
    this.scheduleRetryDelay(workspaceId, delay);
  }

  private scheduleRetryDelay(workspaceId: string, delay: number): void {
    if (this.stopped) return;
    const state = this.stateFor(workspaceId);
    const dueAt = this.deps.now() + delay;
    if (state.retryTimer !== null && state.retryDueAt !== null && state.retryDueAt <= dueAt) return;
    this.cancelRetry(state);
    state.retryDueAt = dueAt;
    state.retryTimer = this.deps.scheduler.setTimeout(() => {
      state.retryTimer = null;
      state.retryDueAt = null;
      this.scheduleAutomatic(workspaceId);
    }, delay);
  }

  private cancelRetry(state: WorkspaceQueue): void {
    if (state.retryTimer !== null) this.deps.scheduler.clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.retryDueAt = null;
  }
}
