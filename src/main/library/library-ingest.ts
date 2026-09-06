import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type {
  LibraryDocumentStatus,
  LibraryDocumentType,
  LibraryIngestTrigger,
  LibraryProgressEvent,
  LibraryTrust,
} from '../../shared/library';
import { CHUNKER_VERSION, TOKENIZER_VERSION, chunkDocument } from './library-chunker';
import { extractDocx } from './docx-extractor';
import { extractPdf } from './pdf-extractor';
import { embedLibraryTexts, encodeLibraryEmbedding } from './library-embedder';
import {
  getLibraryDocument,
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
}

export interface LibraryIngestResult {
  document: LibraryDocumentRow;
  reused: boolean;
  chunk_ids: string[];
}

export interface LibraryIngestDependencies {
  workspaceRoot: string;
  store: LibraryStore;
  publish?: (event: LibraryProgressEvent) => void;
  embedTexts?: typeof embedLibraryTexts;
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

export function createLibraryIngestor(deps: LibraryIngestDependencies) {
  const publish = (id: string, status: LibraryDocumentStatus, error_reason?: string) => {
    deps.publish?.({ document_id: id, status, ...(error_reason ? { error_reason } : {}) });
  };

  return async function ingest(input: IngestDocumentInput): Promise<LibraryIngestResult> {
    const absolute = path.resolve(input.source_path);
    const bytes = await fs.readFile(absolute);
    const stat = await fs.stat(absolute);
    const sourceHash = createHash('sha256').update(bytes).digest('hex');
    const id = input.document_id ?? documentId(relativePath(deps.workspaceRoot, absolute));
    const existing = getLibraryDocument(deps.store, id);
    const currentContract = existing?.chunker_version === CHUNKER_VERSION
      && existing?.tokenizer_version === TOKENIZER_VERSION;
    if (input.trigger === 'rescan' && existing?.source_hash === sourceHash
      && existing.status === 'ready' && currentContract) {
      const rows = deps.store.database.prepare(
        `SELECT id FROM library_chunks WHERE document_id = ? ORDER BY ordinal`,
      ).all(id) as Array<{ id: string }>;
      return { document: existing, reused: true, chunk_ids: rows.map((row) => row.id) };
    }

    const type = input.type ?? existing?.type ?? inferType(absolute);
    const base: LibraryDocumentRow = {
      id,
      type,
      title: path.basename(absolute),
      created: existing?.created ?? new Date(0).toISOString(),
      topics_json: existing?.topics_json ?? '[]',
      trust: input.trust ?? existing?.trust ?? 'user-trusted',
      source_rel_path: relativePath(deps.workspaceRoot, absolute),
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
    };
    upsertLibraryDocument(deps.store, base);
    publish(id, 'queued');

    try {
      setLibraryDocumentStatus(deps.store, id, 'extracting');
      publish(id, 'extracting');
      let chunks;
      if (type === 'pdf') {
        const extracted = await extractPdf(absolute);
        base.page_count = extracted.page_count;
        chunks = chunkDocument({ document_id: id, source_hash: sourceHash, kind: 'pdf', pages: extracted.pages });
      } else if (type === 'docx') {
        const extracted = await extractDocx(deps.workspaceRoot, absolute, id);
        base.reader_rel_path = extracted.reader_rel_path;
        chunks = chunkDocument({
          document_id: id,
          source_hash: sourceHash,
          kind: 'docx-markdown',
          text: extracted.markdown,
          derived_rel_path: extracted.reader_rel_path,
          include_byte_map: true,
        });
      } else {
        chunks = chunkDocument({
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
