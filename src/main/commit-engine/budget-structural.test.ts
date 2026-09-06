// WP-H — structural OOM-budget and single-flight regression oracle.
//
// This suite intentionally asserts admission/streaming behavior. It never makes
// a claim about process memory and never materializes the 4,908 x 4,044 incident
// cross-product.

import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  CommitCandidate,
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
  EncodedGitPath,
  RepositoryIdentity,
} from '../../shared/commit-candidates';
import type { PackageFinalization } from '../database';
import {
  DIRTY_ENTRY_BUDGET,
  PATH_BYTES_BUDGET,
  STATUS_OUTPUT_BYTE_BUDGET,
  produceDirtyInventory,
  type RunGitStreamLike,
} from './dirty-inventory';
import {
  PROBE_ESTIMATED_STDIN_BUDGET,
  PROBE_PAIR_BUDGET,
  evaluateCheckpointProtection,
  type ProtectionMember,
} from './protection-read';
import { CommitCandidateSnapshotRegistry } from './snapshot-registry';
import { CommitCandidateService, type CandidateBuildContext } from './candidate-service';

const IDENTITY: RepositoryIdentity = {
  repositoryKey: 'structural-repository',
  objectDatabaseKey: 'structural-objects',
  gitObjectFormat: 'sha1',
  bareRepo: false,
  workspaces: [{ workspaceId: 'workspace', workspacePrefix: '' }],
};

function ordinaryRecord(name: string): Buffer {
  return Buffer.concat([
    Buffer.from('1 M. N... 100644 100644 100644 aaaa bbbb ', 'ascii'),
    Buffer.from(name, 'utf8'),
    Buffer.from([0]),
  ]);
}

function pullingStream(
  chunks: readonly Buffer[],
  pulls: { value: number },
): RunGitStreamLike {
  return async (_cwd, args, _options, onStdout) => {
    if (args.includes('ls-files')) return { code: 0, stderr: '', stoppedEarly: false };
    for (const chunk of chunks) {
      pulls.value += 1;
      if (!onStdout(chunk)) return { code: 0, stderr: '', stoppedEarly: true };
    }
    return { code: 0, stderr: '', stoppedEarly: false };
  };
}

function protectionMember(id: string, rawPath = `${id}.txt`): ProtectionMember {
  const encoded = {
    pathBytesBase64: Buffer.from(rawPath, 'utf8').toString('base64'),
    displayPath: rawPath,
    utf8Clean: true,
  };
  return {
    entryId: id,
    path: encoded,
    commitPathspecs: [encoded],
    expectedWorktreeState: 'present',
    rawWorktreeBlobOid: 'b'.repeat(40),
    worktreeMode: '100644',
  };
}

const CANDIDATE_OID = 'c'.repeat(40);
function candidatePath(): EncodedGitPath {
  return {
    pathBytesBase64: Buffer.from('src/selected.ts').toString('base64'),
    displayPath: 'src/selected.ts',
    utf8Clean: true,
  };
}

function candidateContext(completeness: 'complete' | 'partial'): CandidateBuildContext {
  const selectedPath = candidatePath();
  const entry: DirtyEntry = {
    entryId: 'entry', path: selectedPath, originalPath: null, entryKind: 'ordinary',
    indexStatus: '.', worktreeStatus: 'M', headMode: '100644', indexMode: '100644',
    worktreeMode: '100644', submoduleState: null, renameOrCopyScore: null,
    expectedWorktreeState: 'present', rawWorktreeBlobOid: 'raw-entry',
    gitLevelEligibility: 'supported', commitPathspecs: [selectedPath],
  };
  const component: ConflictComponent = {
    componentId: 'component', dirtyEntryIds: ['entry'],
    associations: [{ planId: 'plan', planItemId: null, contributingTurnIds: ['turn'], memberEntryIds: ['entry'] }],
    overlap: { componentId: 'component', contributingAgentCount: 1, mergedGroupCount: 1, perPathContributors: {} },
    componentTopologyDigest: 'topology',
  };
  const inventory: DirtyInventory = {
    repository: IDENTITY, entries: [entry], unattributedEntryIds: [], topologyDigest: 'inventory',
    completeness, totalsExact: completeness === 'complete',
  };
  const finalization: PackageFinalization = {
    id: 'finalization', packageId: 'package', packageRevision: 1, finalizationKind: 'fleet-adhoc',
    planId: null, planItemId: null, repositoryKey: IDENTITY.repositoryKey,
    checkpointTurnId: null, checkpointOid: CANDIDATE_OID, boundaryRef: 'refs/lares/finalization',
    boundaryStatus: 'ready', memberManifestJson: JSON.stringify([{
      pathBytesBase64: selectedPath.pathBytesBase64, expectedState: 'present', rawBlobOid: 'raw-entry',
      commitBlobOid: CANDIDATE_OID, commitMode: '100644',
    }]),
    contractVersion: 1, lifecycleStatus: 'active', finalizedBy: 'human-ipc', finalizedAt: 1,
    supersededByFinalizationId: null, releasedAt: null, failureReason: null,
    createdFromWorkspaceId: 'workspace',
  };
  return {
    repository: IDENTITY, inventory, components: [component], finalizations: [finalization],
    currentCommitReps: new Map([['entry', {
      expectedState: 'present' as const, rawBlobOid: 'raw-entry',
      commitBlobOid: CANDIDATE_OID, commitMode: '100644',
    }]]),
    ledger: [], pinnedHeadOid: 'd'.repeat(40),
    indexFingerprint: { fingerprint: 'fingerprint', entries: [], hasUnmerged: false, writeTreeOid: null },
    contractVersion: 1,
  };
}

function liveText(oid: string) {
  return async (_cwd: string, _args: string[], options: { stdin?: Buffer | string }) => {
    const count = String(options.stdin ?? '').trim().split('\n').filter(Boolean).length;
    return { code: 0, stdout: `${`${oid} commit 1\n`.repeat(count)}`, stderr: '' };
  };
}

async function protectionBudgetTrip(input: {
  maxPairs: number;
  maxStdin: number;
  deadlineAt?: number;
}): Promise<{ reasons: Set<string>; bytesCalls: number; protections: string[] }> {
  const oid = 'a'.repeat(40);
  let bytesCalls = 0;
  const warnings: unknown[][] = [];
  const previousWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const result = await evaluateCheckpointProtection({
      repoRoot: 'C:/synthetic',
      repositoryKey: 'structural-repository',
      members: [protectionMember('one'), protectionMember('two')],
      checkpointEdges: [{ ref: 'refs/lares/checkpoints/one', oid }],
      maxMembershipProbePairs: input.maxPairs,
      maxEstimatedMembershipProbeStdinBytes: input.maxStdin,
      deadlineAt: input.deadlineAt,
      runGit: liveText(oid),
      runGitBytes: async () => {
        bytesCalls += 1;
        throw new Error('pre-spawn guard failed');
      },
    });
    const payload = warnings.flat().find((value): value is { reasonCodes: string[] } =>
      typeof value === 'object' && value !== null && 'reasonCodes' in value);
    return {
      reasons: new Set(payload?.reasonCodes ?? result.observedStopReasons),
      bytesCalls,
      protections: result.members.map((member) => member.protection),
    };
  } finally {
    console.warn = previousWarn;
  }
}

test('4,908 x 4,044 incident cardinality is rejected by the named pair budget without allocation', () => {
  const incidentFiles = 4_908;
  const incidentCheckpoints = 4_044;
  const incidentPairs = incidentFiles * incidentCheckpoints;
  assert.equal(incidentPairs, 19_847_952);
  assert.deepEqual(PROBE_PAIR_BUDGET, { soft: 100_000, hard: 250_000 });
  assert.deepEqual(PROBE_ESTIMATED_STDIN_BUDGET, { soft: 32 << 20, hard: 64 << 20 });
  assert.ok(incidentPairs > PROBE_PAIR_BUDGET.hard);
  assert.equal(Math.floor(PROBE_PAIR_BUDGET.hard / incidentFiles), 50);
  assert.ok(incidentCheckpoints > 50, 'the incident is refused from cardinalities alone');
});

test('entry, status-byte, path-byte, and deadline caps stop source pulls and all hashing', async () => {
  assert.deepEqual(DIRTY_ENTRY_BUDGET, { soft: 5_000, hard: 10_000 });
  assert.deepEqual(STATUS_OUTPUT_BYTE_BUDGET, { hard: 64 << 20 });
  assert.deepEqual(PATH_BYTES_BUDGET, { hard: 16 << 20 });

  const cases = [
    { name: 'entries', chunks: [ordinaryRecord('a'), ordinaryRecord('b'), ordinaryRecord('unread')], options: { maxEntries: 1 }, pulls: 2 },
    { name: 'status-bytes', chunks: [Buffer.from('abc'), Buffer.from('def'), Buffer.from('unread')], options: { maxBytes: 4 }, pulls: 2 },
    { name: 'path-bytes', chunks: [ordinaryRecord('a'), ordinaryRecord('long'), ordinaryRecord('unread')], options: { maxPathBytes: 1 }, pulls: 2 },
    { name: 'deadline', chunks: [ordinaryRecord('unread'), ordinaryRecord('also-unread')], options: { deadlineAt: 0 }, pulls: 1 },
  ] as const;

  for (const item of cases) {
    const pulls = { value: 0 };
    let hashCalls = 0;
    const result = await produceDirtyInventory({
      repoRoot: 'C:/synthetic', workspacePrefix: '', repository: IDENTITY, gitExe: 'git',
      runGitStream: pullingStream(item.chunks, pulls),
      runGitBytes: async () => { hashCalls += 1; return { code: 0, stdout: Buffer.alloc(0), stderr: '' }; },
      runGit: async () => { hashCalls += 1; return { code: 0, stdout: '', stderr: '' }; },
      ...item.options,
    });
    assert.equal(pulls.value, item.pulls, `${item.name} stops before unread chunks are pulled`);
    assert.equal(hashCalls, 0, `${item.name} partial never reaches hashing`);
    assert.equal(result.completeness, 'partial');
    assert.equal(result.totalsExact, false, `${item.name} totals are lower bounds`);
    assert.ok(result.observedStopReasons.includes(item.name as never));
  }
});

test('pair, estimated-stdin, and deadline admission trips are incomplete and pre-spawn', async () => {
  const pair = await protectionBudgetTrip({ maxPairs: 1, maxStdin: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(pair.reasons, new Set(['pairs']));
  assert.equal(pair.bytesCalls, 0);
  assert.deepEqual(pair.protections, ['unknown', 'unknown']);

  const stdin = await protectionBudgetTrip({ maxPairs: 2, maxStdin: 1 });
  assert.deepEqual(stdin.reasons, new Set(['estimated-stdin']));
  assert.equal(stdin.bytesCalls, 0);
  assert.deepEqual(stdin.protections, ['unknown', 'unknown']);

  const deadline = await protectionBudgetTrip({
    maxPairs: Number.MAX_SAFE_INTEGER,
    maxStdin: Number.MAX_SAFE_INTEGER,
    deadlineAt: 0,
  });
  assert.deepEqual(deadline.reasons, new Set(['deadline']));
  assert.equal(deadline.bytesCalls, 0);
  assert.deepEqual(deadline.protections, ['unknown', 'unknown']);
});

test('ordinary probe failure is incomplete and an earlier proof survives as provenRung', async () => {
  const oid = 'a'.repeat(40);
  const member = protectionMember('proof');
  const base = {
    repoRoot: 'C:/synthetic', repositoryKey: 'structural-repository', members: [member],
    checkpointEdges: [{ ref: 'refs/lares/checkpoints/one', oid }],
    runGit: liveText(oid),
    runGitBytes: async () => { throw new Error('synthetic probe failure'); },
  };
  const failed = await evaluateCheckpointProtection(base);
  assert.deepEqual(failed.assessment, { evaluation: 'incomplete' });
  assert.equal(failed.members[0].protection, 'unknown');

  const proven = await evaluateCheckpointProtection({
    ...base,
    finalizations: [{
      id: 'fin', packageId: 'pkg', packageRevision: 1, finalizationKind: 'fleet-adhoc',
      planId: null, planItemId: null, repositoryKey: 'structural-repository',
      checkpointTurnId: null, checkpointOid: oid, boundaryRef: 'refs/lares/checkpoints/one',
      boundaryStatus: 'ready', memberManifestJson: JSON.stringify([{
        pathBytesBase64: member.path.pathBytesBase64, expectedState: 'present',
        rawBlobOid: member.rawWorktreeBlobOid, commitBlobOid: member.rawWorktreeBlobOid,
        commitMode: '100644',
      }]),
      contractVersion: 1, lifecycleStatus: 'active', finalizedBy: 'human-ipc', finalizedAt: 1,
      supersededByFinalizationId: null, releasedAt: null, failureReason: null,
      createdFromWorkspaceId: 'workspace',
    }],
    readRawGitMode: () => '100644',
  });
  assert.deepEqual(proven.assessment, { evaluation: 'incomplete', provenRung: 'checkpoint-protected' });
  assert.equal(proven.members[0].protection, 'checkpoint-protected');
});

test('registry admission is sequential, failed flights evict, and default LRU(8)/TTL(500ms) hold', async () => {
  let clock = 0;
  const registry = new CommitCandidateSnapshotRegistry<string>({ now: () => clock });
  let active = 0;
  let maxActive = 0;
  let sameGenerationRuns = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const compute = async (value: string) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (value === 'generation-0') await gate;
    active -= 1;
    return value;
  };
  const first = registry.acquire({ repositoryKey: 'repo', policyGeneration: 0 }, async () => {
    sameGenerationRuns += 1;
    return compute('generation-0');
  });
  const joiner = registry.acquire({ repositoryKey: 'repo', policyGeneration: 0 }, async () => {
    sameGenerationRuns += 1;
    return 'must-not-run';
  });
  const nextGeneration = registry.acquire(
    { repositoryKey: 'repo', policyGeneration: 1 },
    () => compute('generation-1'),
  );
  const scoped = registry.acquireScoped(
    { repositoryKey: 'repo', policyGeneration: 1 },
    () => compute('scoped'),
  );
  await Promise.resolve();
  assert.equal(sameGenerationRuns, 1, 'concurrent consumers share one canonical computation');
  release();
  assert.deepEqual(await Promise.all([first, joiner, nextGeneration, scoped]),
    ['generation-0', 'generation-0', 'generation-1', 'scoped']);
  assert.equal(maxActive, 1, 'generation changes and scoped recovery never overlap the canonical scan');

  let failures = 0;
  await assert.rejects(registry.acquire({ repositoryKey: 'failed', policyGeneration: 0 }, async () => {
    failures += 1;
    throw new Error('failed flight');
  }), /failed flight/);
  await registry.acquire({ repositoryKey: 'failed', policyGeneration: 0 }, async () => {
    failures += 1;
    return 'recovered';
  });
  assert.equal(failures, 2, 'a failed flight is evicted rather than cached');

  for (let index = 0; index < 9; index += 1) {
    await registry.acquire({ repositoryKey: `lru-${index}`, policyGeneration: 0 }, async () => `${index}`);
  }
  assert.equal(registry.hasCached({ repositoryKey: 'lru-0', policyGeneration: 0 }), false);
  assert.equal(registry.hasCached({ repositoryKey: 'lru-8', policyGeneration: 0 }), true);
  clock = 500;
  assert.equal(registry.hasCached({ repositoryKey: 'lru-8', policyGeneration: 0 }), false,
    'the default TTL expires at exactly 500 ms');
});

test('partial global evidence cannot mint while independently complete scoped evidence can', () => {
  const service = new CommitCandidateService({
    runGit: async () => ({ code: 0, stdout: '', stderr: '' }),
    runGitBytes: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }),
    readTurnWitnesses: () => [],
    readCaptureTurns: () => [],
  });
  const request = {
    selectedComponentIds: ['component'], selectedUnattributedEntryIds: [],
    finalizationIds: ['finalization'], acknowledgeUnattributedEntryIds: [],
  };
  const partial = service.mintCandidateToken(request, candidateContext('partial')) as CommitCandidate;
  assert.deepEqual(partial.eligibility, { eligible: false, reason: 'checkpoint-unavailable' });
  assert.equal(partial.token, null, 'REACHABILITY:partial-global-cannot-mint');

  const scoped = service.mintCandidateToken(request, candidateContext('complete')) as CommitCandidate;
  assert.equal(scoped.eligibility.eligible, true);
  assert.ok(scoped.token, 'REACHABILITY:complete-scoped-can-mint');

});
