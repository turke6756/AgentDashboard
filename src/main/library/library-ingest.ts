import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type {
  LibraryDocumentStatus,
  LibraryDocumentType,
  LibraryHashReuseTrigger,
  LibraryIngestTrigger,
  LibraryProgressEvent,
  LibraryRescanInitiator,
  LibraryTrust,
} from '../../shared/library';
import { CHUNKER_VERSION, TOKENIZER_VERSION } from './library-chunker';
import { chunkDocumentOffThread } from './library-chunk-runner';
import { extractDocx } from './docx-extractor';
import { extractPdf } from './pdf-extractor';
import { embedLibraryTexts, encodeLibraryEmbedding } from './library-embedder';
import {
  getLibraryDocument,
  incrementLibraryDocumentAttempt,
  replaceLibraryChunks,
  setLibraryDocumentStatus,
  upsertLibraryDocument,
  type LibraryDocumentRow,
  type LibraryStore,
} from './library-store';

export interface IngestDocumentInput {
  source_path: string;
  trigger: LibraryIngestTrigger;
  document_id?: string;
  type?: LibraryDocumentType;
  trust?: LibraryTrust;
  initiator?: LibraryRescanInitiator;
}

export interface LibraryIngestResult {
  document: LibraryDocumentRow;
  reused: boolean;
  chunk_ids: string[];
  /** True when an automatic attempt found an error row whose durable budget is exhausted. */
  skipped_error?: true;
}

export interface LibraryIngestDependencies {
  workspaceRoot: string;
  store: LibraryStore;
  publish?: (event: LibraryProgressEvent) => void;
  embedTexts?: typeof embedLibraryTexts;
}

const workspaceIngestTails = new Map<string, Promise<void>>();

function workspaceIngestKey(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Serialize every index mutation for one workspace, regardless of its caller. */
export async function withLibraryIngestLock<T>(workspaceRoot: string, work: () => Promise<T>): Promise<T> {
  const key = workspaceIngestKey(workspaceRoot);
  const previous = workspaceIngestTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  workspaceIngestTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (workspaceIngestTails.get(key) === tail) workspaceIngestTails.delete(key);
  }
}

function inferType(filePath: string): LibraryDocumentType {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.md' || ext === '.markdown') return 'md';
  return 'txt';
}

function documentId(sourcePath: string): string {
  return createHash('sha256').update(sourcePath.replace(/\\/g, '/')).digest('hex').slice(0, 24);
}

function relativePath(root: string, target: string): string {
  return path.relative(root, target).replace(/\\/g, '/');
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function reportFolderDefaults(workspaceRoot: string, sourcePath: string): {
  type: LibraryDocumentType;
  trust: LibraryTrust;
} | undefined {
  const libraryRoot = path.resolve(workspaceRoot, '.lares', 'library');
  if (isWithin(path.join(libraryRoot, 'inbox'), sourcePath)) {
    return { type: 'research', trust: 'untrusted' };
  }
  if (isWithin(path.join(libraryRoot, 'cleared'), sourcePath)) {
    return { type: 'research', trust: 'cleared' };
  }
  return undefined;
}

function permitsHashReuse(trigger: LibraryIngestTrigger): trigger is LibraryHashReuseTrigger {
  return trigger === 'rescan' || trigger === 'report-arrival';
}

export function createLibraryIngestor(deps: LibraryIngestDependencies) {
  return async function ingest(input: IngestDocumentInput): Promise<LibraryIngestResult> {
    const absolute = path.resolve(input.source_path);
    const sourceRelPath = relativePath(deps.workspaceRoot, absolute);
    let attemptCount = 0;
    const publish = (id: string, status: LibraryDocumentStatus, error_reason?: string) => {
      deps.publish?.({ document_id: id, source_rel_path: sourceRelPath, status, attempt_count: attemptCount, ...(error_reason ? { error_reason } : {}) });
    };
    const bytes = await fs.readFile(absolute);
    const stat = await fs.stat(absolute);
    const sourceHash = createHash('sha256').update(bytes).digest('hex');
    const id = input.document_id ?? documentId(sourceRelPath);
    const existing = getLibraryDocument(deps.store, id);
    const folderDefaults = reportFolderDefaults(deps.workspaceRoot, absolute);
    const currentContract = existing?.chunker_version === CHUNKER_VERSION
      && existing?.tokenizer_version === TOKENIZER_VERSION;
    attemptCount = existing?.attempt_count ?? 0;
    if (permitsHashReuse(input.trigger) && existing?.source_hash === sourceHash
      && existing.status === 'ready' && currentContract) {
      const rows = deps.store.database.prepare(
        `SELECT id FROM library_chunks WHERE document_id = ? ORDER BY ordinal`,
      ).all(id) as Array<{ id: string }>;
      return { document: existing, reused: true, chunk_ids: rows.map((row) => row.id) };
    }
    const automatic = input.trigger === 'report-arrival'
      || (input.trigger === 'rescan' && input.initiator !== 'manual');
    if (automatic && existing?.status === 'error' && currentContract && attemptCount >= 3) {
      return { document: existing, reused: false, chunk_ids: [], skipped_error: true };
    }

    const type = input.type ?? folderDefaults?.type ?? existing?.type ?? inferType(absolute);
    const base: LibraryDocumentRow = {
      id,
      type,
      title: path.basename(absolute),
      created: existing?.created ?? new Date(0).toISOString(),
      topics_json: existing?.topics_json ?? '[]',
      trust: input.trust ?? folderDefaults?.trust ?? existing?.trust ?? 'user-trusted',
      source_rel_path: sourceRelPath,
      reader_rel_path: relativePath(deps.workspaceRoot, absolute),
      source_hash: sourceHash,
      size: stat.size,
      page_count: null,
      provider: existing?.provider ?? null,
      agent_id: existing?.agent_id ?? null,
      summary: existing?.summary ?? null,
      status: 'queued',
      error_reason: null,
      index_generation: (existing?.index_generation ?? -1) + 1,
      chunker_version: CHUNKER_VERSION,
      tokenizer_version: TOKENIZER_VERSION,
      attempt_count: attemptCount,
    };
    deps.store.database.transaction(() => {
      upsertLibraryDocument(deps.store, base);
      attemptCount = incrementLibraryDocumentAttempt(deps.store, id);
      base.attempt_count = attemptCount;
    })();
    publish(id, 'queued');

    try {
      setLibraryDocumentStatus(deps.store, id, 'extracting');
      publish(id, 'extracting');
      let chunks;
      if (type === 'pdf') {
        const extracted = await extractPdf(absolute);
        base.page_count = extracted.page_count;
        chunks = await chunkDocumentOffThread({ document_id: id, source_hash: sourceHash, kind: 'pdf', pages: extracted.pages });
      } else if (type === 'docx') {
        const extracted = await extractDocx(deps.workspaceRoot, absolute, id);
        base.reader_rel_path = extracted.reader_rel_path;
        chunks = await chunkDocumentOffThread({
          document_id: id,
          source_hash: sourceHash,
          kind: 'docx-markdown',
          text: extracted.markdown,
          derived_rel_path: extracted.reader_rel_path,
          include_byte_map: true,
        });
      } else {
        chunks = await chunkDocumentOffThread({
          document_id: id,
          source_hash: sourceHash,
          kind: 'text',
          text: bytes.toString('utf8'),
          include_byte_map: true,
        });
      }
      base.status = 'chunking';
      upsertLibraryDocument(deps.store, base);
      publish(id, 'chunking');
      replaceLibraryChunks(deps.store, id, chunks);
      setLibraryDocumentStatus(deps.store, id, 'embedding');
      publish(id, 'embedding');
      const embedded = await (deps.embedTexts ?? embedLibraryTexts)(chunks.map((chunk) => chunk.content));
      deps.store.database.transaction(() => {
        const update = deps.store.database.prepare(`UPDATE library_chunks SET embedding = ? WHERE id = ?`);
        for (let index = 0; index < chunks.length; index += 1) {
          update.run(encodeLibraryEmbedding(embedded.vectors[index]), chunks[index].id);
        }
      })();
      setLibraryDocumentStatus(deps.store, id, 'ready');
      publish(id, 'ready');
      return { document: { ...base, status: 'ready' }, reused: false, chunk_ids: chunks.map((chunk) => chunk.id) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setLibraryDocumentStatus(deps.store, id, 'error', reason);
      publish(id, 'error', reason);
      throw error;
    }
  };
}

export async function ingestLibraryDocuments(
  deps: LibraryIngestDependencies,
  inputs: IngestDocumentInput[],
): Promise<LibraryIngestResult[]> {
  const ingest = createLibraryIngestor(deps);
  const ordered = [...inputs].sort((a, b) => a.source_path.localeCompare(b.source_path, 'en'));
  const results: LibraryIngestResult[] = [];
  for (const input of ordered) results.push(await ingest(input));
  return results;
}
