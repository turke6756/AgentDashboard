import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  type LibraryChunkLocatorV1,
  type LibraryDocumentType,
  type LibraryTrust,
  validateChunkLocator,
} from '../../shared/library';

export const LIBRARY_SCHEMA_VERSION = 1;
export const LIBRARY_CHUNKER_VERSION = 'paragraph-window-v1';
export const LIBRARY_TOKENIZER_VERSION = 'cl100k_base-js-tiktoken-1.0.21';

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

export interface LibraryReadOptions {
  include_untrusted?: boolean;
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
    return { database, databasePath };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function closeLibraryStore(store: LibraryStore): void {
  store.database.close();
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
