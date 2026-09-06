import assert from 'assert';
import { formatLibraryCitation } from './library-citation';

const quote = { exact: 'x', prefix: '', suffix: '' };

assert.strictEqual(formatLibraryCitation({
  title: 'Acme\r\nController Manual', type: 'pdf', source_rel_path: 'ignored.pdf',
  locator: { version: 1, kind: 'pdf', extraction: 'pdfium-page-text-v1', page_index: 16, page_number: 17, page_label: 'iv', page_char_start: 0, page_char_end: 1, quote },
}), 'AcmeController Manual, p.17');

assert.strictEqual(formatLibraryCitation({
  title: 'report', type: 'research', source_rel_path: '.lares\\library\\cleared\\report\n.md',
  locator: { version: 1, kind: 'text', encoding: 'utf-8', line_start: 42, line_end: 55, start: { line: 42, utf16_column: 0 }, end: { line: 55, utf16_column: 1 }, canonical_char_start: 0, canonical_char_end: 1, quote },
}), '.lares/library/cleared/report.md:42-55');

assert.strictEqual(formatLibraryCitation({
  title: 'guide', type: 'docx', source_rel_path: '.lares\\library\\sources\\guide.docx',
  locator: { version: 1, kind: 'docx-markdown', conversion: 'mammoth-markdown-v1', derived_rel_path: '.lares/library/derived/guide/index.md', line_start: 18, line_end: 31, start: { line: 18, utf16_column: 0 }, end: { line: 31, utf16_column: 1 }, canonical_char_start: 0, canonical_char_end: 1, quote },
}), '.lares/library/sources/guide.docx:converted 18-31');

console.log('All 3 library citation tests passed');
