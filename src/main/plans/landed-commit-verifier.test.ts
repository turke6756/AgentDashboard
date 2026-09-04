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

const OID = (char: string) => char.repeat(40);
const BASE = OID('a');
const ONE = OID('1');
const TWO = OID('2');
const OTHER = OID('3');

function message(plan = 'plan_16910c64', wp = 'WP-2', extra = ''): string {
  return `subject\n\nPlan: ${plan}\nWP: ${wp}\nVerified: tests => PASS (1 passed)${extra}`;
}

class FakeGit implements LandedCommitGitOracle {
  gateTip: string | null = TWO;
  ancestor = true;
  range = [ONE];
  truncated = false;
  commits = new Map<string, GitCommitView>([
    [ONE, { oid: ONE, subject: 'one', message: message(), parentOids: [BASE] }],
    [TWO, { oid: TWO, subject: 'two', message: message(), parentOids: [ONE] }],
  ]);
  paths = new Map<string, Buffer[]>([[ONE, [Buffer.from('a.ts')]], [TWO, [Buffer.from('a.ts')]]]);
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
  async readCommit(_repositoryKey: string, oid: string) { return this.commits.get(oid)!; }
  async interpretTrailers(_repositoryKey: string, value: string) {
    return value.replace(/\r\n/g, '\n').trimEnd().split(/\n\n+/).at(-1)!.split('\n').map((line) => {
      const index = line.indexOf(':');
      return { key: line.slice(0, index), value: line.slice(index + 1).trimStart() };
    });
  }
  async changedPaths(_repositoryKey: string, _parent: string, oid: string) { return this.paths.get(oid)!; }
}

const input = (commitOid = ONE) => ({
  repositoryKey: 'repo', branchRef: 'refs/heads/master', dispatchTipOid: BASE,
  frozenPaths: ['a.ts'], planArtifactId: 'plan_16910c64', wpId: 'WP-2', commitOid,
});

test('verifies the sole canonical first-parent match and parses audit trailers', async () => {
  const git = new FakeGit();
  git.commits.get(ONE)!.message = message(undefined, undefined, '\nScope-omitted: none');
  assert.deepEqual(await verifyLandedCommit(input(), git), {
    outcome: 'verified', commitOid: ONE, subject: 'one', parentOid: BASE,
    verifiedTrailer: 'tests => PASS (1 passed)', scopeOmittedTrailer: 'none',
  });
  assert.equal(git.calls.find((call) => call.method === 'listFirstParentRange')!.args[2], undefined,
    'gate verification walks the complete range without a cap');
});

test('matches WP trailer identity using ingest case folding and still rejects a different id', async () => {
  const lowerTrailer = new FakeGit();
  lowerTrailer.commits.get(ONE)!.message = message(undefined, 'wp-2');
  assert.equal((await verifyLandedCommit(input(), lowerTrailer)).outcome, 'verified');

  const upperTrailer = new FakeGit();
  assert.equal((await verifyLandedCommit({ ...input(), wpId: 'wp-2' }, upperTrailer)).outcome, 'verified');

  const different = new FakeGit();
  assert.deepEqual(await verifyLandedCommit({ ...input(), wpId: 'WP-3' }, different),
    { outcome: 'refused', reason: 'no-matching-commit' });
});

test('injected oracle distinguishes the branch ref from a same-named filename', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'landed-verifier-ref-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: root, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'test@lares.local'], { cwd: root, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Lares Test'], { cwd: root, windowsHide: true });
    fs.writeFileSync(path.join(root, 'a.ts'), 'same-named file\n');
    execFileSync('git', ['add', 'a.ts'], { cwd: root, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root, windowsHide: true });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
    const result = await verifyLandedCommit({ ...input(), branchRef: 'a.ts', dispatchTipOid: base }, createGitOracle(root));
    assert.deepEqual(result, { outcome: 'refused', reason: 'branch-unresolvable' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('returns branch and ancestry refusals without consulting later oracle stages', async () => {
  const unresolved = new FakeGit(); unresolved.gateTip = null;
  assert.deepEqual(await verifyLandedCommit(input(), unresolved), { outcome: 'refused', reason: 'branch-unresolvable' });
  assert.equal(unresolved.calls.length, 1);
  const diverged = new FakeGit(); diverged.ancestor = false;
  assert.deepEqual(await verifyLandedCommit(input(), diverged), { outcome: 'refused', reason: 'dispatch-tip-not-ancestor' });
  assert.equal(diverged.calls.some((call) => call.method === 'listFirstParentRange'), false);
});

test('zero and multiple claims are distinct typed refusals', async () => {
  const zero = new FakeGit(); zero.range = [];
  assert.deepEqual(await verifyLandedCommit(input(), zero), { outcome: 'refused', reason: 'no-matching-commit' });
  const many = new FakeGit(); many.range = [ONE, TWO];
  assert.deepEqual(await verifyLandedCommit(input(), many), { outcome: 'refused', reason: 'multiple-matching-commits' },
    'REACHABILITY:wp2-verifier-exactly-one');
});

test('requires the supplied full commit to be the sole match', async () => {
  assert.deepEqual(await verifyLandedCommit(input(OTHER), new FakeGit()),
    { outcome: 'refused', reason: 'commit-oid-not-the-match' });
});

test('NUL-safe changed path equality rejects both missing and extra paths', async () => {
  const missing = new FakeGit(); missing.paths.set(ONE, []);
  assert.deepEqual(await verifyLandedCommit(input(), missing), { outcome: 'refused', reason: 'changed-paths-diverge' });
  const extra = new FakeGit(); extra.paths.set(ONE, [Buffer.from('a.ts'), Buffer.from('extra.ts')]);
  assert.deepEqual(await verifyLandedCommit(input(), extra), { outcome: 'refused', reason: 'changed-paths-diverge' });
});

test('rejects duplicate, folded, alternate-case, unknown and merge-commit trailer claims', async () => {
  const badMessages = [
    message() + '\nWP: WP-2',
    `Plan: plan_16910c64 in prose\n\n${message()}`,
    message() + '\n continuation',
    message().replace('Plan:', 'plan:'),
    message() + '\nUnknown: value',
  ];
  for (const bad of badMessages) {
    const git = new FakeGit(); git.commits.get(ONE)!.message = bad;
    assert.deepEqual(await verifyLandedCommit(input(), git), { outcome: 'refused', reason: 'no-matching-commit' });
  }
  const merge = new FakeGit(); merge.commits.get(ONE)!.parentOids = [BASE, OTHER];
  assert.deepEqual(await verifyLandedCommit(input(), merge), { outcome: 'refused', reason: 'no-matching-commit' });
});

test('rejects a second separated trailer-looking paragraph', async () => {
  const git = new FakeGit();
  git.commits.get(ONE)!.message = `subject\n\nOther: first-block\n\nPlan: plan_16910c64\nWP: WP-2\nVerified: tests => PASS (1 passed)`;
  assert.deepEqual(await verifyLandedCommit(input(), git),
    { outcome: 'refused', reason: 'no-matching-commit' });
});

test('REACHABILITY:wpf1-plan-prefix-forgery rejects Plan forgeries and non-case WP identity changes', async () => {
  const lookalike = 'plan_16910c6\u0434';
  const cases = [
    ['different plan', 'plan_deadbeef', 'WP-2'],
    ['plan prefix', 'plan_16910c64-forged', 'WP-2'],
    ['plan suffix', 'forged-plan_16910c64', 'WP-2'],
    ['plan whitespace', ' plan_16910c64', 'WP-2'],
    ['plan lookalike', lookalike, 'WP-2'],
    ['different wp', 'plan_16910c64', 'WP-X'],
    ['wp prefix', 'plan_16910c64', 'WP-2-forged'],
    ['wp suffix', 'plan_16910c64', 'forged-WP-2'],
    ['wp whitespace', 'plan_16910c64', ' WP-2'],
    ['wp lookalike', 'plan_16910c64', 'W\u0420-2'],
  ] as const;
  for (const [label, plan, wp] of cases) {
    const git = new FakeGit();
    git.commits.get(ONE)!.message = message(plan, wp);
    assert.deepEqual(await verifyLandedCommit(input(), git),
      { outcome: 'refused', reason: 'no-matching-commit' }, label);
  }
});
