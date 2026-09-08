import path from 'path';
import { fork, spawnSync } from 'child_process';
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

export function resolveLibraryModelRoot(): string {
  return app?.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'models')
    : path.join(process.cwd(), 'assets', 'models');
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

/** Run model work outside Electron's main process. Remote model fetches are refused by the worker. */
export const EMBED_TIMEOUT_BASE_MS = 30_000;
export const EMBED_TIMEOUT_PER_TEXT_MS = 1_500;
export const EMBED_TIMEOUT_MAX_MS = 10 * 60_000;

/** Model load plus a per-chunk allowance: a 48 KB report is ~35 chunks and legitimately takes >30 s on single-thread wasm. */
export function embedTimeoutMs(textCount: number): number {
  return Math.min(EMBED_TIMEOUT_MAX_MS, EMBED_TIMEOUT_BASE_MS + EMBED_TIMEOUT_PER_TEXT_MS * textCount);
}

export function embedLibraryTexts(texts: string[], modelRoot = resolveLibraryModelRoot()): Promise<LibraryEmbeddingBatch> {
  if (texts.length === 0) return Promise.resolve({ vectors: [], load_ms: 0, embed_ms: 0 });
  const timeoutMs = embedTimeoutMs(texts.length);
  const workerPath = path.join(__dirname, 'library-embedder-worker.js');
  return new Promise((resolve, reject) => {
    const electronChild = utilityProcess?.fork
      ? utilityProcess.fork(workerPath, [], { stdio: 'pipe', serviceName: 'Lares Library Embedder' })
      : undefined;
    const nodeChild = electronChild ? undefined : fork(workerPath, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const child: any = electronChild ?? nodeChild!;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Library embedder timed out after ${Math.round(timeoutMs / 1000)} seconds (${texts.length} chunks)`));
    }, timeoutMs);
    child.once('spawn', () => {
      if (electronChild) electronChild.postMessage({ id: 1, modelRoot, texts });
      else nodeChild!.send({ id: 1, modelRoot, texts });
    });
    child.once('message', (message: WorkerResponse) => {
      clearTimeout(timer);
      child.kill();
      try { resolve(readResponse(message)); } catch (error) { reject(error); }
    });
    child.once('exit', (code: number) => {
      if (code !== 0 && code !== 15) {
        clearTimeout(timer);
        reject(new Error(`Library embedder exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
      }
    });
  });
}

/** Compatibility bridge for the existing synchronous queryLibrary production seam. */
export function embedLibraryTextSync(text: string, modelRoot = resolveLibraryModelRoot()): Float32Array {
  const workerPath = path.join(__dirname, 'library-embedder-worker.js');
  const encoded = Buffer.from(JSON.stringify([text]), 'utf8').toString('base64');
  const run = spawnSync(process.execPath, [workerPath, encoded, modelRoot], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`Library query embedder failed: ${run.stderr || run.stdout}`);
  return readResponse(JSON.parse(run.stdout) as WorkerResponse).vectors[0];
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
