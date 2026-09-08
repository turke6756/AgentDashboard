import path from 'path';
import { fork } from 'child_process';
import { app, utilityProcess } from 'electron';
import { LIBRARY_EMBEDDING_DIMENSIONS } from './library-embedder-worker';

export { LIBRARY_EMBEDDING_DIMENSIONS } from './library-embedder-worker';

export interface LibraryEmbeddingBatch {
  vectors: Float32Array[];
  load_ms: number;
  embed_ms: number;
}

interface WorkerResponse {
  id: number;
  vectors?: number[][];
  load_ms?: number;
  embed_ms?: number;
  error?: string;
}

export interface LibraryEmbedderChild {
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  removeAllListeners(event?: string): this;
  kill(): boolean | void;
  send?(message: unknown): boolean | void;
  postMessage?(message: unknown): void;
  unref?(): void;
  channel?: { unref?(): void } | null;
  stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
}

export interface LibraryEmbedderClientDeps {
  spawnChild(workerPath: string): { child: LibraryEmbedderChild; kind: 'node' | 'utility' };
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
  killFallbackMs: number;
}

interface PendingRequest {
  generation: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: LibraryEmbeddingBatch): void;
  reject(error: Error): void;
}

interface ChildGeneration {
  id: number;
  child: LibraryEmbedderChild;
  kind: 'node' | 'utility';
  stderr: string;
  exited: Promise<void>;
  markExited(): void;
  retired: boolean;
}

function readResponse(response: WorkerResponse): LibraryEmbeddingBatch {
  if (response.error) throw new Error(response.error);
  if (!response.vectors) throw new Error('Library embedder returned no vectors');
  const vectors = response.vectors.map((values) => {
    const vector = Float32Array.from(values);
    if (vector.length !== LIBRARY_EMBEDDING_DIMENSIONS) {
      throw new Error(`Expected ${LIBRARY_EMBEDDING_DIMENSIONS} embedding dimensions, got ${vector.length}`);
    }
    return vector;
  });
  return { vectors, load_ms: response.load_ms ?? 0, embed_ms: response.embed_ms ?? 0 };
}

export function resolveLibraryModelRoot(): string {
  return app?.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'models')
    : path.join(process.cwd(), 'assets', 'models');
}

export const EMBED_TIMEOUT_BASE_MS = 30_000;
export const EMBED_TIMEOUT_PER_TEXT_MS = 1_500;
export const EMBED_TIMEOUT_MAX_MS = 10 * 60_000;

export function embedTimeoutMs(textCount: number): number {
  return Math.min(EMBED_TIMEOUT_MAX_MS, EMBED_TIMEOUT_BASE_MS + EMBED_TIMEOUT_PER_TEXT_MS * textCount);
}

const productionDeps: LibraryEmbedderClientDeps = {
  spawnChild(workerPath) {
    if (utilityProcess?.fork) {
      return {
        child: utilityProcess.fork(workerPath, [], { stdio: 'pipe', serviceName: 'Lares Library Embedder' }) as unknown as LibraryEmbedderChild,
        kind: 'utility',
      };
    }
    return { child: fork(workerPath, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }) as LibraryEmbedderChild, kind: 'node' };
  },
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  killFallbackMs: 2_000,
};

export function createLibraryEmbedderClient(deps: LibraryEmbedderClientDeps = productionDeps) {
  let generationCounter = 0;
  let requestCounter = 0;
  let active: ChildGeneration | undefined;
  const pending = new Map<number, PendingRequest>();

  const rejectGeneration = (generation: ChildGeneration, primary?: { id: number; error: Error }): void => {
    for (const [id, request] of pending) {
      if (request.generation !== generation.id) continue;
      deps.clearTimer(request.timer);
      pending.delete(id);
      request.reject(primary?.id === id
        ? primary.error
        : new Error(`Library embedder helper generation ${generation.id} was recycled`));
    }
  };

  const retire = (generation: ChildGeneration, primary?: { id: number; error: Error }): void => {
    if (generation.retired) return;
    generation.retired = true;
    if (active === generation) active = undefined;
    rejectGeneration(generation, primary);
    try { generation.child.kill(); } catch { generation.markExited(); }
  };

  const spawnGeneration = (): ChildGeneration => {
    const workerPath = path.join(__dirname, 'library-embedder-worker.js');
    const spawned = deps.spawnChild(workerPath);
    let markExited!: () => void;
    const generation: ChildGeneration = {
      id: ++generationCounter,
      ...spawned,
      stderr: '',
      retired: false,
      exited: new Promise<void>((resolve) => { markExited = resolve; }),
      markExited: () => markExited(),
    };
    active = generation;
    const child = generation.child;
    child.stderr?.on('data', (chunk) => { generation.stderr += String(chunk); });
    child.on('message', (event: any) => {
      if (active !== generation || generation.retired) return;
      const response = (event?.data ?? event) as WorkerResponse;
      const request = pending.get(response.id);
      if (!request || request.generation !== generation.id) return;
      deps.clearTimer(request.timer);
      pending.delete(response.id);
      try { request.resolve(readResponse(response)); } catch (error) {
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once('error', (error: Error) => {
      retire(generation, { id: -1, error: new Error(`Library embedder helper failed: ${error.message}`) });
      generation.markExited();
    });
    child.once('exit', (code: number | null) => {
      generation.markExited();
      if (!generation.retired) {
        const detail = generation.stderr.trim();
        retire(generation, { id: -1, error: new Error(`Library embedder exited ${code}${detail ? `: ${detail}` : ''}`) });
      }
    });
    if (generation.kind === 'node') {
      child.unref?.();
      child.channel?.unref?.();
    }
    return generation;
  };

  const embedTexts = (texts: string[], modelRoot = resolveLibraryModelRoot()): Promise<LibraryEmbeddingBatch> => {
    if (texts.length === 0) return Promise.resolve({ vectors: [], load_ms: 0, embed_ms: 0 });
    const generation = active ?? spawnGeneration();
    const id = ++requestCounter;
    return new Promise<LibraryEmbeddingBatch>((resolve, reject) => {
      const timeoutMs = embedTimeoutMs(texts.length);
      const timer = deps.setTimer(() => {
        retire(generation, {
          id,
          error: new Error(`Library embedder timed out after ${Math.round(timeoutMs / 1000)} seconds (${texts.length} chunks)`),
        });
      }, timeoutMs);
      pending.set(id, { generation: generation.id, timer, resolve, reject });
      try {
        const request = { id, modelRoot, texts };
        if (generation.kind === 'utility') generation.child.postMessage?.(request);
        else generation.child.send?.(request);
      } catch (error) {
        retire(generation, { id, error: error instanceof Error ? error : new Error(String(error)) });
      }
    });
  };

  const shutdown = async (): Promise<void> => {
    const generation = active;
    if (!generation) return;
    retire(generation, { id: -1, error: new Error('Library embedder shut down') });
    await Promise.race([
      generation.exited,
      new Promise<void>((resolve) => {
        const timer = deps.setTimer(resolve, deps.killFallbackMs);
        generation.exited.finally(() => deps.clearTimer(timer));
      }),
    ]);
    generation.child.removeAllListeners();
  };

  return { embedTexts, shutdown };
}

let singleton: ReturnType<typeof createLibraryEmbedderClient> | undefined;

function productionClient(): ReturnType<typeof createLibraryEmbedderClient> {
  return singleton ??= createLibraryEmbedderClient();
}

export function embedLibraryTexts(texts: string[], modelRoot = resolveLibraryModelRoot()): Promise<LibraryEmbeddingBatch> {
  return productionClient().embedTexts(texts, modelRoot);
}

export async function embedLibraryText(text: string, modelRoot = resolveLibraryModelRoot()): Promise<Float32Array> {
  return (await embedLibraryTexts([text], modelRoot)).vectors[0];
}

export async function shutdownLibraryEmbedder(): Promise<void> {
  const current = singleton;
  singleton = undefined;
  await current?.shutdown();
}

export function encodeLibraryEmbedding(vector: Float32Array): Buffer {
  if (vector.length !== LIBRARY_EMBEDDING_DIMENSIONS) {
    throw new Error(`Expected ${LIBRARY_EMBEDDING_DIMENSIONS} embedding dimensions, got ${vector.length}`);
  }
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function decodeLibraryEmbedding(blob: Buffer): Float32Array {
  if (blob.byteLength !== LIBRARY_EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(`Invalid Library embedding byte length ${blob.byteLength}`);
  }
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}
