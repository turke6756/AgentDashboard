// SC-WP-1F — exact checkpoint-protection evaluator.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/protection-read.test.js

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProtectionRung } from '../../shared/commit-candidates';
import type { PackageFinalization } from '../database';
import { resolveInternalGit } from '../git/git-runtime';
import { runGit, runGitBytes } from '../git-checkpoints/git-command';
import {
  CheckpointProtectionBudgetExceededError,
  PROBE_ESTIMATED_STDIN_BUDGET,
  PROBE_PAIR_BUDGET,
  evaluateCheckpointProtection,
  weakestProtectionRung,
  type CheckpointTreePresence,
  type CheckpointTreeReader,
  type ProtectionMember,
  type RunProtectionGitBytes,
} from './protection-read';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

let gitExe = '';
let repo = '';
let checkpointOid = '';
let deletionPresentOid = '';
let matchingBlobOid = '';
const CHECKPOINT_REF = 'refs/lares/checkpoints/protection/after';
const DELETION_PRESENT_REF = 'refs/lares/checkpoints/protection/before-deletion';

function git(args: string[]): string {
  return execFileSync(gitExe, args, { cwd: repo, encoding: 'utf8' }).trim();
}

function encodedPath(value: string): ProtectionMember['path'] {
  return {
    pathBytesBase64: Buffer.from(value, 'utf8').toString('base64'),
    displayPath: value,
    utf8Clean: true,
  };
}

function member(
  entryId: string,
  filePath: string,
  state: ProtectionMember['expectedWorktreeState'],
  blob: string | null,
  mode: string | null,
): ProtectionMember {
  return {
    entryId,
    path: encodedPath(filePath),
    commitPathspecs: [encodedPath(filePath)],
    expectedWorktreeState: state,
    rawWorktreeBlobOid: blob,
    worktreeMode: mode,
  };
}

function finalization(
  memberValue: ProtectionMember,
  overrides: Partial<PackageFinalization> = {},
): PackageFinalization {
  return {
    id: 'fin-1', packageId: 'pkg-1', repositoryKey: 'repo', finalizationKind: 'fleet-adhoc',
    planId: null, planItemId: null, packageRevision: 1, finalizedAt: 1, finalizedBy: 'human-ipc',
    checkpointTurnId: null, checkpointOid, boundaryRef: CHECKPOINT_REF, boundaryStatus: 'ready',
    lifecycleStatus: 'active', supersededByFinalizationId: null, releasedAt: null,
    memberManifestJson: JSON.stringify([{
      pathBytesBase64: memberValue.path.pathBytesBase64,
      expectedState: memberValue.expectedWorktreeState,
      rawBlobOid: memberValue.rawWorktreeBlobOid,
      commitBlobOid: memberValue.rawWorktreeBlobOid,
      commitMode: '100644',
    }]),
    contractVersion: 1, failureReason: null, createdFromWorkspaceId: 'ws-1',
    ...overrides,
  };
}

const unreachableBytes: RunProtectionGitBytes = async () => {
  throw new Error('unexpected binary Git call');
};

test('real live checkpoint tree protects only the exact path/blob/mode tuple', async () => {
  const exact = member('exact', 'protected.txt', 'present', matchingBlobOid, '100644');
  const wrongBlob = member('wrong-blob', 'protected.txt', 'present', '0'.repeat(matchingBlobOid.length), '100644');
  const wrongMode = member('wrong-mode', 'protected.txt', 'present', matchingBlobOid, '100755');

  const result = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [exact, wrongBlob, wrongMode],
    checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
    runGit,
    runGitBytes,
    gitExe,
  });

  assert.deepEqual(result.members, [
    { entryId: 'exact', protection: 'checkpoint-protected' },
    { entryId: 'wrong-blob', protection: 'unprotected' },
    { entryId: 'wrong-mode', protection: 'unprotected' },
  ]);
  assert.equal(result.weakest, 'unprotected');
});

test('deletion is protected by recorded absence but not while the path remains in the tree', async () => {
  const deletion = member('deleted', 'deleted.txt', 'absent', null, null);

  const absentResult = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [deletion],
    checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
    runGit,
    runGitBytes,
    gitExe,
  });
  assert.deepEqual(absentResult, {
    members: [{ entryId: 'deleted', protection: 'checkpoint-protected' }],
    weakest: 'checkpoint-protected',
    finalizationCoveredPathBytes: new Set(),
  });

  const presentResult = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [deletion],
    checkpointEdges: [{ ref: DELETION_PRESENT_REF, oid: deletionPresentOid }],
    runGit,
    runGitBytes,
    gitExe,
  });
  assert.equal(presentResult.members[0].protection, 'unprotected');
});

test('a ready active finalization protects an exact untracked member and reports live coverage', async () => {
  const untracked = member('new', 'protected.txt', 'present', matchingBlobOid, null);
  const result = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [untracked],
    checkpointEdges: [],
    finalizations: [finalization(untracked)],
    readRawGitMode: () => '100644',
    runGit,
    runGitBytes,
    gitExe,
  });
  assert.deepEqual(result.members, [{ entryId: 'new', protection: 'checkpoint-protected' }]);
  assert.deepEqual([...result.finalizationCoveredPathBytes], [untracked.path.pathBytesBase64]);
});

test('edited bytes, mode mismatch, unreadable mode, and a missing finalization ref fail closed', async () => {
  const exact = member('new', 'protected.txt', 'present', matchingBlobOid, null);
  const cases = [
    { member: member('new', 'protected.txt', 'present', '0'.repeat(40), null), mode: '100644', row: finalization(exact) },
    { member: exact, mode: '100755', row: finalization(exact) },
    { member: exact, mode: null, row: finalization(exact) },
    { member: exact, mode: '100644', row: finalization(exact, { boundaryRef: 'refs/lares/missing' }) },
  ] as const;
  for (const item of cases) {
    const result = await evaluateCheckpointProtection({
      repoRoot: repo, members: [item.member], checkpointEdges: [], finalizations: [item.row],
      readRawGitMode: () => item.mode, runGit, runGitBytes, gitExe,
    });
    assert.equal(result.members[0].protection, 'unprotected');
    assert.equal(result.finalizationCoveredPathBytes.size, 0);
  }
});

test('live finalization protection never weakens exact locally committed evidence', async () => {
  const exact = member('local', 'protected.txt', 'present', matchingBlobOid, '100644');
  const result = await evaluateCheckpointProtection({
    repoRoot: repo, members: [exact], checkpointEdges: [], finalizations: [finalization(exact)],
    repositoryKey: 'repo',
    readCommitPathLinks: () => [{
      repositoryKey: 'repo', commitOid: checkpointOid,
      pathBytesBase64: exact.path.pathBytesBase64, expectedState: 'present', rawBlobOidAtCommit: null,
      commitBlobOid: matchingBlobOid, commitMode: '100644', contributingTurnIds: [], overlapCount: 0,
    }],
    readCurrentRepresentation: async () => ({
      expectedState: 'present', rawBlobOid: matchingBlobOid,
      commitBlobOid: matchingBlobOid, commitMode: '100644',
    }),
    runGit, runGitBytes, gitExe,
  });
  assert.equal(result.members[0].protection, 'locally-committed');
});

test('a live ref + blob hit is insufficient when the mode-confirm read fails or differs', async () => {
  // The real batch probe (runGitBytes) finds protected.txt's blob in the live
  // checkpoint → a candidate. Only the injected Phase-2 mode-confirm reader varies.
  const exact = member('member', 'protected.txt', 'present', matchingBlobOid, '100644');
  const readers: CheckpointTreeReader[] = [
    // Read failure for the edge → null → never protection proof.
    async () => null,
    async () => { throw new Error('tree unavailable'); },
    // Tree records a DIFFERENT path only → the member's path is absent from the map.
    async (): Promise<Map<string, CheckpointTreePresence>> => new Map([
      [encodedPath('other.txt').pathBytesBase64, { rawBlobOid: matchingBlobOid, mode: '100644' }],
    ]),
  ];

  for (const reader of readers) {
    const result = await evaluateCheckpointProtection({
      repoRoot: repo,
      members: [exact],
      checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
      runGit,
      runGitBytes,
      readCheckpointTree: reader,
      gitExe,
    });
    assert.equal(result.members[0].protection, 'unprotected');
  }
});

test('a Git failure during the batched membership probe degrades to unprotected', async () => {
  const exact = member('member', 'protected.txt', 'present', matchingBlobOid, '100644');
  const result = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [exact],
    checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
    runGit,
    runGitBytes: unreachableBytes, // Phase-1 batch probe throws → no proof, no throw
    gitExe,
  });
  assert.equal(result.members[0].protection, 'unprotected');
});

test('Stage 1 evaluator never emits locally-committed or remote-reachable', async () => {
  const result = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [
      member('protected', 'protected.txt', 'present', matchingBlobOid, '100644'),
      member('unprotected', 'ghost.txt', 'present', matchingBlobOid, '100644'),
    ],
    checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
    runGit,
    runGitBytes,
    gitExe,
  });

  assert.equal(result.members.find((m) => m.entryId === 'protected')!.protection, 'checkpoint-protected');
  const emitted = new Set(result.members.map((item) => item.protection));
  assert.deepEqual([...emitted].sort(), ['checkpoint-protected', 'unprotected']);
  assert.equal(emitted.has('locally-committed' as ProtectionRung), false);
  assert.equal(emitted.has('remote-reachable' as ProtectionRung), false);
});

test('raw match alone is insufficient; frozen clean-filtered entry is required', async () => {
  const exact = member('filtered', 'protected.txt', 'present', matchingBlobOid, '100644');
  const result = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [exact],
    checkpointEdges: [],
    repositoryKey: 'repo',
    readCommitPathLinks: () => [{
      repositoryKey: 'repo', commitOid: checkpointOid,
      pathBytesBase64: exact.path.pathBytesBase64,
      expectedState: 'present',
      rawBlobOidAtCommit: matchingBlobOid,
      commitBlobOid: 'e'.repeat(40),
      commitMode: '100644', contributingTurnIds: ['turn'], overlapCount: 1,
    }],
    readCurrentRepresentation: async () => ({
      expectedState: 'present', rawBlobOid: matchingBlobOid,
      commitBlobOid: 'f'.repeat(40), commitMode: '100644',
    }),
    runGit, runGitBytes, gitExe,
  });
  assert.equal(result.members[0].protection, 'unprotected');
});

test('exact frozen commit entry reaches locally-committed', async () => {
  const exact = member('local', 'protected.txt', 'present', matchingBlobOid, '100644');
  const result = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [exact], checkpointEdges: [], repositoryKey: 'repo',
    readCommitPathLinks: () => [{
      repositoryKey: 'repo', commitOid: checkpointOid,
      pathBytesBase64: exact.path.pathBytesBase64, expectedState: 'present',
      rawBlobOidAtCommit: '0'.repeat(40), // deliberately different: raw is not authority
      commitBlobOid: matchingBlobOid, commitMode: '100644',
      contributingTurnIds: ['turn'], overlapCount: 1,
    }],
    readCurrentRepresentation: async () => ({
      expectedState: 'present', rawBlobOid: matchingBlobOid,
      commitBlobOid: matchingBlobOid, commitMode: '100644',
    }),
    runGit, runGitBytes, gitExe,
  });
  assert.equal(result.members[0].protection, 'locally-committed');
});

test('remote rung is decided from live remote refs, not a cached database hint', async () => {
  git(['update-ref', 'refs/remotes/origin/main', checkpointOid]);
  const exact = member('remote', 'protected.txt', 'present', matchingBlobOid, '100644');
  const result = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [exact], checkpointEdges: [], repositoryKey: 'repo',
    readCommitPathLinks: () => [{
      repositoryKey: 'repo', commitOid: checkpointOid,
      pathBytesBase64: exact.path.pathBytesBase64, expectedState: 'present',
      rawBlobOidAtCommit: null, commitBlobOid: matchingBlobOid, commitMode: '100644',
      contributingTurnIds: [], overlapCount: 0,
    }],
    readCurrentRepresentation: async () => ({
      expectedState: 'present', rawBlobOid: matchingBlobOid,
      commitBlobOid: matchingBlobOid, commitMode: '100644',
    }),
    runGit, runGitBytes, gitExe,
  });
  assert.equal(result.members[0].protection, 'remote-reachable');
});

test('named probe budgets match the approved values and incident cardinality oracle', () => {
  assert.deepEqual(PROBE_PAIR_BUDGET, { soft: 100_000, hard: 250_000 });
  assert.deepEqual(PROBE_ESTIMATED_STDIN_BUDGET, { soft: 32 << 20, hard: 64 << 20 });
  const incidentPairs = 4_908 * 4_044;
  assert.equal(incidentPairs, 19_847_952);
  assert.ok(incidentPairs > PROBE_PAIR_BUDGET.hard * 79);
});

test('liveness, membership, and tree reads receive one caller-supplied absolute deadline', async () => {
  const deadlineAt = Date.now() + 60_000;
  const observedDeadlines: Array<number | undefined> = [];
  const exact = member('exact', 'protected.txt', 'present', matchingBlobOid, '100644');
  const result = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [exact],
    checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
    deadlineAt,
    runGit: (cwd, args, opts) => {
      observedDeadlines.push(opts.deadlineAt);
      return runGit(cwd, args, opts);
    },
    runGitBytes: (cwd, args, opts) => {
      observedDeadlines.push(opts.deadlineAt);
      return runGitBytes(cwd, args, opts);
    },
    gitExe,
  });
  assert.equal(result.members[0].protection, 'checkpoint-protected');
  assert.ok(observedDeadlines.length >= 3, 'liveness, membership, and tree-mode confirmation all run');
  assert.ok(observedDeadlines.every((value) => value === deadlineAt));
});

test('membership-probe pair budget: below and exactly-at proceed, one pair above refuses pre-spawn', async () => {
  const exact = member('exact', 'protected.txt', 'present', matchingBlobOid, '100644');
  const ghost = member('ghost', 'ghost.txt', 'present', matchingBlobOid, '100644');
  // 1 live commit × 2 batchable members = 2 pairs.
  const edges = [{ ref: CHECKPOINT_REF, oid: checkpointOid }];

  // Below budget (2 pairs < 3) and exactly at budget (2 pairs = 2): full evaluation runs.
  for (const maxMembershipProbePairs of [3, 2]) {
    const result = await evaluateCheckpointProtection({
      repoRoot: repo, members: [exact, ghost], checkpointEdges: edges,
      maxMembershipProbePairs, runGit, runGitBytes, gitExe,
    });
    assert.equal(result.members.find((m) => m.entryId === 'exact')!.protection, 'checkpoint-protected');
  }

  // One pair above budget (2 pairs > 1): typed refusal, and it must fire BEFORE
  // any binary Git call (i.e. before the cross-product Buffers / cat-file spawn).
  let bytesCalls = 0;
  const countingBytes: RunProtectionGitBytes = async (...args) => {
    bytesCalls++;
    return runGitBytes(...args);
  };
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
  try {
    await assert.rejects(
      evaluateCheckpointProtection({
        repoRoot: repo, members: [exact, ghost], checkpointEdges: edges,
        maxMembershipProbePairs: 1, runGit, runGitBytes: countingBytes, gitExe,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CheckpointProtectionBudgetExceededError);
        assert.equal(error.code, 'checkpoint-protection-budget-exceeded');
        assert.deepEqual(
          { liveOids: error.cardinality.liveOids, batchable: error.cardinality.batchable, maxPairs: error.cardinality.maxPairs },
          { liveOids: 1, batchable: 2, maxPairs: 1 },
        );
        // Counts only — the error (and therefore the log payload) carries no
        // paths or workspace content.
        const serialized = error.message + JSON.stringify(error.cardinality);
        assert.ok(!serialized.includes('protected.txt') && !serialized.includes('ghost.txt'));
        return true;
      },
    );
  } finally {
    console.warn = realWarn;
  }
  assert.equal(bytesCalls, 0, 'refusal must precede every runGitBytes spawn');
  assert.ok(warned.some((line) => line.includes('pair budget exceeded')));
  assert.ok(!warned.some((line) => line.includes('protected.txt') || line.includes('ghost.txt')));
});

test('zero live checkpoint edges never trip the pair budget (retention-style call)', async () => {
  const exact = member('exact', 'protected.txt', 'present', matchingBlobOid, '100644');
  const result = await evaluateCheckpointProtection({
    repoRoot: repo, members: [exact], checkpointEdges: [],
    maxMembershipProbePairs: 0, runGit, runGitBytes, gitExe,
  });
  assert.equal(result.members[0].protection, 'unprotected');
});

test('estimated-stdin guard proceeds at budget and refuses pre-spawn one pair above', async () => {
  const exact = member('exact', 'protected.txt', 'present', matchingBlobOid, '100644');
  const ghost = member('ghost', 'ghost.txt', 'present', matchingBlobOid, '100644');
  const onePairBudget = Math.floor((exact.path.pathBytesBase64.length * 3) / 4) + 42;
  const atBudget = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [exact],
    checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
    maxMembershipProbePairs: 1,
    maxEstimatedMembershipProbeStdinBytes: onePairBudget,
    runGit,
    runGitBytes,
    gitExe,
  });
  assert.equal(atBudget.members[0].protection, 'checkpoint-protected');

  const members = [exact, ghost];
  let bytesCalls = 0;
  await assert.rejects(
    evaluateCheckpointProtection({
      repoRoot: repo,
      members,
      checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
      maxMembershipProbePairs: members.length,
      maxEstimatedMembershipProbeStdinBytes: onePairBudget,
      runGit,
      runGitBytes: async (...args) => { bytesCalls++; return runGitBytes(...args); },
      gitExe,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CheckpointProtectionBudgetExceededError);
      assert.deepEqual(error.reasonCodes, ['estimated-stdin']);
      assert.ok(error.cardinality.estimatedStdinBytes > error.cardinality.maxEstimatedStdinBytes);
      return true;
    },
    'REACHABILITY:protection-budget-admission estimated stdin above the hard limit must refuse before spawn',
  );
  assert.equal(bytesCalls, 0, 'stdin admission happens before every binary Git spawn');
});

test('simultaneous admission and deadline trips collect every observed reason code', async () => {
  const exact = member('exact', 'protected.txt', 'present', matchingBlobOid, '100644');
  const ghost = member('ghost', 'ghost.txt', 'present', matchingBlobOid, '100644');
  let bytesCalls = 0;
  const deadlineIgnoringLiveness = (cwd: string, args: string[], opts: Parameters<typeof runGit>[2]) =>
    runGit(cwd, args, { ...opts, deadlineAt: undefined });
  await assert.rejects(
    evaluateCheckpointProtection({
      repoRoot: repo,
      members: [exact, ghost],
      checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
      maxMembershipProbePairs: 1,
      maxEstimatedMembershipProbeStdinBytes: 1,
      deadlineAt: 0,
      runGit: deadlineIgnoringLiveness,
      runGitBytes: async (...args) => { bytesCalls++; return runGitBytes(...args); },
      gitExe,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CheckpointProtectionBudgetExceededError);
      assert.deepEqual(new Set(error.reasonCodes), new Set(['pairs', 'estimated-stdin', 'deadline']));
      return true;
    },
  );
  assert.equal(bytesCalls, 0);
});

test('bundle weakest rung is the minimum by PROTECTION_RUNG_ORDER', () => {
  assert.equal(weakestProtectionRung([
    'remote-reachable',
    'locally-committed',
    'checkpoint-protected',
  ]), 'checkpoint-protected');
  assert.equal(weakestProtectionRung([
    'remote-reachable',
    'unprotected',
    'locally-committed',
  ]), 'unprotected');
  assert.throws(() => weakestProtectionRung([]), /empty bundle/);
});

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  FAIL no compatible Git resolved; protection-read tests require real Git.');
    process.exit(1);
  }
  gitExe = internal.execPath;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-protection-read-'));

  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@lares.local']);
    git(['config', 'user.name', 'Lares Test']);
    git(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'protected.txt'), 'checkpoint bytes\n');
    fs.writeFileSync(path.join(repo, 'deleted.txt'), 'present before deletion\n');
    git(['add', '--', 'protected.txt', 'deleted.txt']);
    git(['commit', '-q', '-m', 'before deletion']);
    deletionPresentOid = git(['rev-parse', 'HEAD']);
    git(['update-ref', DELETION_PRESENT_REF, deletionPresentOid]);
    fs.unlinkSync(path.join(repo, 'deleted.txt'));
    git(['add', '--', 'deleted.txt']);
    git(['commit', '-q', '-m', 'checkpoint after deletion']);
    checkpointOid = git(['rev-parse', 'HEAD']);
    matchingBlobOid = git(['rev-parse', 'HEAD:protected.txt']);
    git(['update-ref', CHECKPOINT_REF, checkpointOid]);

    let passed = 0;
    let failed = 0;
    for (const t of tests) {
      try {
        await t.run();
        console.log(`  ok  ${t.name}`);
        passed++;
      } catch (error) {
        console.error(`  FAIL ${t.name}`);
        console.error('       ', error instanceof Error ? error.stack || error.message : error);
        failed++;
      }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
})();
