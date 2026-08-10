import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RunGitOptions } from '../git-checkpoints/git-command';
import {
  discoverFirstContactRoots,
  recordOnboardingDecision,
  type OnboardingRunGitBytes,
} from './onboarding-discovery';
import { ScratchPolicyStore } from './scratch-policy-store';

function fixture(): { root: string; store: ScratchPolicyStore; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-onboarding-'));
  return {
    root,
    store: new ScratchPolicyStore(path.join(root, 'app-policy')),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function status(...records: string[]): Buffer {
  return Buffer.from(`${records.join('\0')}\0`, 'utf8');
}

function fakeGit(
  initial: Buffer,
  scoped: Record<string, Buffer>,
  calls: string[][] = [],
): OnboardingRunGitBytes {
  return async (_cwd: string, args: string[], _options: RunGitOptions) => {
    calls.push(args);
    const all = args.includes('--untracked-files=all');
    const pathspec = args.at(-1) === '--' ? undefined : args.at(-1);
    return { code: 0, stdout: all && pathspec ? scoped[pathspec] ?? Buffer.alloc(0) : initial, stderr: '' };
  };
}

test('discovers only Git-collapsed recognized roots and completes scoped counts exactly', async () => {
  const f = fixture();
  try {
    const calls: string[][] = [];
    const result = await discoverFirstContactRoots({
      repoRoot: f.root,
      repositoryKey: 'repo',
      workspaceKey: 'workspace',
      policyStore: f.store,
      runGitBytes: fakeGit(
        status('? node_modules/', '? source/', '1 .M N... 100644 100644 100644 a a src/app.ts'),
        {
          'node_modules/': status('? node_modules/a.js', '? node_modules/b.js'),
        },
        calls,
      ),
    });

    assert.deepEqual(
      result.recommendations.map((item) => item.displayPath),
      ['node_modules/'],
      'REACHABILITY:onboarding-discovery',
    );
    assert.equal(result.recommendations[0].countLabel, '2');
    assert.equal(result.recommendations[0].countExact, true);
    assert.equal(result.presentation, 'first-contact');
    assert.equal(result.totalsExact, true);
    assert.deepEqual(calls[0], [
      '--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=normal', '--',
    ]);
    assert.ok(calls[1].includes('--untracked-files=all'));
    assert.equal(calls[1].at(-1), 'node_modules/');
    assert.equal(calls.some((args) => args[0] !== '--no-optional-locks'), false);
  } finally {
    f.cleanup();
  }
});

test('a scoped budget trip reports a lower bound and an established fingerprint changes presentation', async () => {
  const f = fixture();
  try {
    const runGitBytes = fakeGit(
      status('? node_modules/'),
      { 'node_modules/': status('? node_modules/a', '? node_modules/b', '? node_modules/c') },
    );
    const first = await discoverFirstContactRoots({
      repoRoot: f.root, repositoryKey: 'repo', workspaceKey: 'workspace', policyStore: f.store,
      runGitBytes, budgets: { maxEntries: 3 },
    });
    assert.equal(first.completeness, 'partial');
    assert.deepEqual(first.observedStopReasons, ['entries']);
    assert.equal(first.recommendations[0].countExact, false);
    assert.equal(first.recommendations[0].countLabel, '>=3');

    recordOnboardingDecision(f.store, first, 'keep-everything');
    const repeated = await discoverFirstContactRoots({
      repoRoot: f.root, repositoryKey: 'repo', workspaceKey: 'workspace', policyStore: f.store,
      runGitBytes, budgets: { maxEntries: 3 },
    });
    assert.equal(repeated.presentation, 'established');
  } finally {
    f.cleanup();
  }
});

test('exclude-selected merges repository policy and persists generation/schema only for applicable prompts', async () => {
  const f = fixture();
  try {
    f.store.setExclusions('repo', [Buffer.from('existing/')]);
    const discovery = await discoverFirstContactRoots({
      repoRoot: f.root, repositoryKey: 'repo', workspaceKey: 'workspace', policyStore: f.store,
      runGitBytes: fakeGit(status('? node_modules/'), { 'node_modules/': status('? node_modules/a') }),
    });
    const selected = discovery.recommendations[0].pathBytesBase64;
    const saved = recordOnboardingDecision(f.store, discovery, 'exclude-selected', [selected, 'not-discovered']);
    assert.deepEqual(
      saved.exclusions.map((item) => Buffer.from(item.value, 'base64').toString()).sort(),
      ['existing/', 'node_modules/'],
    );
    assert.equal(saved.policyGeneration, 2);
    assert.deepEqual(saved.onboardingProjections[0], {
      workspaceKey: 'workspace',
      decision: 'exclude-selected',
      policyGeneration: 2,
      schemaVersion: 1,
      recommendationFingerprint: discovery.recommendationFingerprint,
    });

    assert.throws(() => recordOnboardingDecision(f.store, {
      ...discovery, presentation: null, recommendations: [], recommendationFingerprint: null,
    }, 'keep-everything'), /not applicable/);
  } finally {
    f.cleanup();
  }
});

test('materially changed recommendations re-offer after keep-everything without generation-only nagging', async () => {
  const f = fixture();
  try {
    const first = await discoverFirstContactRoots({
      repoRoot: f.root, repositoryKey: 'repo', workspaceKey: 'workspace', policyStore: f.store,
      runGitBytes: fakeGit(status('? node_modules/'), { 'node_modules/': status('? node_modules/a') }),
    });
    recordOnboardingDecision(f.store, first, 'keep-everything');
    f.store.setExclusions('repo', [Buffer.from('other/')]);
    const unchanged = await discoverFirstContactRoots({
      repoRoot: f.root, repositoryKey: 'repo', workspaceKey: 'workspace', policyStore: f.store,
      runGitBytes: fakeGit(status('? node_modules/'), { 'node_modules/': status('? node_modules/a') }),
    });
    assert.equal(unchanged.presentation, 'established');

    const changed = await discoverFirstContactRoots({
      repoRoot: f.root, repositoryKey: 'repo', workspaceKey: 'workspace', policyStore: f.store,
      runGitBytes: fakeGit(
        status('? node_modules/', '? .venv/'),
        { 'node_modules/': status('? node_modules/a'), '.venv/': status('? .venv/python') },
      ),
    });
    assert.equal(changed.presentation, 'first-contact');
  } finally {
    f.cleanup();
  }
});

test('production composition shares policy generation and invalidates checkpoint, finalization, and policy writes', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');
  assert.match(source, /new ScratchPolicyStore\(/, 'production must construct the app-owned policy store');
  assert.match(source, /resolvePolicyGeneration,/, 'both route constructors must receive live policy generation');
  assert.match(source, /engine\.coordinator\.onTurnClosed/, 'checkpoint closure must enter invalidation wiring');
  assert.match(source, /onPolicyWrite: \(repositoryKey\) => snapshotRegistry\.invalidate\(repositoryKey\)/);
  assert.match(source, /onRepositoryFinalized: \(repositoryKey\) => snapshotRegistry\.invalidate\(repositoryKey\)/);
});
