import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkDocument } from './library-chunker';
import { chunkDocumentOffThread, shutdownChunkWorker } from './library-chunk-runner';

test('the worker thread returns exactly what the in-process chunker returns', async (t) => {
  t.after(() => shutdownChunkWorker());
  const text = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}. Worker parity sentence café 😀 ${i}.`).join('\n\n');
  const input = { document_id: 'w', source_hash: 's', kind: 'text' as const, text, include_byte_map: true };
  const [a, b] = await Promise.all([chunkDocumentOffThread(input), chunkDocumentOffThread({ ...input, document_id: 'w2' })]);
  assert.deepEqual(a, chunkDocument(input));
  assert.deepEqual(b, chunkDocument({ ...input, document_id: 'w2' }));
  assert.notDeepEqual(a.map((c) => c.id), b.map((c) => c.id), 'concurrent requests are routed to their own callers');
});

test('the calling thread stays responsive while the worker chunks', async (t) => {
  t.after(() => shutdownChunkWorker());
  const text = Array.from({ length: 1500 }, (_, i) => `Sentence ${i} of a long geoprocessing narrative that keeps the tokenizer busy.`).join('\n\n');
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 5);
  try {
    await chunkDocumentOffThread({ document_id: 'busy', source_hash: 's', kind: 'text', text });
  } finally { clearInterval(ticker); }
  assert.ok(ticks >= 2, `timers kept firing on the main thread during chunking (ticks=${ticks})`);
});
