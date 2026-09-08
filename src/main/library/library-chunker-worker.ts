// Worker-thread entry for Library chunking.
//
// Chunking is pure CPU (BPE tokenization) and used to run on the Electron main
// thread, where a single large report blocked every IPC, timer, and renderer
// request for the duration. This file is the body of a `worker_threads` Worker:
// it receives one ChunkDocumentInput per message and posts the chunk list back.
// It has no Electron imports so it also runs under plain Node in tests.
//
// The host side (spawn, request routing, idle shutdown, sync fallback) lives in
// `library-chunk-runner.ts`.
import { parentPort } from 'worker_threads';
import { chunkDocument, type ChunkDocumentInput, type LibraryChunk } from './library-chunker';

export interface ChunkWorkerRequest { id: number; input: ChunkDocumentInput }
export interface ChunkWorkerResponse { id: number; chunks?: LibraryChunk[]; error?: string }

if (parentPort) {
  parentPort.on('message', (request: ChunkWorkerRequest) => {
    let response: ChunkWorkerResponse;
    try {
      response = { id: request.id, chunks: chunkDocument(request.input) };
    } catch (error) {
      response = { id: request.id, error: error instanceof Error ? error.message : String(error) };
    }
    parentPort!.postMessage(response);
  });
}
