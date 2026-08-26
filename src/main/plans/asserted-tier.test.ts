import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverAssertedDispatchEvidence, type AssertedAttemptSource } from './asserted-tier';
import type { GitCommitView, LandedCommitGitOracle } from './landed-commit-verifier';

const OID = (char: string) => char.repeat(40);
const BASE = OID('a');
const ONE = OID('1');
const TWO = OID('2');

class FakeGit implements LandedCommitGitOracle {
  range: string[] = [];
  truncated = false;
  resolvable = true;
  ancestor = true;
  async resolveCommit() { return this.resolvable ? TWO : null; }
  async isAncestor() { return this.ancestor; }
  async listFirstParentRange(_r: string, _a: string, _b: string, cap?: number) {
    const truncated = cap !== undefined && this.range.length > cap;
    return { commitOids: truncated ? this.range.slice(0, cap) : this.range, truncated: truncated || this.truncated };
  }
  async readCommit(_r: string, oid: string): Promise<GitCommitView> {
    return { oid, subject: `subject ${oid[0]}`, parentOids: [BASE],
      message: `subject\n\nPlan: plan_16910c64\nWP: WP-2\nVerified: suite => PASS (1 passed)` };
  }
  async interpretTrailers(_r: string, value: string) {
    return value.trimEnd().split(/\n\n+/).at(-1)!.split('\n').map((line) => {
      const at = line.indexOf(':'); return { key: line.slice(0, at), value: line.slice(at + 1).trimStart() };
    });
  }
  async changedPaths() { return [Buffer.from('a.ts')]; }
}

function attempt(id = 'attempt-1'): AssertedAttemptSource {
  return {
    packageId: 'WP-2', dispatchAttemptId: id, packageRevision: 1,
    repositoryKey: 'repo', branchRef: 'refs/heads/master', dispatchTipOid: BASE,
    frozenPaths: ['a.ts'], captureStatus: 'captured', planArtifactId: 'plan_16910c64',
    repositoryRoot: 'C:/repo',
  };
}

test('retains zero, one and every multiple candidate without selecting one', async () => {
  for (const range of [[], [ONE], [ONE, TWO]]) {
    const git = new FakeGit(); git.range = range;
    const result = await discoverAssertedDispatchEvidence('plan-db', {
      listAttempts: () => [attempt()], oracleFor: () => git,
    });
    assert.deepEqual(result[0].candidates.map((candidate) => candidate.commitOid), range,
      range.length > 1 ? 'REACHABILITY:wp2-verifier-exactly-one' : undefined);
    assert.equal(result[0].scanStatus, 'complete');
  }
});

test('a capped scan is explicitly truncated and its candidates are a lower bound', async () => {
  const git = new FakeGit(); git.range = [ONE, TWO];
  const [result] = await discoverAssertedDispatchEvidence('plan-db', {
    listAttempts: () => [attempt()], oracleFor: () => git, scanCap: 1,
  });
  assert.equal(result.scanStatus, 'truncated');
  assert.deepEqual(result.candidates.map((candidate) => candidate.commitOid), [ONE]);
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
