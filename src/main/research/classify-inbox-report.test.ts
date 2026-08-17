import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  classifyInboxReport,
  listInboxReports,
} from './classify-inbox-report';
import { REQUIRED_FRONTMATTER_KEYS } from './frontmatter';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

function artifact(extra = '', overrides: Partial<Record<string, string>> = {}): string {
  const values = {
    id: 'r-2026-08-15-vite-stable',
    topic: 'Vite stable version',
    created: '2026-08-15',
    trust: 'untrusted',
    summary: 'Vite remains dependable for this use.',
    ...overrides,
  };
  return [
    '---',
    `id: ${values.id}`,
    `topic: ${values.topic}`,
    `created: ${values.created}`,
    'source_urls:',
    '  - https://vite.dev/blog',
    `trust: ${values.trust}`,
    `summary: ${values.summary}`,
    extra,
    '---',
    '',
    '## Summary',
    'Body.',
  ].filter((line) => line !== '').join('\n');
}

function withoutKey(content: string, key: string): string {
  if (key === 'source_urls') return content.replace(/source_urls:\n\s+- https:\/\/vite\.dev\/blog\n/, '');
  return content.replace(new RegExp(`^${key}:.*\\n`, 'm'), '');
}

test('classifies a valid report and does not enforce filename stem equals id', () => {
  const result = classifyInboxReport({ relPath: '2026-08-15-vite-stable-version.md', content: artifact() });
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') assert.equal(result.frontmatter.id, 'r-2026-08-15-vite-stable');
});

for (const key of REQUIRED_FRONTMATTER_KEYS) {
  test(`missing required key ${key} is malformed`, () => {
    const result = classifyInboxReport({ relPath: 'missing.md', content: withoutKey(artifact(), key) });
    assert.equal(result.status, 'malformed');
    if (result.status === 'malformed') assert.match(result.reason, new RegExp(`missing frontmatter key: ${key}`));
  });
}

test('trust cleared is malformed in inbox', () => {
  const result = classifyInboxReport({ relPath: 'cleared.md', content: artifact('', { trust: 'cleared' }) });
  assert.equal(result.status, 'malformed');
});

test('flow-style source_urls is present but empty and malformed', () => {
  const content = artifact().replace('source_urls:\n  - https://vite.dev/blog', 'source_urls: [https://vite.dev/blog]');
  const result = classifyInboxReport({ relPath: 'flow.md', content });
  assert.equal(result.status, 'malformed');
  if (result.status === 'malformed') assert.match(result.reason, /non-empty list/);
});

test('date-only created, CRLF, BOM, and nested historical relPath remain ok', () => {
  for (const content of [artifact(), artifact().replace(/\n/g, '\r\n'), `\uFEFF${artifact()}`]) {
    const result = classifyInboxReport({ relPath: 'vite/2026-08-15-report.md', content });
    assert.equal(result.status, 'ok');
  }
});

test('provider is optional, enumerated when present, and recovered for degraded cards', () => {
  const missing = classifyInboxReport({ relPath: 'missing-provider.md', content: artifact() });
  assert.equal(missing.status, 'ok');
  const valid = classifyInboxReport({ relPath: 'valid-provider.md', content: artifact('provider: codex') });
  assert.equal(valid.status, 'ok');
  const invalid = classifyInboxReport({ relPath: 'invalid-provider.md', content: artifact('provider: grok') });
  assert.equal(invalid.status, 'malformed');
  if (invalid.status === 'malformed') assert.match(invalid.reason, /provider must be one of/);
});

test('recursive listing ignores non-md, preserves duplicate ids, and malformed-lists unreadable and oversize files', async () => {
  const cacheRoot = path.join(process.cwd(), 'node_modules', '.cache');
  fs.mkdirSync(cacheRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(cacheRoot, 'wp10b-fixtures-'));
  try {
    fs.mkdirSync(path.join(root, 'historical'), { recursive: true });
    fs.writeFileSync(path.join(root, 'one.md'), artifact());
    fs.writeFileSync(path.join(root, 'historical', 'two.md'), artifact());
    fs.writeFileSync(path.join(root, 'ignored.jsonl'), '{"not":"a report"}');
    fs.writeFileSync(path.join(root, 'unreadable.md'), artifact());
    fs.writeFileSync(path.join(root, 'oversize.md'), artifact() + 'x'.repeat(500));

    const rows = await listInboxReports(root, {
      maxBytes: 300,
      readFile: async (filePath, encoding) => {
        if (filePath.endsWith('unreadable.md')) throw new Error('fixture refusal');
        return fs.promises.readFile(filePath, encoding);
      },
    });
    assert.deepEqual(rows.map((row) => row.relPath), [
      'historical/two.md', 'one.md', 'oversize.md', 'unreadable.md',
    ]);
    assert.equal(rows.filter((row) => row.status === 'ok').length, 2);
    assert.equal(rows.filter((row) => row.status === 'ok' && row.frontmatter.id === 'r-2026-08-15-vite-stable').length, 2);
    const unreadable = rows.find((row) => row.relPath === 'unreadable.md');
    assert.equal(unreadable?.status, 'malformed');
    if (unreadable?.status === 'malformed') assert.match(unreadable.reason, /unreadable.*fixture refusal/);
    const oversize = rows.find((row) => row.relPath === 'oversize.md');
    assert.equal(oversize?.status, 'malformed');
    if (oversize?.status === 'malformed') assert.match(oversize.reason, /exceeds 300-byte/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing inbox is empty and a nested junction cannot escape the inbox', async () => {
  const cacheRoot = path.join(process.cwd(), 'node_modules', '.cache');
  fs.mkdirSync(cacheRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(cacheRoot, 'wp10b-boundary-'));
  const inbox = path.join(root, 'inbox');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(inbox);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'escape.md'), artifact());
  try {
    assert.deepEqual(await listInboxReports(path.join(root, 'missing')), []);
    try {
      fs.symlinkSync(outside, path.join(inbox, 'linked'), 'junction');
      assert.deepEqual(await listInboxReports(inbox), []);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

(async () => {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      console.log(`  \u2713 ${entry.name}`);
    } catch (error) {
      failed++;
      console.error(`  \u2717 ${entry.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  if (failed) process.exitCode = 1;
  else console.log(`\nAll ${tests.length} classify-inbox-report tests passed`);
})();
