import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { after, before, describe, test } from 'node:test';
import { resolveResearcherSandboxHome } from './researcher-home-factory';
import {
  prepareResearcherSandboxHome,
  purgeResearcherSandboxHome,
} from './researcher-home-lifecycle';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-researcher-lifecycle-'));
const workspaceStateRoot = path.join(fixtureRoot, 'workspace', '.lares');
const trustedClaudeRoot = path.join(fixtureRoot, 'account', '.claude');
const accountTemp = path.join(fixtureRoot, 'account-temp');
const trustedCredential = '{"oauthAccount":"trusted-account"}\n';

before(() => {
  fs.mkdirSync(trustedClaudeRoot, { recursive: true });
  fs.writeFileSync(path.join(trustedClaudeRoot, '.credentials.json'), trustedCredential);
});

after(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function resolveFixtureHome(agentId = 'researcher-1') {
  const sandboxHome = resolveResearcherSandboxHome({
    roleLane: 'researcher',
    workspaceStateRoot,
    agentId,
    provider: 'claude',
  });
  assert.ok(sandboxHome);
  return sandboxHome;
}

describe('prepareResearcherSandboxHome', () => {
  test('injects redirect, temp, and per-agent spool only through extraEnv', () => {
    const sandboxHome = resolveFixtureHome('extra-env');
    const prepared = prepareResearcherSandboxHome({
      provider: 'claude',
      sandboxHome,
      trustedProviderStateRoot: trustedClaudeRoot,
      accountTempPath: accountTemp,
    });

    assert.deepStrictEqual(prepared.extraEnv, {
      CLAUDE_CONFIG_DIR: sandboxHome.researcherSandboxHomePath,
      TMP: path.join(sandboxHome.researcherSandboxHomePath, 'tmp'),
      TEMP: path.join(sandboxHome.researcherSandboxHomePath, 'tmp'),
      DASHBOARD_SPOOL_PATH: path.join(
        sandboxHome.researcherSandboxHomePath,
        'spool',
        'pending-status.jsonl',
      ),
    });
    assert.equal('env' in prepared, false, 'discarded options.env must not be an output surface');
    assert.equal(fs.readdirSync(prepared.filesystemHomePath).includes('tmp'), true);
  });

  test('second launch preserves declared session history and removes planted executable/config trees', () => {
    const sandboxHome = resolveFixtureHome('reset');
    const input = {
      provider: 'claude' as const,
      sandboxHome,
      trustedProviderStateRoot: trustedClaudeRoot,
      accountTempPath: accountTemp,
    };
    const first = prepareResearcherSandboxHome(input);
    const transcript = path.join(first.filesystemHomePath, 'projects', 'cwd-slug', 'session.jsonl');
    const spool = first.spoolPath;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{"type":"assistant","message":"durable"}\n');
    fs.mkdirSync(path.dirname(spool), { recursive: true });
    fs.writeFileSync(spool, '{"event":"Stop"}\n');

    // Real provider executable/config surfaces, not imagined one-off names.
    const planted = [
      path.join(first.filesystemHomePath, 'plugins', 'marketplaces', 'evil', 'plugin.json'),
      path.join(first.filesystemHomePath, 'skills', 'evil', 'SKILL.md'),
      path.join(first.filesystemHomePath, 'hooks', 'on-launch.js'),
      path.join(first.filesystemHomePath, 'rules', 'persist.md'),
      path.join(first.filesystemHomePath, 'cache', 'helper.exe'),
      path.join(first.filesystemHomePath, 'tmp', 'stale-helper.exe'),
      path.join(first.filesystemHomePath, '.claude.json'),
    ];
    for (const plantedPath of planted) {
      fs.mkdirSync(path.dirname(plantedPath), { recursive: true });
      fs.writeFileSync(plantedPath, 'planted');
    }
    fs.writeFileSync(path.join(first.filesystemHomePath, '.credentials.json'), 'attacker-auth');

    const second = prepareResearcherSandboxHome(input);

    assert.equal(fs.readFileSync(transcript, 'utf8'), '{"type":"assistant","message":"durable"}\n');
    assert.equal(fs.readFileSync(spool, 'utf8'), '{"event":"Stop"}\n');
    for (const plantedPath of planted) {
      assert.equal(fs.existsSync(plantedPath), false, `planted path survived relaunch: ${plantedPath}`);
    }
    assert.deepStrictEqual(fs.readdirSync(second.tmpPath), [], 'tmp must be empty on every launch');
    assert.equal(
      fs.readFileSync(path.join(second.filesystemHomePath, '.credentials.json'), 'utf8'),
      trustedCredential,
      'auth must be freshly replaced from the trusted account source',
    );
  });

  test('rejects a sandbox home inside the account temp directory', () => {
    const sandboxHome = resolveResearcherSandboxHome({
      roleLane: 'researcher',
      workspaceStateRoot: path.join(accountTemp, '.lares'),
      agentId: 'temp-nested',
      provider: 'claude',
    });
    assert.ok(sandboxHome);
    assert.throws(
      () => prepareResearcherSandboxHome({
        provider: 'claude',
        sandboxHome,
        trustedProviderStateRoot: trustedClaudeRoot,
        accountTempPath: accountTemp,
      }),
      /must stay outside the account temp directory/,
    );
  });

  test('explicit purge removes the persistent per-agent home', () => {
    const sandboxHome = resolveFixtureHome('purge');
    const prepared = prepareResearcherSandboxHome({
      provider: 'claude',
      sandboxHome,
      trustedProviderStateRoot: trustedClaudeRoot,
      accountTempPath: accountTemp,
    });
    fs.writeFileSync(path.join(prepared.filesystemHomePath, 'operator-marker.txt'), 'present');

    purgeResearcherSandboxHome(prepared.filesystemHomePath);

    assert.equal(fs.existsSync(prepared.filesystemHomePath), false);
  });
});

describe('production researcher lifecycle entry', () => {
  const supervisorSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'supervisor', 'index.ts'),
    'utf8',
  );

  test('Windows, WSL, and fork launch paths enter the lifecycle seam', () => {
    assert.equal(
      supervisorSource.match(/prepareResearcherSandboxHome\(\{/g)?.length,
      3,
      'REACHABILITY:wp3-lifecycle-entry all three production construction paths must prepare the home',
    );
  });

  test('WSL and fork launch paths consume the prepared extraEnv payload', () => {
    assert.match(
      supervisorSource,
      /const preparedResearcherHome = prepareResearcherSandboxHome\(\{[\s\S]*?Object\.entries\(preparedResearcherHome\.extraEnv\)[\s\S]*?wslEnvPrefix\.push\([\s\S]*?command = `\$\{wslEnvPrefix\.join\(' '\)\} \$\{command\}`/,
      'REACHABILITY:wp3-wsl-extra-env WSL must encode the prepared payload in its bootstrap prefix',
    );
    assert.match(
      supervisorSource,
      /forkPreparedResearcherHome = prepareResearcherSandboxHome\(\{[\s\S]*?launchWindowsAgent\([\s\S]*?forkPreparedResearcherHome\)[\s\S]*?Object\.entries\(forkPreparedResearcherHome\.extraEnv\)/,
      'REACHABILITY:wp3-fork-extra-env both fork transports must consume the prepared payload',
    );
  });

  test('researcher launch has exactly one DASHBOARD_SPOOL_PATH writer: the lifecycle payload', () => {
    const sandboxHome = resolveResearcherSandboxHome({
      roleLane: 'researcher',
      workspaceStateRoot: '/home/u/proj/.lares',
      agentId: 'researcher-wsl',
      provider: 'claude',
    });
    assert.ok(sandboxHome);
    const filesystemHomePath = path.join(fixtureRoot, 'wsl-filesystem-home');
    const prepared = prepareResearcherSandboxHome({
      provider: 'claude',
      sandboxHome,
      filesystemHomePath,
      trustedProviderStateRoot: trustedClaudeRoot,
      accountTempPath: '/tmp',
    });
    assert.equal(
      prepared.extraEnv.DASHBOARD_SPOOL_PATH,
      '/home/u/proj/.lares/agent-homes/researcher-wsl/spool/pending-status.jsonl',
      'the hook runs inside WSL and must receive its logical POSIX path',
    );
    assert.equal(prepared.filesystemHomePath, path.resolve(filesystemHomePath));
    assert.notEqual(prepared.extraEnv.DASHBOARD_SPOOL_PATH, prepared.filesystemHomePath);

    const windowsStart = supervisorSource.indexOf('private async launchWindowsAgent');
    const wslStart = supervisorSource.indexOf('private async launchWslAgent', windowsStart);
    const windowsLaunch = supervisorSource.slice(windowsStart, wslStart);
    const wslLaunch = supervisorSource.slice(wslStart, supervisorSource.indexOf('private async', wslStart + 1));

    assert.match(
      windowsLaunch,
      /if \(roleLaneOf\(agent\) !== 'researcher'\) \{\s*extraEnv\.DASHBOARD_SPOOL_PATH =/,
      'the workspace-spool writer must explicitly exclude Windows researcher launches',
    );
    assert.match(
      wslLaunch,
      /if \(roleLaneOf\(agent\) !== 'researcher'\) \{[\s\S]*?wslEnvPrefix\.push\(\s*`DASHBOARD_SPOOL_PATH=/,
      'the workspace-spool writer must explicitly exclude WSL researcher launches',
    );
    assert.equal(
      supervisorSource.match(/preparedResearcherHome\.extraEnv/g)?.length,
      2,
      'Windows and WSL launches must each consume the single lifecycle-owned researcher payload',
    );
  });

  test('agent-row deletion enters the sandbox-home purge seam', () => {
    assert.match(
      supervisorSource,
      /async deleteAgent\(agentId: string\)[\s\S]*?purgeResearcherSandboxHome\(/,
      'REACHABILITY:wp3-agent-delete-purge deleting the row must purge its derived home',
    );
  });

  test('main runner registers this suite before the known fail-fast boundary', () => {
    const runnerSource = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'run-main-tests.mjs'),
      'utf8',
    );
    const lifecycle = runnerSource.indexOf('dist/main/main/sandbox/researcher-home-lifecycle.test.js');
    const boundary = runnerSource.indexOf('dist/main/main/commit-candidates/finalization-service.test.js');
    assert.ok(lifecycle >= 0, 'lifecycle suite must be registered');
    assert.ok(boundary >= 0, 'known fail-fast boundary must remain registered');
    assert.ok(lifecycle < boundary, 'lifecycle suite must run before the known fail-fast boundary');
  });
});
