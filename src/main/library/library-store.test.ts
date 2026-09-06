import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  LIBRARY_CHUNKER_VERSION,
  LIBRARY_SCHEMA_VERSION,
  LIBRARY_TOKENIZER_VERSION,
  LibrarySchemaTooNewError,
  closeLibraryStore,
  insertLibraryChunk,
  listLibraryChunks,
  listLibraryDocuments,
  openLibraryStore,
  type LibraryStore,
} from './library-store';

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lares-library-store-'));
}

function insertDocument(store: LibraryStore, id: string, trust: 'untrusted' | 'cleared' | 'user-trusted'): void {
  store.database.prepare(`
    INSERT INTO library_documents (
      id, type, title, created, topics_json, trust, source_rel_path,
      reader_rel_path, source_hash, size, status, index_generation
    ) VALUES (?, 'md', ?, '2026-09-06T00:00:00.000Z', '[]', ?, ?, ?, ?, 10, 'ready', 0)
  `).run(id, id, trust, `${id}.md`, `${id}.md`, `hash-${id}`);
}

function textLocator(start: number, end: number) {
  return {
    version: 1 as const,
    kind: 'text' as const,
    encoding: 'utf-8' as const,
    line_start: 1,
    line_end: 1,
    start: { line: 1, utf16_column: start },
    end: { line: 1, utf16_column: end },
    canonical_char_start: start,
    canonical_char_end: end,
    quote: { exact: 'library', prefix: '', suffix: '' },
  };
}

test('openLibraryStore creates the versioned WAL schema and reopens idempotently', () => {
  const workspace = makeWorkspace();
  let store: LibraryStore | null = null;
  try {
    store = openLibraryStore(workspace);
    assert.equal(store.databasePath, path.join(workspace, '.lares', 'library', 'library.db'));
    assert.equal(fs.existsSync(store.databasePath), true);
    assert.equal(store.database.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(store.database.pragma('foreign_keys', { simple: true }), 1);

    const objects = store.database.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE name LIKE 'library_%'
      ORDER BY type, name
    `).all() as Array<{ type: string; name: string }>;
    for (const name of ['library_meta', 'library_documents', 'library_chunks', 'library_chunks_fts', 'library_notes']) {
      assert.ok(objects.some((object) => object.name === name), `missing schema object ${name}`);
    }
    for (const name of ['library_chunks_fts_insert', 'library_chunks_fts_update', 'library_chunks_fts_delete']) {
      assert.ok(objects.some((object) => object.type === 'trigger' && object.name === name), `missing trigger ${name}`);
    }

    assert.deepEqual(store.database.prepare(`SELECT * FROM library_meta`).get(), {
      singleton: 1,
      schema_version: LIBRARY_SCHEMA_VERSION,
      chunker_version: LIBRARY_CHUNKER_VERSION,
      tokenizer_version: LIBRARY_TOKENIZER_VERSION,
    });
    closeLibraryStore(store);
    store = openLibraryStore(workspace);
    assert.equal((store.database.prepare(`SELECT count(*) AS count FROM library_meta`).get() as { count: number }).count, 1);
  } finally {
    if (store?.database.open) closeLibraryStore(store);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('REACHABILITY:openLibraryStore:schema synchronizes FTS external content on insert, update, and delete', () => {
  const workspace = makeWorkspace();
  const store = openLibraryStore(workspace);
  try {
    insertDocument(store, 'cleared', 'cleared');
    insertLibraryChunk(store, {
      id: 'chunk-1',
      document_id: 'cleared',
      ordinal: 0,
      content: 'alpha library text',
      content_char_length: 18,
      locator: textLocator(0, 18),
      embedding: null,
    });
    const idsFor = (query: string) => store.database.prepare(`
      SELECT c.id FROM library_chunks_fts f
      JOIN library_chunks c ON c.rowid = f.rowid
      WHERE library_chunks_fts MATCH ?
    `).all(query).map((row: any) => row.id);

    assert.deepEqual(idsFor('library'), ['chunk-1'], 'REACHABILITY:openLibraryStore:schema insert trigger did not populate FTS');
    store.database.prepare(`UPDATE library_chunks SET content = ? WHERE id = ?`).run('beta searchable text', 'chunk-1');
    assert.deepEqual(idsFor('library'), [], 'REACHABILITY:openLibraryStore:schema update trigger left stale FTS content');
    assert.deepEqual(idsFor('searchable'), ['chunk-1'], 'REACHABILITY:openLibraryStore:schema update trigger did not repopulate FTS');
    store.database.prepare(`DELETE FROM library_chunks WHERE id = ?`).run('chunk-1');
    assert.deepEqual(idsFor('searchable'), [], 'REACHABILITY:openLibraryStore:schema delete trigger left stale FTS content');
  } finally {
    closeLibraryStore(store);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('locator validation binds every SQLite write and foreign keys cascade', () => {
  const workspace = makeWorkspace();
  const store = openLibraryStore(workspace);
  try {
    insertDocument(store, 'doc', 'cleared');
    assert.throws(() => store.database.prepare(`
      INSERT INTO library_chunks
        (id, document_id, ordinal, content, content_char_length, locator_json)
      VALUES ('bad', 'doc', 0, 'x', 1, ?)
    `).run(JSON.stringify({ version: 1, kind: 'text' })), /CHECK constraint failed/);
    assert.throws(() => insertLibraryChunk(store, {
      id: 'bad-helper', document_id: 'doc', ordinal: 0, content: 'x', content_char_length: 1,
      locator: { ...textLocator(0, 1), line_start: 0 }, embedding: null,
    }), /Invalid Library chunk locator/);

    insertLibraryChunk(store, {
      id: 'good', document_id: 'doc', ordinal: 0, content: 'x', content_char_length: 1,
      locator: textLocator(0, 1), embedding: null,
    });
    store.database.prepare(`DELETE FROM library_documents WHERE id = 'doc'`).run();
    assert.equal((store.database.prepare(`SELECT count(*) AS count FROM library_chunks`).get() as { count: number }).count, 0);
  } finally {
    closeLibraryStore(store);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('trust-filtered reads omit untrusted documents and chunks by default', () => {
  const workspace = makeWorkspace();
  const store = openLibraryStore(workspace);
  try {
    insertDocument(store, 'a-untrusted', 'untrusted');
    insertDocument(store, 'b-cleared', 'cleared');
    insertDocument(store, 'c-user', 'user-trusted');
    for (const id of ['a-untrusted', 'b-cleared', 'c-user']) {
      insertLibraryChunk(store, {
        id: `chunk-${id}`, document_id: id, ordinal: 0, content: id,
        content_char_length: id.length, locator: textLocator(0, id.length), embedding: null,
      });
    }

    assert.deepEqual(listLibraryDocuments(store).map((row) => row.id), ['b-cleared', 'c-user']);
    assert.deepEqual(listLibraryChunks(store).map((row) => row.document_id), ['b-cleared', 'c-user']);
    assert.deepEqual(listLibraryDocuments(store, { include_untrusted: true }).map((row) => row.id),
      ['a-untrusted', 'b-cleared', 'c-user']);
    assert.deepEqual(listLibraryChunks(store, { include_untrusted: true }).map((row) => row.document_id),
      ['a-untrusted', 'b-cleared', 'c-user']);
  } finally {
    closeLibraryStore(store);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a newer schema version is refused with a typed error and no migration', () => {
  const workspace = makeWorkspace();
  const libraryDir = path.join(workspace, '.lares', 'library');
  fs.mkdirSync(libraryDir, { recursive: true });
  const databasePath = path.join(libraryDir, 'library.db');
  const raw = new Database(databasePath);
  raw.exec(`
    CREATE TABLE library_meta (
      singleton INTEGER PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      chunker_version TEXT NOT NULL,
      tokenizer_version TEXT NOT NULL
    );
    INSERT INTO library_meta VALUES (1, ${LIBRARY_SCHEMA_VERSION + 1}, 'future', 'future');
  `);
  raw.close();

  try {
    assert.throws(() => openLibraryStore(workspace), (error: unknown) => {
      assert.ok(error instanceof LibrarySchemaTooNewError);
      assert.equal(error.code, 'LIBRARY_SCHEMA_TOO_NEW');
      assert.equal(error.foundVersion, LIBRARY_SCHEMA_VERSION + 1);
      assert.equal(error.supportedVersion, LIBRARY_SCHEMA_VERSION);
      return true;
    });
    const inspect = new Database(databasePath, { readonly: true });
    assert.equal((inspect.prepare(
      `SELECT count(*) AS count FROM sqlite_master WHERE name = 'library_documents'`,
    ).get() as { count: number }).count, 0);
    inspect.close();
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
