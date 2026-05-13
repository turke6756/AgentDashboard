// Self-contained smoke test for FileActivityTracker path filtering.
//
//   npm run build:main
//   node dist/main/main/supervisor/file-activity-tracker.test.js

import assert from 'node:assert/strict';
import { isPlausibleFileActivityPath } from './file-activity-tracker';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

test('allows path-shaped relative and absolute files', () => {
  assert.equal(isPlausibleFileActivityPath('package.json'), true);
  assert.equal(isPlausibleFileActivityPath('src/main/index.ts'), true);
  assert.equal(isPlausibleFileActivityPath('C:\\repo\\src\\main.ts'), true);
  assert.equal(isPlausibleFileActivityPath('/home/me/repo/README.md'), true);
});

test('rejects Claude aggregate context summaries', () => {
  assert.equal(isPlausibleFileActivityPath('3 files, listed 1 directory'), false);
  assert.equal(isPlausibleFileActivityPath('1 file, recalled 2 memories'), false);
  assert.equal(isPlausibleFileActivityPath('2 files, recalled 4 memories'), false);
});

test('rejects non-path prose', () => {
  assert.equal(isPlausibleFileActivityPath('the current task'), false);
  assert.equal(isPlausibleFileActivityPath('listed 1 directory'), false);
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
