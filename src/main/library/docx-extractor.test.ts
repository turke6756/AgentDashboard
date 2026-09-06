import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractDocx } from './docx-extractor';

const FIXTURE = path.resolve('examples/library-fixtures/deterministic.docx');
const EXPECTED = '# Deterministic Library Fixture\n\nAlpha paragraph with non\\-ASCII café and a surrogate pair 😀\\.\n\nBeta paragraph supplies stable Markdown lines for locator tests\\.\n\n';

test('Mammoth writes canonical derived Markdown atomically and repeatably', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-docx-extract-'));
  const first = await extractDocx(root, FIXTURE, 'doc-fixed');
  const second = await extractDocx(root, FIXTURE, 'doc-fixed');
  assert.equal(first.markdown, EXPECTED);
  assert.equal(second.markdown, EXPECTED);
  assert.equal(first.reader_rel_path, '.lares/library/derived/doc-fixed/deterministic.md');
  assert.equal(fs.readFileSync(first.absolute_path, 'utf8'), EXPECTED);
  assert.deepEqual(fs.readdirSync(path.dirname(first.absolute_path)), ['deterministic.md']);
});
