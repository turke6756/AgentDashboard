import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { describe, test } from 'node:test';
import type { AgentRoleLane } from '../../shared/types';
import { resolveResearcherSandboxHome } from './researcher-home-factory';

const STATE_ROOT = path.resolve('C:\\fixture\\workspace\\.lares');

describe('resolveResearcherSandboxHome', () => {
  test('derivation is stable for the same workspace state root and agent id', () => {
    const input = {
      roleLane: 'researcher' as const,
      workspaceStateRoot: STATE_ROOT,
      agentId: 'agent-111',
      provider: 'claude' as const,
    };

    const first = resolveResearcherSandboxHome(input);
    const second = resolveResearcherSandboxHome(input);

    assert.deepStrictEqual(first, second);
    assert.equal(
      first?.researcherSandboxHomePath,
      path.join(STATE_ROOT, 'agent-homes', 'agent-111'),
    );
  });

  test('derived homes stay outside the untrusted research store', () => {
    const resolved = resolveResearcherSandboxHome({
      roleLane: 'researcher', workspaceStateRoot: STATE_ROOT, agentId: 'agent-tier', provider: 'claude',
    });
    assert.ok(resolved);
    const researchStore = path.join(STATE_ROOT, 'research');
    const relativeToResearch = path.relative(researchStore, resolved.researcherSandboxHomePath);
    assert.ok(
      relativeToResearch === '..' || relativeToResearch.startsWith(`..${path.sep}`),
      `sandbox home must not be nested in the research store: ${resolved.researcherSandboxHomePath}`,
    );
  });

  test('WSL state roots derive a POSIX home without host-path reinterpretation', () => {
    const resolved = resolveResearcherSandboxHome({
      roleLane: 'researcher',
      workspaceStateRoot: '/home/alice/workspace/.lares',
      agentId: 'agent-wsl',
      provider: 'claude',
    });
    assert.equal(resolved?.researcherSandboxHomePath, '/home/alice/workspace/.lares/agent-homes/agent-wsl');
  });

  test('agent id, not a shared working-directory slug, gives each researcher a distinct home', () => {
    const first = resolveResearcherSandboxHome({
      roleLane: 'researcher', workspaceStateRoot: STATE_ROOT, agentId: 'agent-a', provider: 'claude',
    });
    const second = resolveResearcherSandboxHome({
      roleLane: 'researcher', workspaceStateRoot: STATE_ROOT, agentId: 'agent-b', provider: 'claude',
    });

    assert.notEqual(first?.researcherSandboxHomePath, second?.researcherSandboxHomePath);
  });

  test('a Claude researcher receives matching launch and discovery locations', () => {
    const resolved = resolveResearcherSandboxHome({
      roleLane: 'researcher', workspaceStateRoot: STATE_ROOT, agentId: 'agent-222', provider: 'claude',
    });
    assert.ok(resolved);
    assert.deepStrictEqual(resolved.launchRedirect, {
      kind: 'env',
      name: 'CLAUDE_CONFIG_DIR',
      value: resolved.researcherSandboxHomePath,
    });
    assert.deepStrictEqual(resolved.discoveryLocation, {
      providerStateRoot: resolved.researcherSandboxHomePath,
      resolver: {
        kind: 'cwd-slug-jsonl',
        pathPattern: 'projects/<cwd-slug>/<session-uuid>.jsonl',
        cwdEncoding: 'path-separators-and-colon-to-dash',
      },
    });
  });

  test('every non-researcher lane receives neither a home nor a redirect', () => {
    for (const roleLane of ['legacy', 'worker', 'supervisor'] satisfies AgentRoleLane[]) {
      assert.equal(resolveResearcherSandboxHome({
        roleLane,
        workspaceStateRoot: STATE_ROOT,
        agentId: `agent-${roleLane}`,
        provider: 'claude',
      }), null, `${roleLane} must not receive researcher sandbox construction`);
    }
  });

  test('inactive provider adapters cannot produce a researcher launch redirect', () => {
    for (const provider of ['codex', 'grok', 'agy'] as const) {
      assert.throws(
        () => resolveResearcherSandboxHome({
          roleLane: 'researcher', workspaceStateRoot: STATE_ROOT, agentId: 'agent-333', provider,
        }),
        new RegExp(`provider '${provider}' is not-yet-activated`),
      );
    }
  });
});

describe('production researcher launch entry', () => {
  const supervisorSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'supervisor', 'index.ts'),
    'utf8',
  );

  test('all three researcher launch construction sites call the guarded factory', () => {
    assert.equal(
      supervisorSource.match(/resolveResearcherSandboxHome\(\{/g)?.length,
      3,
      'REACHABILITY:researcher-home-factory Windows, WSL, and fork launches must each enter the factory',
    );
  });

  test('the Windows researcher branch calls the guarded factory', () => {
    assert.match(
      supervisorSource,
      /if \(roleLaneOf\(agent\) === 'researcher'\) \{[\s\S]*?if \(!overrideArgs\) \{[\s\S]*?resolveResearcherSandboxHome\(\{[\s\S]*?roleLane: roleLaneOf\(agent\)[\s\S]*?prepareRestrictedOutboxLaunch/,
      'REACHABILITY:researcher-home-factory production researcher launch must call the guarded factory',
    );
  });

  test('the WSL researcher branch calls and consumes the guarded factory', () => {
    assert.match(
      supervisorSource,
      /else if \(agent\.isResearcher && isClaude && !overrideCommand\) \{[\s\S]*?resolveResearcherSandboxHome\(\{[\s\S]*?workspaceStateRoot: workspaceStateDir\(persistentWorkspaceRoot, 'wsl'\)[\s\S]*?wslResearcherSandbox\.researcherSandboxHomePath/,
      'REACHABILITY:researcher-home-wsl production WSL researcher launch must consume the derived home path',
    );
  });

  test('the fork path explicitly calls and consumes the guarded factory', () => {
    assert.match(
      supervisorSource,
      /const forkResearcher = forkLane === 'researcher';[\s\S]*?if \(forkResearcher\) \{[\s\S]*?resolveResearcherSandboxHome\(\{[\s\S]*?roleLane: forkLane[\s\S]*?forkResearcherSandbox\.researcherSandboxHomePath/,
      'REACHABILITY:researcher-home-fork forked researchers must enter and consume the factory result',
    );
  });
});
