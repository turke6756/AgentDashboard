// While-you-were-away WP-P2 — binary-safe turn-window path enumeration.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/window-paths.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { TurnRecord } from '../database';
import {
  CheckpointService,
  WINDOW_PATHS_MAX_BYTES,
  WINDOW_PATHS_TIMEOUT_MS,
  type CheckpointTurnStore,
  type RunGitBytesLike,
  type RunGitLike,
} from './checkpoint-service';
import { CheckpointQueue } from './checkpoint-queue';
import { GitCommandError } from './git-command';
import { normalizeWitnessPath } from './witness-recorder';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

const BEFORE_OID = '1'.repeat(40);
const AFTER_OID = '2'.repeat(40);

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: 'turn-1',
    workspaceId: 'workspace-1',
    turnSeq: 1,
    status: 'accepted',
    beforeReady: true,
    afterReady: true,
    beforeRef: 'refs/lares/before',
    afterRef: 'refs/lares/after',
    beforeOid: BEFORE_OID,
    afterOid: AFTER_OID,
    touched: [],
    ...overrides,
  } as TurnRecord;
}

class FakeStore implements CheckpointTurnStore {
  constructor(readonly row: TurnRecord | null = turn()) {}
  getTurnRecord(id: string): TurnRecord | null { return id === this.row?.id ? this.row : null; }
  updateTurnRecord(): TurnRecord | null { throw new Error('not used'); }
  listTurnRecords(): TurnRecord[] { return this.row ? [this.row] : []; }
  listOpenTurnRecords(): TurnRecord[] { return []; }
  listLaterTurnsWitnessingPath(): TurnRecord[] { return []; }
}

function nul(...fields: Array<string | Buffer>): Buffer {
  return Buffer.concat(fields.flatMap((field) => [
    Buffer.isBuffer(field) ? field : Buffer.from(field, 'utf8'),
    Buffer.from([0]),
  ]));
}

function service(opts: {
  row?: TurnRecord | null;
  bytes?: Buffer;
  runGitBytes?: RunGitBytesLike;
  onTextDiff?: () => never;
  onBytes?: (args: string[], maxBytes: number, timeoutMs: number | undefined) => void;
} = {}): CheckpointService {
  const row = opts.row === undefined ? turn() : opts.row;
  const runGit: RunGitLike = async (_cwd, args) => {
    if (args.includes('diff')) {
      if (opts.onTextDiff) opts.onTextDiff();
      throw new Error('REACHABILITY:window-paths-bytes text Git diff was reached');
    }
    const ref = args.at(-1);
    const stdout = ref?.startsWith('refs/lares/before') ? `${BEFORE_OID}\n`
      : ref?.startsWith('refs/lares/after') ? `${AFTER_OID}\n`
      : '';
    return { code: stdout ? 0 : 1, stdout, stderr: '' };
  };
  const runGitBytes: RunGitBytesLike = opts.runGitBytes ?? (async (_cwd, args, runOpts) => {
    opts.onBytes?.(args, runOpts.maxBytes, runOpts.timeoutMs);
    return { code: 0, stdout: opts.bytes ?? Buffer.alloc(0), stderr: '' };
  });
  return new CheckpointService({
    queue: new CheckpointQueue(),
    gitExe: 'git-test-double',
    store: new FakeStore(row),
    runGit,
    runGitBytes,
    platform: 'linux',
  });
}

test('REACHABILITY:window-paths-bytes enters the injected binary seam, never text diff', async () => {
  let bytesCalls = 0;
  let textDiffCalls = 0;
  const output = nul(
    'A', 'space name.txt',
    'M', '"quoted".txt',
    'D', 'deleted.txt',
    'T', 'type-change',
    'U', 'unmerged.txt',
    'X', 'unknown-pairing.txt',
    'B', 'broken-pairing.txt',
    'R100', 'old name.txt', 'renamed/\u2603.txt',
    'C75', 'source.txt', 'copied.txt',
  );
  const svc = service({
    bytes: output,
    onTextDiff: () => { textDiffCalls += 1; throw new Error('REACHABILITY:window-paths-bytes'); },
    onBytes: (args, maxBytes, timeoutMs) => {
      bytesCalls += 1;
      assert.deepEqual(args, [
        '--no-pager', 'diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv',
        BEFORE_OID, AFTER_OID,
      ]);
      assert.equal(maxBytes, WINDOW_PATHS_MAX_BYTES);
      assert.equal(timeoutMs, WINDOW_PATHS_TIMEOUT_MS);
    },
  });

  const result = await svc.listWindowPaths('turn-1', '/repo');
  assert.equal(bytesCalls, 1);
  assert.equal(textDiffCalls, 0);
  assert.deepEqual(result, {
    available: true,
    reason: 'ok',
    paths: [
      'space name.txt', '"quoted".txt', 'deleted.txt', 'type-change',
      'unmerged.txt', 'unknown-pairing.txt', 'broken-pairing.txt',
      'old name.txt', 'renamed/\u2603.txt', 'source.txt', 'copied.txt',
    ],
    omittedPathCount: 0,
    hasOmittedPaths: false,
    truncated: false,
  });
});

test('empty output is complete and distinct from malformed output', async () => {
  assert.deepEqual(await service().listWindowPaths('turn-1', '/repo'), {
    available: true,
    reason: 'empty',
    paths: [],
    omittedPathCount: 0,
    hasOmittedPaths: false,
    truncated: false,
  });

  const torn = await service({ bytes: Buffer.from('R100\0old.txt\0', 'utf8') })
    .listWindowPaths('turn-1', '/repo');
  assert.equal(torn.available, false);
  assert.equal(torn.reason, 'malformed');
  assert.equal(torn.omittedPathCount, null);
  assert.equal(torn.hasOmittedPaths, true);

  const unknown = await service({ bytes: nul('Z', 'mystery.txt') })
    .listWindowPaths('turn-1', '/repo');
  assert.equal(unknown.reason, 'malformed');
  assert.equal(unknown.omittedPathCount, null);

  const partial = await service({
    bytes: Buffer.concat([nul('M', 'safe-first.txt'), Buffer.from('A\0torn-tail', 'utf8')]),
  }).listWindowPaths('turn-1', '/repo');
  assert.equal(partial.reason, 'malformed');
  assert.deepEqual(partial.paths, ['safe-first.txt']);
  assert.equal(partial.omittedPathCount, null);
});

test('well-formed non-UTF-8 path bytes are counted exactly without dropping safe paths', async () => {
  const result = await service({
    bytes: nul('M', Buffer.from([0x66, 0x80, 0x6f]), 'A', 'safe/\u96ea.txt'),
  }).listWindowPaths('turn-1', '/repo');
  assert.deepEqual(result, {
    available: false,
    reason: 'non-utf8',
    paths: ['safe/\u96ea.txt'],
    omittedPathCount: 1,
    hasOmittedPaths: true,
    truncated: false,
  });
});

test('cap exhaustion, timeout, deadline, and Git failures retain distinct reasons', async () => {
  const cases: Array<{ error: Error; reason: string; truncated: boolean }> = [
    {
      error: new GitCommandError('nonzero', 'git diff output exceeded maxBytes.', null, ''),
      reason: 'cap-exhausted',
      truncated: true,
    },
    { error: new GitCommandError('timeout', 'timed out', null, ''), reason: 'timeout', truncated: false },
    { error: new GitCommandError('deadline', 'deadline', null, ''), reason: 'timeout', truncated: false },
    { error: new GitCommandError('spawn', 'spawn failed', null, ''), reason: 'git-failed', truncated: false },
    { error: new GitCommandError('lock', 'lock failed', null, ''), reason: 'git-failed', truncated: false },
    { error: new GitCommandError('nonzero', 'git failed', 2, ''), reason: 'git-failed', truncated: false },
  ];
  for (const item of cases) {
    const result = await service({ runGitBytes: async () => { throw item.error; } })
      .listWindowPaths('turn-1', '/repo');
    assert.equal(result.reason, item.reason);
    assert.equal(result.available, false);
    assert.equal(result.omittedPathCount, null);
    assert.equal(result.hasOmittedPaths, true);
    assert.equal(result.truncated, item.truncated);
  }
});

test('both edges are live-verified and unusable edges prevent the binary diff', async () => {
  let bytesCalls = 0;
  const badAfter = turn({ afterOid: '3'.repeat(40) });
  const result = await service({
    row: badAfter,
    onBytes: () => { bytesCalls += 1; },
  }).listWindowPaths('turn-1', '/repo');
  assert.equal(result.reason, 'after-edge-unusable');
  assert.equal(bytesCalls, 0);

  const missing = await service({ row: null }).listWindowPaths('missing', '/repo');
  assert.equal(missing.reason, 'before-edge-unusable');
});

test('nested workspace uses the same repo-relative coordinate for Git and witnesses', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-window-paths-'));
  try {
    const workspacePrefix = 'packages/app';
    const absolutePath = path.join(repoRoot, 'packages', 'app', 'src', 'a.ts');
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, 'x');
    const repoPath = 'packages/app/src/a.ts';
    const result = await service({ bytes: nul('M', repoPath) })
      .listWindowPaths('turn-1', repoRoot);
    const witnessed = normalizeWitnessPath({ turnId: 'turn-1', repoRoot, workspacePrefix }, absolutePath);
    assert.equal(witnessed, repoPath);
    assert.equal(result.paths.includes(witnessed as string), true);
    assert.equal(repoPath.slice(`${workspacePrefix}/`.length), 'src/a.ts');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const item of tests) {
    try {
      await item.run();
      console.log(`  ok  ${item.name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${item.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
