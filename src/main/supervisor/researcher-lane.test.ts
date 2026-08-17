import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentSupervisor,
  getEffectiveWorkspaceRoot,
  RESEARCHER_CODEX_AGENTS_MD_V1,
  RESEARCHER_CODEX_AGENTS_MD_V2,
  RESEARCHER_CODEX_AGENTS_MD_V3_HASH,
  RESEARCHER_CODEX_AGENTS_MD_V4,
  resolveResearcherLaunch,
  resolveResearcherClaudeLaunchDetails,
  resolveResearcherWorkingDirectory,
  researcherScaffoldContent,
  researcherScaffoldPaths,
  sha256Hex,
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

test('Codex researcher scaffold is AGENTS.md-only and states that launch has no enforced tool boundary', () => {
  assert.deepEqual(researcherScaffoldPaths('codex'), ['AGENTS.md']);
  assert.ok(!researcherScaffoldPaths('codex').includes('CLAUDE.md'));
  assert.ok(!researcherScaffoldPaths('codex').includes('.claude/settings.json'));
  const content = researcherScaffoldContent('codex');
  assert.match(content, /workspace researcher/);
  assert.match(content, /\.lares\/research\/inbox/);
  assert.match(content, /Do not edit project code, run builds, run tests/);
  assert.match(content, /instructions, not an enforced tool boundary/);
  assert.match(content, /currently load no tool-restriction hook/);
  assert.match(content, /\.agents\/skills/);
  assert.match(content, /Your cwd is `\.lares\/researcher\/codex\/`, not the workspace/);
  assert.match(content, /use the\s+resulting absolute path for every report write and existence check/);
  assert.notEqual(content, WORKER_CODEX_AGENTS_MD);
});

test('Codex and Agy researcher kits contain only provider config, identity, and portable skills', () => {
  const codex = AgentSupervisor.RESEARCHER_FILES_CODEX;
  const agy = AgentSupervisor.RESEARCHER_FILES_AGY;
  const skills = [
    'write-proposal',
    'read-planning-surface',
    'create-persona',
    'read-comments',
    'research-report',
  ];
  assert.deepEqual(Object.keys(codex).sort(), [
    '.lares/researcher/codex/AGENTS.md',
    '.lares/researcher/codex/.codex/config.toml',
    ...skills.map((name) => `.lares/researcher/codex/.agents/skills/${name}/SKILL.md`),
  ].sort());
  assert.deepEqual(Object.keys(agy).sort(), skills
    .map((name) => `.lares/researcher/agy/.agents/skills/${name}/SKILL.md`)
    .sort());
  for (const kit of [codex, agy]) {
    assert.ok(!Object.keys(kit).some((path) => path.endsWith('settings.json')));
    assert.ok(!Object.keys(kit).some((path) => path.includes('hook')));
    assert.ok(!Object.keys(kit).some((path) => path.includes('research-write-guard')));
  }
  assert.match(researcherScaffoldContent('agy'), /\.agents\/skills/);
});

test('Agy identity remains outside its version-migrated skill map', () => {
  const agy = AgentSupervisor.RESEARCHER_FILES_AGY;
  assert.ok(!Object.keys(agy).some((path) => path.endsWith('/AGENTS.md')));
  assert.equal(Object.keys(agy).length, 5);
  for (const [rel, entry] of Object.entries(agy)) {
    if (rel.endsWith('/research-report/SKILL.md')) {
      assert.equal(entry.version, 1, 'shared research-report skill remains at its unchanged v1 body');
      assert.equal(entry.previousHashes, undefined);
      continue;
    }
    assert.ok(entry.version >= 2, 'Agy portable skills must use their shared migrated versions');
    assert.ok(entry.previousHashes && Object.keys(entry.previousHashes).length > 0);
  }
});

test('Codex AGENTS.md advances to v5 with cumulative hashes for v1 through v4', () => {
  const entry = AgentSupervisor.RESEARCHER_FILES_CODEX['.lares/researcher/codex/AGENTS.md'];
  assert.equal(entry.version, 5);
  assert.deepEqual(entry.previousHashes, {
    1: sha256Hex(RESEARCHER_CODEX_AGENTS_MD_V1),
    2: sha256Hex(RESEARCHER_CODEX_AGENTS_MD_V2),
    3: RESEARCHER_CODEX_AGENTS_MD_V3_HASH,
    4: sha256Hex(RESEARCHER_CODEX_AGENTS_MD_V4),
  });
});

test('portable researcher skill versions match between Codex and Agy', () => {
  for (const name of ['write-proposal', 'read-planning-surface', 'create-persona', 'read-comments', 'research-report']) {
    const codex = AgentSupervisor.RESEARCHER_FILES_CODEX[`.lares/researcher/codex/.agents/skills/${name}/SKILL.md`];
    const agy = AgentSupervisor.RESEARCHER_FILES_AGY[`.lares/researcher/agy/.agents/skills/${name}/SKILL.md`];
    assert.equal(agy.version, codex.version);
    assert.deepEqual(agy.previousHashes, codex.previousHashes);
    assert.equal(agy.content, codex.content);
  }
});
