import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getEffectiveWorkspaceRoot,
  resolveResearcherLaunch,
  resolveResearcherClaudeLaunchDetails,
  resolveResearcherWorkingDirectory,
  researcherScaffoldContent,
  researcherScaffoldPaths,
} from './index';
import { WORKER_CODEX_AGENTS_MD } from '../../shared/constants';

test('researcher launch accepts codex and preserves provider-specific Claude gating', () => {
  let failure: unknown;
  try { resolveResearcherLaunch('codex'); } catch (error) { failure = error; }
  assert.equal(failure, undefined, 'REACHABILITY:researcher-provider-generalized');
  assert.deepEqual(resolveResearcherLaunch('codex'), { provider: 'codex', isClaude: false });
  assert.deepEqual(resolveResearcherLaunch('claude'), { provider: 'claude', isClaude: true });
});

test('researcher cwd is provider-specific on Windows and WSL', () => {
  assert.equal(
    resolveResearcherWorkingDirectory('C:\\workspace', '.lares', 'claude', 'windows'),
    'C:\\workspace\\.lares\\researcher\\claude',
    'Claude researcher cwd must move to the concrete per-provider path',
  );
  assert.equal(
    resolveResearcherWorkingDirectory('C:\\workspace', '.lares', 'codex', 'windows'),
    'C:\\workspace\\.lares\\researcher\\codex', 'REACHABILITY:researcher-cwd-per-provider',
  );
  assert.equal(
    resolveResearcherWorkingDirectory('/workspace', '.lares', 'claude', 'wsl'),
    '/workspace/.lares/researcher/claude', 'REACHABILITY:researcher-cwd-per-provider',
  );
});

test('Claude researchers retain the complete native launch surface', () => {
  const details = resolveResearcherClaudeLaunchDetails();
  assert.equal(details.browserFlag, '--chrome');
  assert.deepEqual(details.nativeArgs.slice(0, 2), ['--tools', details.nativeArgs[1]]);
  assert.ok(details.nativeArgs[1].includes('WebSearch'));
  assert.deepEqual(details.nativeArgs.slice(2, 4), ['--disallowedTools', details.nativeArgs[3]]);
  assert.ok(details.nativeArgs[3].includes('Bash'));
  assert.deepEqual(details.nativeArgs.slice(4), ['--model', 'claude-sonnet-4-6']);
});

test('new Claude researcher sessions classify to their workspace', () => {
  assert.equal(getEffectiveWorkspaceRoot({
    workingDirectory: 'C:\\workspace\\.lares\\researcher\\claude',
  } as never), 'C:\\workspace');
});

test('Codex researcher scaffold is AGENTS.md-only', () => {
  assert.deepEqual(researcherScaffoldPaths('codex'), ['AGENTS.md']);
  assert.ok(!researcherScaffoldPaths('codex').includes('CLAUDE.md'));
  assert.ok(!researcherScaffoldPaths('codex').includes('.claude/settings.json'));
  const content = researcherScaffoldContent('codex');
  assert.match(content, /workspace researcher/);
  assert.match(content, /\.lares\/research\/inbox/);
  assert.doesNotMatch(content, /edit project code|run builds|run tests/);
  assert.notEqual(content, WORKER_CODEX_AGENTS_MD);
});
