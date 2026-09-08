import assert from 'node:assert/strict'; import crypto from 'node:crypto'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import test from 'node:test';
import { CHUNKER_VERSION, TOKENIZER_VERSION } from './library-chunker';
import { closeLibraryStore, openLibraryStore, type LibraryDocumentRow, type LibraryStore, upsertLibraryDocument } from './library-store';
import type { LibraryReportSourcesInventory } from './library-report-sources'; import { listLibraryShelf } from './library-shelf';
function row(id: string, relPath: string, content: string, overrides: Partial<LibraryDocumentRow> = {}): LibraryDocumentRow { return { id, type: 'md', title: id, created: '2026-09-06T00:00:00.000Z', topics_json: '[]', trust: 'user-trusted', source_rel_path: relPath, reader_rel_path: relPath, source_hash: crypto.createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content), page_count: null, provider: null, agent_id: null, summary: null, status: 'ready', error_reason: null, index_generation: 0, chunker_version: CHUNKER_VERSION, tokenizer_version: TOKENIZER_VERSION, ...overrides }; }
function inventory(workspace: string, inbox: Array<[string, string]>, cleared: Array<[string, string]>): LibraryReportSourcesInventory {
  const make = (root: 'inbox' | 'cleared', files: Array<[string, string]>) => ({ root, root_path: path.join(workspace, '.lares', 'library', root), files: files.map(([rel_path, content], index) => ({ rel_path, abs_path: path.join(workspace, '.lares', 'library', root, rel_path), size: Buffer.byteLength(content), mtimeMs: 1000 + index })), directories: [], health: 'complete' as const }); return { inbox: make('inbox', inbox), cleared: make('cleared', cleared) };
}
function fixture(): { workspace: string; store: LibraryStore; close: () => void } { const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-shelf-')); const store = openLibraryStore(workspace); return { workspace, store, close: () => { closeLibraryStore(store); fs.rmSync(workspace, { recursive: true, force: true }); } }; }
test('disk reports left-join index rows, stamp folder identity, append user rows, and apply status precedence', async (t) => {
  const f = fixture(); t.after(f.close); upsertLibraryDocument(f.store, row('ready-inbox', '.lares/library/inbox/ready.md', 'same')); upsertLibraryDocument(f.store, row('stale-error', '.lares/library/cleared/stale.md', 'old!', { status: 'error' })); upsertLibraryDocument(f.store, row('error', '.lares/library/cleared/error.md', 'error', { status: 'error' })); upsertLibraryDocument(f.store, row('indexing', '.lares/library/cleared/indexing.md', 'index', { status: 'embedding' })); upsertLibraryDocument(f.store, row('gone', '.lares/library/inbox/gone.md', 'gone')); upsertLibraryDocument(f.store, row('user-doc', '.lares/library/sources/manual.md', 'manual'));
  const contents = new Map<string, Buffer>(); for (const [root, name, content] of [['inbox','ready.md','same'],['inbox','pending.md','new'],['cleared','stale.md','new!'],['cleared','error.md','error'],['cleared','indexing.md','index']]) contents.set(path.join(f.workspace,'.lares','library',root,name), Buffer.from(content));
  const rows = await listLibraryShelf(f.workspace, f.store, { inventory: inventory(f.workspace, [['ready.md','same'],['pending.md','new']], [['stale.md','new!'],['error.md','error'],['indexing.md','index']]), readFile: async (p) => contents.get(p)! });
  assert.deepEqual(new Map(rows.map((item) => [item.id, item.shelf_status])), new Map([['stale-error','stale'],['error','error'],['indexing','indexing'],['ready-inbox','ready'],['shelf:.lares/library/inbox/pending.md','pending'],['user-doc','ready']]), 'REACHABILITY:listLibraryShelf');
  assert.equal(rows.find((item) => item.id === 'ready-inbox')?.type, 'research'); assert.equal(rows.find((item) => item.id === 'ready-inbox')?.trust, 'untrusted'); assert.equal(rows.some((item) => item.id === 'gone'), false);
});
test('size mismatch avoids hashing and path+size+mtime cache avoids a second read', async (t) => {
  const f = fixture(); t.after(f.close); upsertLibraryDocument(f.store, row('cached','.lares/library/cleared/cached.md','cache')); upsertLibraryDocument(f.store,row('size-change','.lares/library/inbox/size.md','longer'));
  let reads=0; const source=inventory(f.workspace,[['size.md','x']],[['cached.md','cache']]); const options={inventory:source,readFile:async()=>{reads+=1;return Buffer.from('cache');}};
  await listLibraryShelf(f.workspace,f.store,options); const rows=await listLibraryShelf(f.workspace,f.store,options); assert.equal(rows.find((item)=>item.id==='size-change')?.shelf_status,'stale'); assert.equal(reads,1);
});
test('matching disk content is stale for an old chunker contract and ready for the current contract', async (t) => {
  const f=fixture(); t.after(f.close); upsertLibraryDocument(f.store,row('old-chunker','.lares/library/cleared/old.md','same',{chunker_version:'paragraph-window-v1'})); upsertLibraryDocument(f.store,row('current','.lares/library/cleared/current.md','same'));
  const rows=await listLibraryShelf(f.workspace,f.store,{inventory:inventory(f.workspace,[],[['old.md','same'],['current.md','same']]),readFile:async()=>Buffer.from('same')});
  assert.equal(rows.find((item)=>item.id==='old-chunker')?.shelf_status,'stale'); assert.equal(rows.find((item)=>item.id==='current')?.shelf_status,'ready');
});
test('duplicate paths select highest generation then id and diagnose ids and path', async (t) => {
  const f=fixture(); t.after(f.close); const rel='.lares/library/cleared/duplicate.md'; upsertLibraryDocument(f.store,row('alpha',rel,'same',{index_generation:2})); upsertLibraryDocument(f.store,row('zulu',rel,'same',{index_generation:2})); const warnings:string[]=[];
  const rows=await listLibraryShelf(f.workspace,f.store,{inventory:inventory(f.workspace,[],[['duplicate.md','same']]),readFile:async()=>Buffer.from('same'),warn:(message)=>warnings.push(message)}); assert.equal(rows[0].id,'zulu'); assert.match(warnings[0],/alpha/); assert.match(warnings[0],/zulu/); assert.match(warnings[0],/duplicate\.md/);
});
test('win32 join, duplicate grouping, and report ownership use one case-folded POSIX key', async (t) => {
  if (process.platform !== 'win32') { t.skip('win32 case-folding contract'); return; }
  const f=fixture(); t.after(f.close); upsertLibraryDocument(f.store,row('alpha','.LARES\\LIBRARY\\CLEARED\\REPORT.MD','same',{index_generation:1})); upsertLibraryDocument(f.store,row('zulu','.lares/library/cleared/report.md','same',{index_generation:2})); const warnings:string[]=[];
  const rows=await listLibraryShelf(f.workspace,f.store,{inventory:inventory(f.workspace,[],[['RePoRt.Md','same']]),readFile:async()=>Buffer.from('same'),warn:(message)=>warnings.push(message)});
  assert.deepEqual(rows.map((item)=>item.id),['zulu']); assert.equal(rows[0].shelf_status,'ready'); assert.match(warnings[0],/alpha/); assert.match(warnings[0],/zulu/);
});
test('unknown index statuses are errors and never query-ready', async (t) => {
  const f=fixture(); t.after(f.close); upsertLibraryDocument(f.store,row('future-report','.lares/library/cleared/future.md','same',{status:'future' as any})); upsertLibraryDocument(f.store,row('future-user','.lares/library/sources/future.md','same',{status:'future' as any}));
  const rows=await listLibraryShelf(f.workspace,f.store,{inventory:inventory(f.workspace,[],[['future.md','same']]),readFile:async()=>Buffer.from('same')});
  assert.equal(rows.find((item)=>item.id==='future-report')?.shelf_status,'error'); assert.equal(rows.find((item)=>item.id==='future-user')?.shelf_status,'error');
});
