import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createGitOracle,
  verifyLandedCommit,
  type GitCommitView,
  type LandedCommitGitOracle,
} from './landed-commit-verifier';
import { briefedWorkPackageId } from './work-package-id';

const OID = (char: string) => char.repeat(40);
const BASE = OID('a');
const PRIOR = OID('0');
const NAMED = OID('1');
const POST = OID('2');
const OTHER = OID('3');

function message(plan = 'plan_16910c64', wp = 'WP-2', extra = ''): string {
  return `subject\n\nPlan: ${plan}\nWP: ${wp}\nVerified: tests => PASS (1 passed)${extra}`;
}

class FakeGit implements LandedCommitGitOracle {
  gateTip: string | null = POST;
  ancestor = true;
  range = [POST, NAMED];
  truncated = false;
  commits = new Map<string, GitCommitView>([
    [PRIOR, { oid: PRIOR, subject: 'prior', message: message(), parentOids: [BASE] }],
    [NAMED, { oid: NAMED, subject: 'named', message: message(), parentOids: [BASE] }],
    [POST, { oid: POST, subject: 'post', message: message(), parentOids: [NAMED] }],
  ]);
  paths = new Map<string, Buffer[]>([
    [PRIOR, [Buffer.from('a.ts')]],
    [NAMED, [Buffer.from('a.ts')]],
    [POST, [Buffer.from('other.ts')]],
  ]);
  calls: Array<{ method: string; args: unknown[] }> = [];

  async resolveCommit(_repositoryKey: string, revision: string) {
    this.calls.push({ method: 'resolveCommit', args: [revision] });
    return revision === 'refs/heads/master^{commit}' ? this.gateTip : null;
  }
  async isAncestor(_repositoryKey: string, ancestorOid: string, descendantOid: string) {
    this.calls.push({ method: 'isAncestor', args: [ancestorOid, descendantOid] });
    return this.ancestor;
  }
  async listFirstParentRange(_repositoryKey: string, from: string, to: string, cap?: number) {
    this.calls.push({ method: 'listFirstParentRange', args: [from, to, cap] });
    return { commitOids: this.range, truncated: this.truncated };
  }
  async readCommit(_repositoryKey: string, oid: string) {
    this.calls.push({ method: 'readCommit', args: [oid] });
    return this.commits.get(oid)!;
  }
  async interpretTrailers(_repositoryKey: string, value: string) {
    this.calls.push({ method: 'interpretTrailers', args: [value] });
    const paragraph = value.replace(/\r\n/g, '\n').trimEnd().split(/\n\n+/).at(-1)!;
    return paragraph.split('\n').filter((line) => line.includes(':')).map((line) => {
      const index = line.indexOf(':');
      return { key: line.slice(0, index), value: line.slice(index + 1).trimStart() };
    });
  }
  async changedPaths(_repositoryKey: string, parent: string, oid: string) {
    this.calls.push({ method: 'changedPaths', args: [parent, oid] });
    return this.paths.get(oid)!;
  }
}

const input = (commitOid = NAMED) => ({
  repositoryKey: 'repo', branchRef: 'refs/heads/master', dispatchTipOid: BASE,
  frozenPaths: ['a.ts'], planArtifactId: 'plan_16910c64', wpId: 'WP-2', commitOid,
});

test('verifies the named OID in a complete range and records V2 evidence', async () => {
  const git = new FakeGit();
  git.commits.get(NAMED)!.message = `fix: subject\n\nbody Plan: prose is ignored\n\nPlan: plan_16910c64\nWP: wp-2\nVerified: first\nVerified: second\nScope-omitted: docs\nUnknown: tolerated`;
  const result = await verifyLandedCommit(input(), git);
  assert.deepEqual(result, {
    outcome: 'verified',
    evidence: {
      schemaVersion: 2,
      repositoryKey: 'repo',
      branchRef: 'refs/heads/master',
      dispatchTipOid: BASE,
      gateTipOid: POST,
      namedCommit: { commitOid: NAMED, parentOid: BASE, subject: 'named' },
      labels: {
        plan: 'plan_16910c64', wp: 'wp-2', verified: ['first', 'second'], scopeOmitted: ['docs'],
      },
      changedPaths: ['a.ts'],
      priorFrozenPathTouches: [],
      postClaimTouches: [],
    },
  });
  assert.equal(git.calls.find((call) => call.method === 'listFirstParentRange')!.args[2], undefined);
  assert.equal(git.calls.filter((call) => call.method === 'resolveCommit').length, 1);
});

test('normalizes minted package ids through the shared helper', async () => {
  assert.equal(briefedWorkPackageId('wp:plan_16910c64:WP-2', 'plan_16910c64'), 'WP-2');
  assert.equal(briefedWorkPackageId('WP-2', 'plan_16910c64'), 'WP-2');
  const git = new FakeGit();
  assert.equal((await verifyLandedCommit({
    ...input(), wpId: 'wp:plan_16910c64:WP-2',
  }, git)).outcome, 'verified');
});

test('refuses duplicate, missing, and conflicting identity trailers only', async () => {
  const cases = [
    message() + '\nPlan: plan_16910c64',
    'subject\n\nWP: WP-2\nVerified: ok',
    message('plan_deadbeef'),
    message() + '\nWP: WP-X',
  ];
  for (const value of cases) {
    const git = new FakeGit();
    git.commits.get(NAMED)!.message = value;
    assert.deepEqual(await verifyLandedCommit(input(), git), { outcome: 'refused', reason: 'labels-mismatch' });
  }
});

test('uses byte-exact Plan and ASCII-only case-insensitive WP identity', async () => {
  const cases = [
    ['plan lookalike', 'plan_16910c6\u0434', 'WP-2'],
    ['wp lookalike', 'plan_16910c64', 'W\u0420-2'],
  ] as const;
  for (const [label, plan, wp] of cases) {
    const git = new FakeGit();
    git.commits.get(NAMED)!.message = message(plan, wp);
    assert.deepEqual(await verifyLandedCommit(input(), git),
      { outcome: 'refused', reason: 'labels-mismatch' }, label);
  }
});

test('returns branch, ancestry, range, named-range, and named-parent refusals', async () => {
  const unresolved = new FakeGit(); unresolved.gateTip = null;
  assert.deepEqual(await verifyLandedCommit(input(), unresolved),
    { outcome: 'refused', reason: 'branch-unresolvable' });
  const diverged = new FakeGit(); diverged.ancestor = false;
  assert.deepEqual(await verifyLandedCommit(input(), diverged),
    { outcome: 'refused', reason: 'dispatch-tip-not-ancestor' });
  const truncated = new FakeGit(); truncated.truncated = true;
  assert.deepEqual(await verifyLandedCommit(input(), truncated),
    { outcome: 'refused', reason: 'range-truncated' });
  const absent = new FakeGit(); absent.range = [POST];
  assert.deepEqual(await verifyLandedCommit(input(), absent),
    { outcome: 'refused', reason: 'named-commit-not-in-range' });
  const merge = new FakeGit(); merge.commits.get(NAMED)!.parentOids = [BASE, OTHER];
  assert.deepEqual(await verifyLandedCommit(input(), merge),
    { outcome: 'refused', reason: 'named-commit-not-single-parent' });
});

test('REACHABILITY:landed-commit-verifier rejects missing and extra named-commit paths', async () => {
  const missing = new FakeGit(); missing.paths.set(NAMED, []);
  assert.deepEqual(await verifyLandedCommit(input(), missing),
    { outcome: 'refused', reason: 'changed-paths-diverge' });
  const extra = new FakeGit(); extra.paths.set(NAMED, [Buffer.from('a.ts'), Buffer.from('extra.ts')]);
  assert.deepEqual(await verifyLandedCommit(input(), extra),
    { outcome: 'refused', reason: 'changed-paths-diverge' });
});

test('records raw prior and post touches, including every merge parent OID', async () => {
  const git = new FakeGit();
  git.range = [POST, NAMED, PRIOR];
  git.commits.get(NAMED)!.parentOids = [PRIOR];
  git.commits.get(POST)!.parentOids = [NAMED, OTHER];
  git.paths.set(POST, [Buffer.from('a.ts'), Buffer.from('post.ts')]);
  const result = await verifyLandedCommit(input(), git);
  assert.equal(result.outcome, 'verified');
  if (result.outcome !== 'verified') return;
  assert.ok(result.evidence);
  assert.deepEqual(result.evidence.priorFrozenPathTouches, [{
    commitOid: PRIOR, parentOids: [BASE], paths: ['a.ts'],
    planTrailers: ['plan_16910c64'], wpTrailers: ['WP-2'],
  }]);
  assert.deepEqual(result.evidence.postClaimTouches, [{
    commitOid: POST, parentOids: [NAMED, OTHER], paths: ['a.ts', 'post.ts'],
    planTrailers: ['plan_16910c64'], wpTrailers: ['WP-2'],
  }]);
  assert.equal(git.calls.filter((call) => call.method === 'readCommit' && call.args[0] === POST).length, 1);
});

test('refuses non-round-trippable named and touch path bytes', async () => {
  const named = new FakeGit(); named.paths.set(NAMED, [Buffer.from([0xff])]);
  assert.deepEqual(await verifyLandedCommit({ ...input(), frozenPaths: ['\ufffd'] }, named),
    { outcome: 'refused', reason: 'unrepresentable-paths' });
  const touch = new FakeGit(); touch.paths.set(POST, [Buffer.from([0xff])]);
  assert.deepEqual(await verifyLandedCommit(input(), touch),
    { outcome: 'refused', reason: 'unrepresentable-paths' });
  const frozen = new FakeGit();
  assert.deepEqual(await verifyLandedCommit({ ...input(), frozenPaths: ['\ud800'] }, frozen),
    { outcome: 'refused', reason: 'unrepresentable-paths' });
});

test('classifies thrown Git separately from an unresolved branch', async () => {
  const git = new FakeGit();
  git.resolveCommit = async () => { throw new Error('git unavailable'); };
  assert.deepEqual(await verifyLandedCommit(input(), git),
    { outcome: 'refused', reason: 'verifier-unavailable' });
});

test('real Git oracle distinguishes a branch ref from a same-named filename', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'landed-verifier-ref-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: root, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'test@lares.local'], { cwd: root, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Lares Test'], { cwd: root, windowsHide: true });
    fs.writeFileSync(path.join(root, 'a.ts'), 'same-named file\n');
    execFileSync('git', ['add', 'a.ts'], { cwd: root, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root, windowsHide: true });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root, encoding: 'utf8', windowsHide: true,
    }).trim();
    const result = await verifyLandedCommit({
      ...input(), branchRef: 'a.ts', dispatchTipOid: base,
    }, createGitOracle(root));
    assert.deepEqual(result, { outcome: 'refused', reason: 'branch-unresolvable' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
