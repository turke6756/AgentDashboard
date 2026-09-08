import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { performance } from 'perf_hooks';

export const LIBRARY_EMBEDDING_DIMENSIONS = 384;
export const LIBRARY_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

interface EmbedRequest {
  id: number;
  modelRoot: string;
  texts: string[];
}

interface EmbedResponse {
  id: number;
  vectors?: number[][];
  load_ms?: number;
  embed_ms?: number;
  error?: string;
}

let extractorPromise: Promise<{ extractor: any; loadMs: number }> | undefined;

async function loadExtractor(modelRoot: string): Promise<{ extractor: any; loadMs: number }> {
  if (extractorPromise) return extractorPromise;
  extractorPromise = (async () => {
    const packageEntry = require.resolve('@huggingface/transformers');
    const packageRoot = path.dirname(path.dirname(packageEntry));
    const moduleUrl = pathToFileURL(path.join(packageRoot, 'dist', 'transformers.web.js')).href;
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const requested = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const normalized = decodeURIComponent(requested).replace(/\\/g, '/');
      const normalizedRoot = path.resolve(modelRoot).replace(/\\/g, '/');
      if (normalized.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
        const diskPath = normalized.split(/[?#]/, 1)[0];
        return new Response(fs.readFileSync(diskPath), { status: 200 });
      }
      throw new Error(`OFFLINE_FETCH_BLOCKED ${requested}`);
    };
    try {
      const savedProcess = globalThis.process;
      (globalThis as any).process = undefined;
      const transformers = await (new Function('url', 'return import(url)') as (url: string) => Promise<any>)(moduleUrl);
      (globalThis as any).process = savedProcess;
      const { env, pipeline } = transformers as any;
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.cacheDir = modelRoot;
      env.localModelPath = modelRoot + path.sep;
      const ortDist = path.dirname(require.resolve('onnxruntime-web'));
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
      env.backends.onnx.wasm.wasmPaths = pathToFileURL(ortDist + path.sep).href;
      const started = performance.now();
      const extractor = await pipeline('feature-extraction', LIBRARY_EMBEDDING_MODEL, {
        device: 'wasm',
        dtype: 'q8',
      });
      return { extractor, loadMs: performance.now() - started };
    } finally {
      globalThis.fetch = nativeFetch;
    }
  })();
  return extractorPromise;
}

async function embed(request: EmbedRequest): Promise<EmbedResponse> {
  try {
    const { extractor, loadMs } = await loadExtractor(request.modelRoot);
    const started = performance.now();
    const vectors: number[][] = [];
    for (const text of request.texts) {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      const vector = Array.from(output.data as Float32Array);
      if (vector.length !== LIBRARY_EMBEDDING_DIMENSIONS) {
        throw new Error(`Expected ${LIBRARY_EMBEDDING_DIMENSIONS} embedding dimensions, got ${vector.length}`);
      }
      vectors.push(vector);
    }
    return { id: request.id, vectors, load_ms: loadMs, embed_ms: performance.now() - started };
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.stack ?? error.message : String(error) };
  }
}

const parentPort = (process as NodeJS.Process & { parentPort?: NodeJS.EventEmitter & { postMessage(value: unknown): void } }).parentPort;
let embedTail = Promise.resolve();

function enqueue(request: EmbedRequest, send: (response: EmbedResponse) => void): void {
  const result = embedTail.then(() => embed(request));
  embedTail = result.then(() => undefined, () => undefined);
  void result.then(send);
}

if (parentPort) {
  parentPort.on('message', (event: any) => {
    const request = (event?.data ?? event) as EmbedRequest;
    enqueue(request, (response) => parentPort.postMessage(response));
  });
} else if (typeof process.send === 'function') {
  const send = process.send.bind(process);
  process.on('message', (request: EmbedRequest) => {
    enqueue(request, (response) => send(response));
  });
}
