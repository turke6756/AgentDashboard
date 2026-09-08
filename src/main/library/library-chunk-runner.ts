// Off-main-thread Library chunking.
//
// Rule this file exists to enforce: CPU-bound work never runs on the Electron
// main thread. The main thread is the app's event loop — every IPC reply, timer,
// file watcher callback, and window paint request waits behind whatever is
// running there. A synchronous tokenizer call that takes 60 s is a 60 s UI
// freeze; a worker thread doing the same work is invisible to the user.
//
// Design:
//   - One lazily-created `worker_threads` Worker, reused across requests so the
//     tokenizer's ~2 MB rank table is loaded once, not per document.
//   - Requests are correlated by id so callers can await their own result.
//   - The worker shuts itself down after IDLE_MS with no work so an idle app
//     holds no extra thread or heap.
//   - Any spawn failure (missing worker file in an unusual packaging layout)
//     falls back to the in-process chunker rather than breaking ingest — but it
//     logs, because that fallback reintroduces the freeze.
import path from 'path';
import { Worker } from 'worker_threads';
import { chunkDocument, type ChunkDocumentInput, type LibraryChunk } from './library-chunker';
import type { ChunkWorkerRequest, ChunkWorkerResponse } from './library-chunker-worker';

export const CHUNK_WORKER_IDLE_MS = 30_000;

interface Pending { resolve: (chunks: LibraryChunk[]) => void; reject: (error: Error) => void }

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function workerPath(): string {
  return path.join(__dirname, 'library-chunker-worker.js');
}

function failAll(error: Error): void {
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
}

function stopWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  const current = worker;
  worker = undefined;
  if (current) void current.terminate();
}

function armIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (pending.size === 0) stopWorker(); }, CHUNK_WORKER_IDLE_MS);
  // Never keep the process alive just to time out an idle helper thread.
  (idleTimer as { unref?: () => void }).unref?.();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(workerPath());
  created.on('message', (response: ChunkWorkerResponse) => {
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.error !== undefined) entry.reject(new Error(response.error));
    else entry.resolve(response.chunks ?? []);
    if (pending.size === 0) armIdleShutdown();
  });
  created.on('error', (error) => {
    if (worker !== created) return;
    failAll(error instanceof Error ? error : new Error(String(error)));
    stopWorker();
  });
  created.on('exit', (code) => {
    // A worker we already replaced or shut down had its requests failed at that
    // time; its late exit must not reject work queued on the successor.
    if (worker !== created) return;
    worker = undefined;
    if (code !== 0) failAll(new Error(`Library chunk worker exited with code ${code}`));
  });
  // A worker thread must not keep the app alive during shutdown.
  created.unref();
  worker = created;
  return created;
}

/**
 * Chunk a document on a worker thread. Same result as `chunkDocument`, but the
 * main thread stays free while the tokenizer runs.
 */
export function chunkDocumentOffThread(input: ChunkDocumentInput): Promise<LibraryChunk[]> {
  let active: Worker;
  try {
    active = ensureWorker();
  } catch (error) {
    console.error('[library] chunk worker unavailable; chunking on the main thread', error);
    return Promise.resolve(chunkDocument(input));
  }
  const id = nextId++;
  return new Promise<LibraryChunk[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
    // The worker must be referenced while it has our work, or a quiet process could exit mid-chunk.
    active.ref();
    const request: ChunkWorkerRequest = { id, input };
    active.postMessage(request);
  }).finally(() => { if (pending.size === 0) active.unref(); });
}

/** Test/shutdown hook: drop the helper thread immediately. */
export function shutdownChunkWorker(): void {
  failAll(new Error('Library chunk worker shut down'));
  stopWorker();
}
