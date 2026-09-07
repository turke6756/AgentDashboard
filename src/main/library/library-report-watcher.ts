import fs from 'node:fs';
import path from 'node:path';
import type { FsEvent, PathType, Workspace } from '../../shared/types';
import type { LibraryBroadcastEvent } from '../../shared/library';
import { getWorkspaces } from '../database';
import { subscribe } from '../fs-watcher';
import { createLibraryIngestor, withLibraryIngestLock } from './library-ingest';
import { publishLibraryBroadcast } from './library-ipc';
import {
  listLibraryReportSources,
  normalizeLibraryReportKey,
  type LibraryReportRoot,
  type LibraryReportSourcesInventory,
} from './library-report-sources';
import { invalidateLibraryShelfHashes } from './library-shelf';
import {
  closeLibraryStore,
  deleteLibraryDocumentsByRelPaths,
  listLibraryDocuments,
  openLibraryStore,
  type LibraryStore,
} from './library-store';

export const LIBRARY_REPORT_COALESCE_MS = 250;
export const LIBRARY_REPORT_SETTLE_MS = 500;
export const LIBRARY_REPORT_REFRESH_MS = 30_000;

export interface LibraryReportWatcherScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(timer: unknown): void;
}

interface ObservedTuple { size: number; mtimeMs: number; observedAt: number; ingested: boolean; eligible: boolean }
interface WorkspaceState {
  workspace: Workspace;
  subscriptions: Map<string, () => void>;
  observed: Map<string, ObservedTuple>;
  settleTimers: Map<string, unknown>;
  coalesceTimer: unknown | null;
  running: boolean;
  dirty: boolean;
  pendingAllowsSettle: boolean;
  stopped: boolean;
}

export interface LibraryReportWatcherOptions {
  now?: () => number;
  scheduler?: LibraryReportWatcherScheduler;
  getWorkspaces?: () => Workspace[];
  subscribe?: (dirPath: string, pathType: PathType, listener: (event: FsEvent) => void) => () => void;
  inventory?: (workspaceRoot: string) => Promise<LibraryReportSourcesInventory>;
  openStore?: (workspaceRoot: string) => LibraryStore;
  closeStore?: (store: LibraryStore) => void;
  listDocuments?: typeof listLibraryDocuments;
  deleteDocuments?: typeof deleteLibraryDocumentsByRelPaths;
  ingest?: (args: { workspaceId: string; workspaceRoot: string; store: LibraryStore; sourcePath: string; trigger: 'report-arrival' }) => Promise<unknown>;
  publish?: (event: LibraryBroadcastEvent) => void;
  ensureDirectory?: (directory: string, pathType: PathType) => void;
  log?: (message: string, error?: unknown) => void;
}

const realScheduler: LibraryReportWatcherScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

const ROOTS = ['inbox', 'cleared'] as const;
const PREFIXES = { inbox: '.lares/library/inbox/', cleared: '.lares/library/cleared/' } as const;
const canonicalDirectory = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const relPath = (root: LibraryReportRoot, child: string): string => normalizeLibraryReportKey(`${PREFIXES[root]}${child}`);
const tupleMatches = (a: ObservedTuple, size: number, mtimeMs: number): boolean => a.size === size && a.mtimeMs === mtimeMs;

export class LibraryReportWatcher {
  private readonly options: Required<Pick<LibraryReportWatcherOptions, 'now' | 'scheduler' | 'getWorkspaces' | 'subscribe' | 'inventory' | 'openStore' | 'closeStore' | 'listDocuments' | 'deleteDocuments' | 'ingest' | 'publish' | 'ensureDirectory' | 'log'>>;
  private readonly states = new Map<string, WorkspaceState>();
  private refreshTimer: unknown | null = null;
  private started = false;

  constructor(options: LibraryReportWatcherOptions = {}) {
    this.options = {
      now: options.now ?? (() => Date.now()),
      scheduler: options.scheduler ?? realScheduler,
      getWorkspaces: options.getWorkspaces ?? getWorkspaces,
      subscribe: options.subscribe ?? subscribe,
      inventory: options.inventory ?? listLibraryReportSources,
      openStore: options.openStore ?? openLibraryStore,
      closeStore: options.closeStore ?? closeLibraryStore,
      listDocuments: options.listDocuments ?? listLibraryDocuments,
      deleteDocuments: options.deleteDocuments ?? deleteLibraryDocumentsByRelPaths,
      ingest: options.ingest ?? (async ({ workspaceId, workspaceRoot, store, sourcePath, trigger }) => createLibraryIngestor({
        workspaceRoot,
        store,
        publish: (progress) => publishLibraryBroadcast({ ...progress, workspace_id: workspaceId }),
      })({ source_path: sourcePath, trigger })),
      publish: options.publish ?? publishLibraryBroadcast,
      ensureDirectory: options.ensureDirectory ?? ((directory, pathType) => { if (pathType === 'windows') fs.mkdirSync(directory, { recursive: true }); }),
      log: options.log ?? ((message, error) => error === undefined ? console.log(`[library-report-watcher] ${message}`) : console.error(`[library-report-watcher] ${message}`, error)),
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.attachAll();
    if (this.started) this.refreshTimer = this.options.scheduler.setInterval(() => { void this.attachAll(); }, LIBRARY_REPORT_REFRESH_MS);
  }

  stop(): void {
    this.started = false;
    if (this.refreshTimer !== null) this.options.scheduler.clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    for (const state of this.states.values()) {
      state.stopped = true;
      state.dirty = false;
      if (state.coalesceTimer !== null) this.options.scheduler.clearTimeout(state.coalesceTimer);
      for (const timer of state.settleTimers.values()) this.options.scheduler.clearTimeout(timer);
      for (const unsubscribe of state.subscriptions.values()) { try { unsubscribe(); } catch { /* best effort */ } }
      state.coalesceTimer = null;
      state.settleTimers.clear();
      state.subscriptions.clear();
      state.observed.clear();
    }
    this.states.clear();
  }

  private async attachAll(): Promise<void> {
    let workspaces: Workspace[];
    try { workspaces = this.options.getWorkspaces(); }
    catch (error) { this.options.log('workspace enumeration failed', error); return; }
    const live = new Set(workspaces.map((workspace) => workspace.id));
    for (const [id, state] of this.states) if (!live.has(id)) this.detach(state);
    for (const workspace of workspaces) {
      const existing = this.states.get(workspace.id);
      if (existing) { await this.enqueue(existing, false); continue; }
      await this.attach(workspace);
    }
  }

  private async attach(workspace: Workspace): Promise<void> {
    const state: WorkspaceState = { workspace, subscriptions: new Map(), observed: new Map(), settleTimers: new Map(), coalesceTimer: null, running: false, dirty: false, pendingAllowsSettle: false, stopped: false };
    this.states.set(workspace.id, state);
    await this.enqueue(state, false, true);
  }

  private detach(state: WorkspaceState): void {
    state.stopped = true;
    state.dirty = false;
    state.pendingAllowsSettle = false;
    for (const unsubscribe of state.subscriptions.values()) { try { unsubscribe(); } catch { /* best effort */ } }
    for (const timer of state.settleTimers.values()) this.options.scheduler.clearTimeout(timer);
    if (state.coalesceTimer !== null) this.options.scheduler.clearTimeout(state.coalesceTimer);
    state.coalesceTimer = null;
    state.settleTimers.clear();
    state.subscriptions.clear();
    state.observed.clear();
    this.states.delete(state.workspace.id);
  }

  private subscribeDirectory(state: WorkspaceState, directory: string, pathType: PathType): void {
    const key = canonicalDirectory(directory);
    if (state.subscriptions.has(key)) return;
    try { state.subscriptions.set(key, this.options.subscribe(directory, pathType, (event) => this.onEvent(state, event))); }
    catch (error) { this.options.log(`subscribe failed for ${directory}`, error); }
  }

  private syncSubscriptions(state: WorkspaceState, inventory: LibraryReportSourcesInventory): void {
    const wanted = new Map(ROOTS.map((root) => {
      const abs_path = path.join(state.workspace.path, '.lares', 'library', root);
      return [canonicalDirectory(abs_path), { abs_path, pathType: state.workspace.pathType }] as const;
    }));
    for (const root of ROOTS) for (const directory of inventory[root].directories) {
      wanted.set(canonicalDirectory(directory.abs_path), directory);
    }
    for (const directory of wanted.values()) this.subscribeDirectory(state, directory.abs_path, directory.pathType);
    for (const [key, unsubscribe] of state.subscriptions) {
      if (wanted.has(key)) continue;
      try { unsubscribe(); } catch { /* best effort */ }
      state.subscriptions.delete(key);
    }
  }

  private onEvent(state: WorkspaceState, event: FsEvent): void {
    if (state.stopped) return;
    invalidateLibraryShelfHashes([event.path]);
    this.options.publish({ type: 'library:shelf-changed', workspace_id: state.workspace.id });
    if (state.coalesceTimer !== null) this.options.scheduler.clearTimeout(state.coalesceTimer);
    state.coalesceTimer = this.options.scheduler.setTimeout(() => {
      state.coalesceTimer = null;
      void this.enqueue(state, true);
    }, LIBRARY_REPORT_COALESCE_MS);
  }

  private async enqueue(state: WorkspaceState, allowSettle: boolean, attach = false): Promise<void> {
    if (state.stopped) return;
    if (state.running) {
      state.dirty = true;
      state.pendingAllowsSettle ||= allowSettle;
      return;
    }
    state.running = true;
    let nextAllowsSettle = allowSettle;
    try {
      if (attach) {
        for (const root of ROOTS) {
          const directory = path.join(state.workspace.path, '.lares', 'library', root);
          try { this.options.ensureDirectory(directory, state.workspace.pathType); }
          catch (error) { this.options.log(`could not ensure ${directory}`, error); }
          this.subscribeDirectory(state, directory, state.workspace.pathType);
        }
        const first = await this.options.inventory(state.workspace.path);
        if (state.stopped) return;
        this.syncSubscriptions(state, first);
        await this.reconcile(state, first, false, false);
        if (state.stopped) return;
        const second = await this.options.inventory(state.workspace.path);
        if (state.stopped) return;
        this.syncSubscriptions(state, second);
        await this.reconcile(state, second, false, true);
      }
      do {
        if (attach && !state.dirty) break;
        nextAllowsSettle ||= state.pendingAllowsSettle;
        state.pendingAllowsSettle = false;
        state.dirty = false;
        const inventory = await this.options.inventory(state.workspace.path);
        if (state.stopped) return;
        this.syncSubscriptions(state, inventory);
        await this.reconcile(state, inventory, nextAllowsSettle, true);
        nextAllowsSettle = false;
      } while (!state.stopped && state.dirty);
    } catch (error) {
      this.options.log(`reconcile failed for ${state.workspace.id}`, error);
      for (const [key, tuple] of state.observed) if (tuple.eligible && !tuple.ingested) this.scheduleSettle(state, key, true);
    } finally {
      const rerun = !state.stopped && state.dirty;
      const rerunAllowsSettle = state.pendingAllowsSettle;
      state.running = false;
      if (rerun) void this.enqueue(state, rerunAllowsSettle);
    }
  }

  private scheduleSettle(state: WorkspaceState, key: string, restart = false): void {
    if (state.stopped) return;
    const existing = state.settleTimers.get(key);
    if (existing !== undefined) {
      if (!restart) return;
      this.options.scheduler.clearTimeout(existing);
    }
    const timer = this.options.scheduler.setTimeout(() => {
      state.settleTimers.delete(key);
      void this.enqueue(state, true);
    }, LIBRARY_REPORT_SETTLE_MS);
    state.settleTimers.set(key, timer);
  }

  private async reconcile(state: WorkspaceState, inventory: LibraryReportSourcesInventory, allowSettle: boolean, deleteMissing: boolean): Promise<void> {
    if (state.stopped) return;
    const now = this.options.now();
    const present = new Set<string>();
    const settled: Array<{ key: string; sourcePath: string; tuple: ObservedTuple }> = [];
    let shelfChanged = false;
    for (const root of ROOTS) for (const file of inventory[root].files) {
      const key = relPath(root, file.rel_path);
      present.add(key);
      const previous = state.observed.get(key);
      if (!previous || !tupleMatches(previous, file.size, file.mtimeMs)) {
        if (previous) invalidateLibraryShelfHashes([file.abs_path]);
        const eligible = allowSettle || previous?.eligible === true;
        const tuple = { size: file.size, mtimeMs: file.mtimeMs, observedAt: now, ingested: false, eligible };
        state.observed.set(key, tuple);
        if (eligible) this.scheduleSettle(state, key, true);
        shelfChanged = true;
      } else if (!previous.eligible && allowSettle) {
        previous.eligible = true;
        previous.observedAt = now;
        this.scheduleSettle(state, key, true);
      } else if (previous.eligible && !previous.ingested && allowSettle && now - previous.observedAt >= LIBRARY_REPORT_SETTLE_MS) {
        settled.push({ key, sourcePath: file.abs_path, tuple: previous });
      } else if (previous.eligible && !previous.ingested) this.scheduleSettle(state, key);
    }
    for (const [key] of state.observed) if (!present.has(key)) {
      state.observed.delete(key);
      const timer = state.settleTimers.get(key);
      if (timer !== undefined) this.options.scheduler.clearTimeout(timer);
      state.settleTimers.delete(key);
    }

    const store = this.options.openStore(state.workspace.path);
    try {
      const rows = this.options.listDocuments(store, { include_untrusted: true });
      const deleted: string[] = [];
      for (const root of ROOTS) {
        if (!deleteMissing) continue;
        if (inventory[root].health !== 'complete') continue;
        const prefix = normalizeLibraryReportKey(PREFIXES[root]);
        const disk = new Set(inventory[root].files.map((file) => relPath(root, file.rel_path)));
        for (const row of rows) {
          const key = normalizeLibraryReportKey(row.source_rel_path);
          if (key.startsWith(prefix) && !disk.has(key)) deleted.push(row.source_rel_path);
        }
      }
      if (deleted.length > 0) {
        this.options.deleteDocuments(store, deleted);
        shelfChanged = true;
      }
      if (shelfChanged) this.options.publish({ type: 'library:shelf-changed', workspace_id: state.workspace.id });
      for (const candidate of settled) {
        if (state.stopped) break;
        await withLibraryIngestLock(state.workspace.path, () => this.options.ingest({ workspaceId: state.workspace.id, workspaceRoot: state.workspace.path, store, sourcePath: candidate.sourcePath, trigger: 'report-arrival' }));
        candidate.tuple.ingested = true;
        this.options.publish({ type: 'library:shelf-changed', workspace_id: state.workspace.id });
      }
    } finally { this.options.closeStore(store); }
  }
}

export async function startLibraryReportWatcher(options?: LibraryReportWatcherOptions): Promise<LibraryReportWatcher> {
  const watcher = new LibraryReportWatcher(options);
  await watcher.start();
  return watcher;
}
