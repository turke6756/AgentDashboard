import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  type LibraryChunkLocatorV1,
  type LibraryDocumentType,
  type LibraryHighlightSpan,
  type LibraryPdfSourceRange,
  type LibraryTextPosition,
  type LibraryTextSourceRange,
  type LibraryTrust,
  validateChunkLocator,
} from '../../shared/library';
import { ANCHOR_CONTEXT_CHARS } from '../../shared/anchor-constants';
import { CHUNKER_VERSION, TOKENIZER_VERSION, type LibraryChunk } from './library-chunker';
import { formatLibraryCitation } from './library-citation';

export const LIBRARY_SCHEMA_VERSION = 1;
export const LIBRARY_CHUNKER_VERSION = CHUNKER_VERSION;
export const LIBRARY_TOKENIZER_VERSION = TOKENIZER_VERSION;

export class LibrarySchemaTooNewError extends Error {
  readonly code = 'LIBRARY_SCHEMA_TOO_NEW';

  constructor(readonly foundVersion: number, readonly supportedVersion: number) {
    super(`Library schema version ${foundVersion} is newer than supported version ${supportedVersion}`);
    this.name = 'LibrarySchemaTooNewError';
  }
}

export interface LibraryDocumentRow {
  id: string;
  type: LibraryDocumentType;
  title: string;
  created: string;
  topics_json: string;
  trust: LibraryTrust;
  source_rel_path: string;
  reader_rel_path: string;
  source_hash: string;
  size: number;
  page_count: number | null;
  provider: string | null;
  agent_id: string | null;
  summary: string | null;
  status: string;
  error_reason: string | null;
  index_generation: number;
  chunker_version: string;
  tokenizer_version: string;
}

export interface LibraryChunkRow {
  id: string;
  document_id: string;
  ordinal: number;
  content: string;
  content_char_length: number;
  locator_json: string;
  embedding: Buffer | null;
}

export interface LibraryStore {
  readonly database: Database.Database;
  readonly databasePath: string;
}

export interface SaveLibraryNoteInput {
  query: string;
  chunk_ids: string[];
}

export interface LibraryNoteRow {
  id: string;
  document_id: null;
  content: string;
  created: string;
  updated: string;
}

export interface LibraryReadOptions {
  include_untrusted?: boolean;
}

export interface QueryLibraryArgs {
  query: string;
  mode?: 'keyword' | 'semantic' | 'hybrid';
  doc_ids?: string[];
  types?: LibraryDocumentType[];
  topics?: string[];
  limit?: number;
  include_untrusted?: boolean;
  highlight_doc_id?: string;
}

export interface LibraryChunkMatch {
  kind: 'exact';
  chunk_char_start: number;
  chunk_char_end: number;
  text: string;
}

export interface LibraryPassageSpan {
  kind: 'similar';
  chunk_char_start: 0;
  chunk_char_end: number;
}

export interface LibraryQueryExcerpt {
  chunk_id: string;
  doc_id: string;
  document_hash: string;
  title: string;
  type: LibraryDocumentType;
  trust: LibraryTrust;
  source_rel_path: string;
  reader_rel_path: string;
  quote: string;
  citation: string;
  locator: LibraryChunkLocatorV1;
  keyword_matches: LibraryChunkMatch[];
  similar_passage: LibraryPassageSpan | null;
  scores: {
    keyword_rank: number | null;
    semantic_rank: number | null;
    semantic_score: number | null;
    fused_score: number;
  };
}

export interface LibraryQueryResult {
  query: string;
  mode: 'keyword' | 'semantic' | 'hybrid';
  excerpts: LibraryQueryExcerpt[];
  document_highlights?: {
    doc_id: string;
    document_hash: string;
    spans: LibraryHighlightSpan[];
  };
}

interface KeywordRow {
  chunk_id: string;
  doc_id: string;
  document_hash: string;
  title: string;
  type: LibraryDocumentType;
  trust: LibraryTrust;
  source_rel_path: string;
  reader_rel_path: string;
  content: string;
  locator_json: string;
  rank: number;
  marked: string;
}

const MIGRATORS: ReadonlyArray<(database: Database.Database) => void> = [
  function migrateToSchemaVersion1(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS library_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        chunker_version TEXT NOT NULL,
        tokenizer_version TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS library_documents (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('research', 'md', 'txt', 'pdf', 'docx', 'note')),
        title TEXT NOT NULL,
        created TEXT NOT NULL,
        topics_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(topics_json)),
        trust TEXT NOT NULL CHECK (trust IN ('untrusted', 'cleared', 'user-trusted')),
        source_rel_path TEXT NOT NULL,
        reader_rel_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        page_count INTEGER CHECK (page_count IS NULL OR page_count >= 0),
        provider TEXT,
        agent_id TEXT,
        summary TEXT,
        status TEXT NOT NULL,
        error_reason TEXT,
        index_generation INTEGER NOT NULL DEFAULT 0 CHECK (index_generation >= 0)
      );

      CREATE TABLE IF NOT EXISTS library_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES library_documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        content TEXT NOT NULL,
        content_char_length INTEGER NOT NULL CHECK (content_char_length >= 0),
        locator_json TEXT NOT NULL CHECK (
          json_valid(locator_json) AND validate_library_locator(locator_json) = 1
        ),
        embedding BLOB,
        UNIQUE (document_id, ordinal)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS library_chunks_fts USING fts5(
        content,
        content='library_chunks',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS library_chunks_fts_insert AFTER INSERT ON library_chunks BEGIN
        INSERT INTO library_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS library_chunks_fts_delete AFTER DELETE ON library_chunks BEGIN
        INSERT INTO library_chunks_fts(library_chunks_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS library_chunks_fts_update AFTER UPDATE OF content ON library_chunks BEGIN
        INSERT INTO library_chunks_fts(library_chunks_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
        INSERT INTO library_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TABLE IF NOT EXISTS library_notes (
        id TEXT PRIMARY KEY,
        document_id TEXT REFERENCES library_documents(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created TEXT NOT NULL,
        updated TEXT NOT NULL
      );

      INSERT INTO library_meta(singleton, schema_version, chunker_version, tokenizer_version)
      VALUES (1, 1, '${LIBRARY_CHUNKER_VERSION}', '${LIBRARY_TOKENIZER_VERSION}');
    `);
  },
];

function tableExists(database: Database.Database, tableName: string): boolean {
  return Boolean(database.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(tableName));
}

function readSchemaVersion(database: Database.Database): number {
  if (!tableExists(database, 'library_meta')) return 0;
  const row = database.prepare(
    `SELECT schema_version FROM library_meta WHERE singleton = 1`,
  ).get() as { schema_version: number } | undefined;
  if (!row || !Number.isInteger(row.schema_version) || row.schema_version < 1) {
    throw new Error('Library metadata is missing a valid schema_version');
  }
  return row.schema_version;
}

function migrateLibraryStore(database: Database.Database, fromVersion: number): void {
  for (let targetVersion = fromVersion + 1; targetVersion <= LIBRARY_SCHEMA_VERSION; targetVersion += 1) {
    const migrate = MIGRATORS[targetVersion - 1];
    if (!migrate) throw new Error(`No Library migrator for schema version ${targetVersion}`);
    database.transaction(() => migrate(database))();
  }
}

export function openLibraryStore(workspaceRoot: string): LibraryStore {
  const libraryDir = path.join(workspaceRoot, '.lares', 'library');
  fs.mkdirSync(libraryDir, { recursive: true });
  const databasePath = path.join(libraryDir, 'library.db');
  const database = new Database(databasePath);

  try {
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.function('validate_library_locator', { deterministic: true }, (locatorJson: unknown) => {
      if (typeof locatorJson !== 'string') return 0;
      try {
        return validateChunkLocator(JSON.parse(locatorJson)) ? 1 : 0;
      } catch {
        return 0;
      }
    });

    const schemaVersion = readSchemaVersion(database);
    if (schemaVersion > LIBRARY_SCHEMA_VERSION) {
      throw new LibrarySchemaTooNewError(schemaVersion, LIBRARY_SCHEMA_VERSION);
    }
    migrateLibraryStore(database, schemaVersion);
    const columns = database.prepare(`PRAGMA table_info(library_documents)`).all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('chunker_version')) {
      database.exec(`ALTER TABLE library_documents ADD COLUMN chunker_version TEXT NOT NULL DEFAULT '${CHUNKER_VERSION}'`);
    }
    if (!names.has('tokenizer_version')) {
      database.exec(`ALTER TABLE library_documents ADD COLUMN tokenizer_version TEXT NOT NULL DEFAULT '${TOKENIZER_VERSION}'`);
    }
    return { database, databasePath };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function getLibraryDocument(store: LibraryStore, id: string): LibraryDocumentRow | undefined {
  return store.database.prepare(`SELECT * FROM library_documents WHERE id = ?`).get(id) as LibraryDocumentRow | undefined;
}

export function upsertLibraryDocument(store: LibraryStore, row: LibraryDocumentRow): void {
  store.database.prepare(`
    INSERT INTO library_documents (
      id, type, title, created, topics_json, trust, source_rel_path, reader_rel_path,
      source_hash, size, page_count, provider, agent_id, summary, status, error_reason,
      index_generation, chunker_version, tokenizer_version
    ) VALUES (
      @id, @type, @title, @created, @topics_json, @trust, @source_rel_path, @reader_rel_path,
      @source_hash, @size, @page_count, @provider, @agent_id, @summary, @status, @error_reason,
      @index_generation, @chunker_version, @tokenizer_version
    ) ON CONFLICT(id) DO UPDATE SET
      type=excluded.type, title=excluded.title, trust=excluded.trust,
      source_rel_path=excluded.source_rel_path, reader_rel_path=excluded.reader_rel_path,
      source_hash=excluded.source_hash, size=excluded.size, page_count=excluded.page_count,
      status=excluded.status, error_reason=excluded.error_reason,
      index_generation=excluded.index_generation, chunker_version=excluded.chunker_version,
      tokenizer_version=excluded.tokenizer_version
  `).run(row);
}

export function setLibraryDocumentStatus(
  store: LibraryStore,
  id: string,
  status: string,
  errorReason: string | null = null,
): void {
  store.database.prepare(
    `UPDATE library_documents SET status = ?, error_reason = ? WHERE id = ?`,
  ).run(status, errorReason, id);
}

export function replaceLibraryChunks(store: LibraryStore, documentId: string, chunks: LibraryChunk[]): void {
  store.database.transaction(() => {
    store.database.prepare(`DELETE FROM library_chunks WHERE document_id = ?`).run(documentId);
    for (const chunk of chunks) {
      insertLibraryChunk(store, { ...chunk, embedding: null });
    }
  })();
}

export function closeLibraryStore(store: LibraryStore): void {
  store.database.close();
}

export function saveLibraryNote(store: LibraryStore, input: SaveLibraryNoteInput): LibraryNoteRow {
  const chunkIds = [...new Set(input.chunk_ids.filter((id) => typeof id === 'string' && id.length > 0))];
  if (chunkIds.length === 0) throw new TypeError('A Library note needs at least one passage');
  const placeholders = chunkIds.map(() => '?').join(',');
  const found = store.database.prepare(`SELECT id FROM library_chunks WHERE id IN (${placeholders})`).all(...chunkIds) as Array<{ id: string }>;
  if (found.length !== chunkIds.length) throw new Error('One or more Library passages are stale');
  const now = new Date().toISOString();
  const row: LibraryNoteRow = {
    id: crypto.randomUUID(),
    document_id: null,
    content: JSON.stringify({ query: input.query, chunk_ids: chunkIds }),
    created: now,
    updated: now,
  };
  store.database.prepare(`INSERT INTO library_notes (id, document_id, content, created, updated) VALUES (?, ?, ?, ?, ?)`).run(row.id, row.document_id, row.content, row.created, row.updated);
  return row;
}

export function listLibraryDocuments(
  store: LibraryStore,
  options: LibraryReadOptions = {},
): LibraryDocumentRow[] {
  const trustClause = options.include_untrusted ? '' : `WHERE trust <> 'untrusted'`;
  return store.database.prepare(
    `SELECT * FROM library_documents ${trustClause} ORDER BY created, id`,
  ).all() as LibraryDocumentRow[];
}

export function listLibraryChunks(
  store: LibraryStore,
  options: LibraryReadOptions = {},
): LibraryChunkRow[] {
  const trustClause = options.include_untrusted ? '' : `WHERE d.trust <> 'untrusted'`;
  return store.database.prepare(`
    SELECT c.* FROM library_chunks c
    JOIN library_documents d ON d.id = c.document_id
    ${trustClause}
    ORDER BY c.document_id, c.ordinal
  `).all() as LibraryChunkRow[];
}

export function insertLibraryChunk(
  store: LibraryStore,
  input: Omit<LibraryChunkRow, 'locator_json'> & { locator: LibraryChunkLocatorV1 },
): void {
  if (!validateChunkLocator(input.locator)) throw new TypeError('Invalid Library chunk locator');
  store.database.prepare(`
    INSERT INTO library_chunks
      (id, document_id, ordinal, content, content_char_length, locator_json, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.document_id,
    input.ordinal,
    input.content,
    input.content_char_length,
    JSON.stringify(input.locator),
    input.embedding,
  );
}

function markerPair(store: LibraryStore): [string, string] {
  for (let nonce = 0; nonce < 100; nonce += 1) {
    const before = `\u{E000}LARES${nonce}S\u{E001}`;
    const after = `\u{E000}LARES${nonce}E\u{E001}`;
    const collision = store.database.prepare(
      `SELECT 1 FROM library_chunks WHERE instr(content, ?) > 0 OR instr(content, ?) > 0 LIMIT 1`,
    ).get(before, after);
    if (!collision) return [before, after];
  }
  throw new Error('Unable to allocate collision-free Library highlight markers');
}

function parseMarkedContent(marked: string, before: string, after: string): LibraryChunkMatch[] {
  const matches: LibraryChunkMatch[] = [];
  let markedOffset = 0;
  let plainOffset = 0;
  while (markedOffset < marked.length) {
    const start = marked.indexOf(before, markedOffset);
    if (start < 0) break;
    plainOffset += start - markedOffset;
    const valueStart = start + before.length;
    const end = marked.indexOf(after, valueStart);
    if (end < 0) throw new Error('Malformed Library FTS highlight marker sequence');
    const text = marked.slice(valueStart, end);
    matches.push({
      kind: 'exact',
      chunk_char_start: plainOffset,
      chunk_char_end: plainOffset + text.length,
      text,
    });
    plainOffset += text.length;
    markedOffset = end + after.length;
  }
  return matches;
}

function advancePosition(start: LibraryTextPosition, text: string): LibraryTextPosition {
  let line = start.line;
  let column = start.utf16_column;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\r') {
      if (text[i + 1] === '\n') i += 1;
      line += 1;
      column = 0;
    } else if (text[i] === '\n') {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { line, utf16_column: column };
}

function projectMatch(
  row: KeywordRow,
  locator: LibraryChunkLocatorV1,
  match: LibraryChunkMatch,
): LibraryTextSourceRange | LibraryPdfSourceRange {
  if (locator.kind === 'pdf') {
    return {
      page_index: locator.page_index,
      selector: {
        exact: match.text,
        prefix: (locator.quote.prefix + row.content.slice(0, match.chunk_char_start)).slice(-ANCHOR_CONTEXT_CHARS),
        suffix: (row.content.slice(match.chunk_char_end) + locator.quote.suffix).slice(0, ANCHOR_CONTEXT_CHARS),
      },
    };
  }
  return {
    start: advancePosition(locator.start, row.content.slice(0, match.chunk_char_start)),
    end: advancePosition(locator.start, row.content.slice(0, match.chunk_char_end)),
    canonical_char_start: locator.canonical_char_start + match.chunk_char_start,
    canonical_char_end: locator.canonical_char_start + match.chunk_char_end,
  };
}

function candidateInterval(locator: LibraryChunkLocatorV1): { scope: string; start: number; end: number } {
  if (locator.kind === 'pdf') {
    return { scope: `pdf:${locator.page_index}`, start: locator.page_char_start, end: locator.page_char_end };
  }
  return { scope: 'text', start: locator.canonical_char_start, end: locator.canonical_char_end };
}

function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function keywordRows(store: LibraryStore, args: QueryLibraryArgs, before: string, after: string): KeywordRow[] {
  const clauses = [`library_chunks_fts MATCH ?`, `d.status = 'ready'`];
  const values: unknown[] = [args.query];
  if (!args.include_untrusted) clauses.push(`d.trust <> 'untrusted'`);
  if (args.doc_ids?.length) {
    clauses.push(`d.id IN (${args.doc_ids.map(() => '?').join(',')})`);
    values.push(...args.doc_ids);
  }
  if (args.types?.length) {
    clauses.push(`d.type IN (${args.types.map(() => '?').join(',')})`);
    values.push(...args.types);
  }
  if (args.topics?.length) {
    for (const topic of args.topics) {
      clauses.push(`EXISTS (SELECT 1 FROM json_each(d.topics_json) WHERE value = ?)`);
      values.push(topic);
    }
  }
  values.push(before, after);
  return store.database.prepare(`
    SELECT c.id AS chunk_id, d.id AS doc_id, d.source_hash AS document_hash,
      d.title, d.type, d.trust, d.source_rel_path, d.reader_rel_path,
      c.content, c.locator_json, bm25(library_chunks_fts) AS rank,
      highlight(library_chunks_fts, 0, ?, ?) AS marked
    FROM library_chunks_fts
    JOIN library_chunks c ON c.rowid = library_chunks_fts.rowid
    JOIN library_documents d ON d.id = c.document_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY rank, d.id, c.ordinal
  `).all(...values.slice(-2), ...values.slice(0, -2)) as KeywordRow[];
}

/** FTS5 keyword retrieval shared by the pane IPC and the agent-facing HTTP projection. */
export function queryLibrary(store: LibraryStore, args: QueryLibraryArgs): LibraryQueryResult {
  const mode = args.mode ?? 'hybrid';
  const query = args.query.trim();
  const result: LibraryQueryResult = { query: args.query, mode, excerpts: [] };
  if (!query || mode === 'semantic') return result;
  const [before, after] = markerPair(store);
  const rows = keywordRows(store, { ...args, query }, before, after);
  const acceptedIntervals: Array<{ docId: string; scope: string; start: number; end: number }> = [];
  const highlightSpans: LibraryHighlightSpan[] = [];
  const highlightKeys = new Set<string>();
  const highlightRow = args.highlight_doc_id ? rows.find((row) => row.doc_id === args.highlight_doc_id) : undefined;

  for (let rankIndex = 0; rankIndex < rows.length; rankIndex += 1) {
    const row = rows[rankIndex];
    const locator = JSON.parse(row.locator_json) as LibraryChunkLocatorV1;
    if (!validateChunkLocator(locator)) throw new Error(`Invalid persisted locator for chunk ${row.chunk_id}`);
    const matches = parseMarkedContent(row.marked, before, after);
    if (args.highlight_doc_id === row.doc_id) {
      for (const match of matches) {
        const source = projectMatch(row, locator, match);
        const key = JSON.stringify(source);
        if (!highlightKeys.has(key)) {
          highlightKeys.add(key);
          highlightSpans.push({ id: `${row.chunk_id}:exact:${match.chunk_char_start}:${match.chunk_char_end}`, kind: 'exact', chunk_id: row.chunk_id, source });
        }
      }
    }
    const interval = candidateInterval(locator);
    if (acceptedIntervals.some((other) => other.docId === row.doc_id && other.scope === interval.scope && rangesOverlap(other, interval))) continue;
    acceptedIntervals.push({ docId: row.doc_id, ...interval });
    result.excerpts.push({
      chunk_id: row.chunk_id,
      doc_id: row.doc_id,
      document_hash: row.document_hash,
      title: row.title,
      type: row.type,
      trust: row.trust,
      source_rel_path: row.source_rel_path,
      reader_rel_path: row.reader_rel_path,
      quote: row.content,
      citation: formatLibraryCitation({ title: row.title, type: row.type, source_rel_path: row.source_rel_path, locator }),
      locator,
      keyword_matches: matches,
      similar_passage: null,
      scores: { keyword_rank: rankIndex + 1, semantic_rank: null, semantic_score: null, fused_score: 1 / (60 + rankIndex + 1) },
    });
  }
  result.excerpts = result.excerpts.slice(0, Math.max(0, Math.min(args.limit ?? 20, 50)));
  if (args.highlight_doc_id && highlightRow) {
    result.document_highlights = { doc_id: args.highlight_doc_id, document_hash: highlightRow.document_hash, spans: highlightSpans };
  }
  return result;
}
