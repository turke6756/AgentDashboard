import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  SNAPSHOT_TIME_BUDGET,
  hashEntriesBatched,
  type RunGitBytesLike,
  type RunGitTextLike,
} from './dirty-inventory';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const oidFor = (path: string): string => createHash('sha1').update(`batch-hash:${path}`).digest('hex');

function stdinPaths(stdin: string | Buffer | undefined): string[] {
  assert.ok(stdin, 'hash invocation supplies stdin paths');
  return (Buffer.isBuffer(stdin) ? stdin : Buffer.from(stdin))
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
}

test('one unhashable entry among 512 uses logarithmic batches, not n per-file spawns', async () => {
  const paths = Array.from({ length: 512 }, (_, index) => index === 0 ? 'unhashable.txt' : `file-${index}.txt`);
  const entries = [
    ...paths.map((value) => ({ hashPathBytes: Buffer.from(value) })),
    { hashPathBytes: null },
    { hashPathBytes: null },
  ];
  let batchInvocations = 0;
  let singletonInvocations = 0;
  const observedPaths: string[] = [];
  const observedBatchSizes: number[] = [];

  const runGitBytes: RunGitBytesLike = async (_cwd, args, opts) => {
    assert.deepEqual(args, ['hash-object', '--no-filters', '--stdin-paths']);
    batchInvocations++;
    const batch = stdinPaths(opts.stdin);
    observedBatchSizes.push(batch.length);
    observedPaths.push(...batch);
    if (batch.includes('unhashable.txt')) {
      return { code: 1, stdout: Buffer.alloc(0), stderr: 'injected unhashable entry' };
    }
    return { code: 0, stdout: Buffer.from(`${batch.map(oidFor).join('\n')}\n`), stderr: '' };
  };
  const runGit: RunGitTextLike = async (_cwd, args, opts) => {
    assert.deepEqual(args, ['hash-object', '--no-filters', '--stdin-paths']);
    singletonInvocations++;
    const [entry] = stdinPaths(opts.stdin);
    return entry === 'unhashable.txt'
      ? { code: 1, stdout: '', stderr: 'injected unhashable entry' }
      : { code: 0, stdout: `${oidFor(entry)}\n`, stderr: '' };
  };

  const oids = await hashEntriesBatched({
    repoRoot: 'C:/fake',
    entries,
    runGitBytes,
    runGit,
    deadlineAt: Date.now() + 30_000,
  });

  assert.equal(
    batchInvocations,
    17,
    'REACHABILITY:batch-hash-bisect 512 entries with one failure take 17 batch invocations',
  );
  assert.equal(singletonInvocations, 2, 'only the isolated pair uses per-entry probes, never an n-entry fallback');
  assert.ok(singletonInvocations < paths.length, 'per-entry spawn count is bounded independently of tree size');
  assert.equal(observedBatchSizes[0], paths.length, 'absent entries are filtered before the initial batch');
  assert.ok(observedPaths.every((entry) => paths.includes(entry)), 'every batched path came from a present entry');
  assert.equal(oids[0], null, 'the injected unhashable entry remains unhashed');
  paths.slice(1).forEach((entry, offset) => assert.equal(oids[offset + 1], oidFor(entry)));
  assert.deepEqual(oids.slice(paths.length), [null, null], 'absent entries retain aligned null OIDs');
  console.log(`       measured: ${batchInvocations} batch invocations, ${singletonInvocations} per-entry probes for ${paths.length} present entries`);
});

test('a few-hundred-entry successful hash phase stays inside the soft budget', async () => {
  const paths = Array.from({ length: 400 }, (_, index) => `tree/file-${index}.txt`);
  let batchInvocations = 0;
  let singletonInvocations = 0;
  const startedAt = performance.now();
  const oids = await hashEntriesBatched({
    repoRoot: 'C:/fake',
    entries: paths.map((value) => ({ hashPathBytes: Buffer.from(value) })),
    runGitBytes: async (_cwd, _args, opts) => {
      batchInvocations++;
      const batch = stdinPaths(opts.stdin);
      return { code: 0, stdout: Buffer.from(`${batch.map(oidFor).join('\n')}\n`), stderr: '' };
    },
    runGit: async () => {
      singletonInvocations++;
      return { code: 1, stdout: '', stderr: 'unexpected singleton retry' };
    },
    deadlineAt: Date.now() + SNAPSHOT_TIME_BUDGET.hardMs,
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(batchInvocations, 1, 'successful tree hashes in one batch');
  assert.equal(singletonInvocations, 0, 'successful tree never enters per-entry retry');
  assert.ok(
    elapsedMs < SNAPSHOT_TIME_BUDGET.softMs,
    `400-entry hash phase took ${elapsedMs.toFixed(1)}ms, exceeding ${SNAPSHOT_TIME_BUDGET.softMs}ms soft budget`,
  );
  paths.forEach((entry, index) => assert.equal(oids[index], oidFor(entry)));
  console.log(`       measured: 400 entries in ${elapsedMs.toFixed(1)}ms with ${batchInvocations} batch invocation`);
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const current of tests) {
    try {
      await current.run();
      console.log(`  ok  ${current.name}`);
      passed++;
    } catch (error) {
      console.error(`  FAIL ${current.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
