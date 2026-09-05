import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverAssertedDispatchEvidence, type AssertedAttemptSource } from './asserted-tier';
import type { GitCommitView, LandedCommitGitOracle } from './landed-commit-verifier';

const OID = (char: string) => char.repeat(40);
const BASE = OID('a');
const ONE = OID('1');
const TWO = OID('2');
const THREE = OID('3');

type CommitFixture = { message?: string; paths?: string[]; parents?: string[] };

class FakeGit implements LandedCommitGitOracle {
  range: string[] = [];
  truncated = false;
  resolvable = true;
  ancestor = true;
  pathFailure = new Set<string>();
  commits = new Map<string, CommitFixture>();
  async resolveCommit() { return this.resolvable ? THREE : null; }
  async isAncestor() { return this.ancestor; }
  async listFirstParentRange(_r: string, _a: string, _b: string, cap?: number) {
    const truncated = cap !== undefined && this.range.length > cap;
    return { commitOids: truncated ? this.range.slice(0, cap) : this.range, truncated: truncated || this.truncated };
  }
  async readCommit(_r: string, oid: string): Promise<GitCommitView> {
    const fixture = this.commits.get(oid) ?? {};
    return { oid, subject: `subject ${oid[0]}`, parentOids: fixture.parents ?? [BASE],
      message: fixture.message ?? `subject\n\nPlan: plan_16910c64\nWP: WP-2\nVerified: suite one\nVerified: suite two\nScope-omitted: none` };
  }
  async interpretTrailers(_r: string, value: string) {
    return value.trimEnd().split(/\n\n+/).at(-1)!.split('\n').map((line) => {
      const at = line.indexOf(':'); return { key: line.slice(0, at), value: line.slice(at + 1).trimStart() };
    });
  }
  async changedPaths(_r: string, _p: string, oid: string) {
    if (this.pathFailure.has(oid)) throw new Error('path oracle unavailable');
    return (this.commits.get(oid)?.paths ?? ['a.ts']).map((item) => Buffer.from(item));
  }
}

function attempt(id = 'attempt-1'): AssertedAttemptSource {
  return {
    packageId: 'WP-2', dispatchAttemptId: id, packageRevision: 1,
    repositoryKey: 'repo', branchRef: 'refs/heads/master', dispatchTipOid: BASE,
    frozenPaths: ['a.ts'], captureStatus: 'captured', planArtifactId: 'plan_16910c64',
    repositoryRoot: 'C:/repo',
  };
}

test('discovers the deduplicated union of labels-only and paths-only candidates', async () => {
  const git = new FakeGit();
  git.range = [ONE, TWO, THREE, ONE];
  git.commits.set(ONE, { paths: ['other.ts'] });
  git.commits.set(TWO, { message: 'subject\n\nPlan: other\nWP: WIP', paths: ['a.ts'] });
  git.commits.set(THREE, { message: 'subject\n\nPlan: other\nWP: WIP', paths: ['other.ts'] });
  const [result] = await discoverAssertedDispatchEvidence('plan-db', {
    listAttempts: () => [attempt()], oracleFor: () => git,
  });
  assert.equal(result.scanStatus, 'complete');
  assert.deepEqual(result.candidates, [
    {
      commitOid: ONE, parentOid: BASE, subject: 'subject 1', sources: ['labels'],
      labelsMatch: true, changedPathsMatchFrozen: false,
      planTrailer: 'plan_16910c64', wpTrailer: 'WP-2',
      verifiedTrailers: ['suite one', 'suite two'], scopeOmittedTrailers: ['none'],
    },
    {
      commitOid: TWO, parentOid: BASE, subject: 'subject 2', sources: ['changed-paths'],
      labelsMatch: false, changedPathsMatchFrozen: true,
      planTrailer: 'other', wpTrailer: 'WIP', verifiedTrailers: [], scopeOmittedTrailers: [],
    },
  ]);
});

test('normalizes a minted package id before the WP comparison', async () => {
  const git = new FakeGit(); git.range = [ONE]; git.commits.set(ONE, { paths: ['other.ts'] });
  const minted = { ...attempt(), packageId: 'wp:plan_16910c64:WP-2' };
  const [result] = await discoverAssertedDispatchEvidence('plan-db', {
    listAttempts: () => [minted], oracleFor: () => git,
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.commitOid), [ONE],
    'REACHABILITY:asserted-tier minted package id must normalize before label comparison');
  assert.deepEqual(result.candidates[0].sources, ['labels']);
});

test('retains labels-only candidates when the path oracle is unavailable', async () => {
  const git = new FakeGit(); git.range = [ONE]; git.pathFailure.add(ONE);
  const [result] = await discoverAssertedDispatchEvidence('plan-db', {
    listAttempts: () => [attempt()], oracleFor: () => git,
  });
  assert.equal(result.candidates[0].changedPathsMatchFrozen, null);
  assert.deepEqual(result.candidates[0].sources, ['labels']);
});

test('excludes merges and retains a capped scan as an explicit lower bound', async () => {
  const git = new FakeGit(); git.range = [ONE, TWO, THREE];
  git.commits.set(ONE, { parents: [BASE, OID('b')] });
  const [result] = await discoverAssertedDispatchEvidence('plan-db', {
    listAttempts: () => [attempt()], oracleFor: () => git, scanCap: 2,
  });
  assert.equal(result.scanStatus, 'truncated');
  assert.deepEqual(result.candidates.map((candidate) => candidate.commitOid), [TWO]);
});

test('emits one record for every current-revision attempt supplied by the query seam', async () => {
  const git = new FakeGit(); git.range = [ONE];
  const results = await discoverAssertedDispatchEvidence('plan-db', {
    listAttempts: () => [attempt('attempt-1'), attempt('attempt-2')], oracleFor: () => git,
  });
  assert.deepEqual(results.map((result) => result.dispatchAttemptId), ['attempt-1', 'attempt-2']);
});

test('missing envelope is unavailable, does not construct git, and does not throw', async () => {
  let oracleCalls = 0;
  const missing = { ...attempt(), captureStatus: 'unavailable' as const, repositoryKey: null };
  const result = await discoverAssertedDispatchEvidence('plan-db', {
    listAttempts: () => [missing], oracleFor: () => { oracleCalls += 1; return new FakeGit(); },
  });
  assert.deepEqual(result, [{
    packageId: 'WP-2', dispatchAttemptId: 'attempt-1', scanStatus: 'unavailable', candidates: [],
    refusal: 'dispatch-evidence-missing',
  }]);
  assert.equal(oracleCalls, 0);
});

test('git refusal and thrown oracle failures become unavailable evidence records', async () => {
  const unresolvable = new FakeGit(); unresolvable.resolvable = false;
  assert.equal((await discoverAssertedDispatchEvidence('plan-db', {
    listAttempts: () => [attempt()], oracleFor: () => unresolvable,
  }))[0].refusal, 'branch-unresolvable');
  assert.equal((await discoverAssertedDispatchEvidence('plan-db', {
    listAttempts: () => [attempt()], oracleFor: () => { throw new Error('offline'); },
  }))[0].scanStatus, 'unavailable');
});
