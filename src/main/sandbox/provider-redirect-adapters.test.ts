import assert from 'assert';
import { describe, test } from 'node:test';
import {
  PROVIDER_REDIRECT_ADAPTERS,
  resolveProviderRedirectAdapter,
} from './provider-redirect-adapters';

describe('provider redirect adapter facts', () => {
  test('Claude and Codex are active, with Claude retaining its named acceptance gate', () => {
    assert.deepStrictEqual(PROVIDER_REDIRECT_ADAPTERS.claude, {
      provider: 'claude',
      redirect: { kind: 'env', name: 'CLAUDE_CONFIG_DIR' },
      auth: {
        kind: 'redirected-home-files',
        emptyHomeDeauthenticates: true,
        seeds: [
          { path: '.credentials.json', strategy: 'copy-trusted' },
          { path: '.claude.json', strategy: 'generate-sanitized' },
        ],
      },
      durableSessionPaths: ['projects/**', 'sessions/**'],
      resetPaths: ['**/*'],
      discovery: {
        kind: 'cwd-slug-jsonl',
        pathPattern: 'projects/<cwd-slug>/<session-uuid>.jsonl',
        cwdEncoding: 'path-separators-and-colon-to-dash',
      },
      support: {
        implementation: 'active',
        verdict: 'degraded',
        gate: 'sanitized-minimal-claude-config-and-resume',
      },
    });

    assert.deepStrictEqual(
      Object.values(PROVIDER_REDIRECT_ADAPTERS)
        .filter((adapter) => adapter.support.implementation === 'active')
        .map((adapter) => adapter.provider),
      ['claude', 'codex'],
    );
  });

  test('Codex and Grok preserve their probed env, auth, and discovery facts as inactive stubs', () => {
    assert.deepStrictEqual(PROVIDER_REDIRECT_ADAPTERS.codex.redirect, { kind: 'env', name: 'CODEX_HOME' });
    assert.deepStrictEqual(PROVIDER_REDIRECT_ADAPTERS.codex.auth, {
      kind: 'redirected-home-files',
      emptyHomeDeauthenticates: true,
      seeds: [{ path: 'auth.json', strategy: 'copy-trusted' }],
    });
    assert.deepStrictEqual(PROVIDER_REDIRECT_ADAPTERS.codex.discovery, {
      kind: 'dated-rollout-jsonl',
      pathPattern: 'sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl',
    });
    assert.deepStrictEqual(PROVIDER_REDIRECT_ADAPTERS.codex.durableSessionPaths, ['sessions/**']);
    assert.deepStrictEqual(PROVIDER_REDIRECT_ADAPTERS.grok.redirect, { kind: 'env', name: 'GROK_HOME' });
    assert.deepStrictEqual(PROVIDER_REDIRECT_ADAPTERS.grok.auth, {
      kind: 'redirected-home-file-or-env',
      emptyHomeDeauthenticates: true,
      file: 'auth.json',
      env: 'XAI_API_KEY',
      preferred: 'env',
    });
    assert.deepStrictEqual(PROVIDER_REDIRECT_ADAPTERS.grok.discovery, {
      kind: 'url-encoded-cwd-session-directory',
      pathPattern: 'sessions/<urlencoded-cwd>/<session-uuid>/chat_history.jsonl',
      companionPath: 'sessions/<urlencoded-cwd>/<session-uuid>/events.jsonl',
    });
    assert.deepStrictEqual(PROVIDER_REDIRECT_ADAPTERS.grok.durableSessionPaths, ['sessions/**', 'memory/**']);

    assert.deepStrictEqual(PROVIDER_REDIRECT_ADAPTERS.codex.resetPaths, ['**/*']);
    assert.deepStrictEqual(PROVIDER_REDIRECT_ADAPTERS.codex.support, {
      implementation: 'active',
      verdict: 'degraded',
      gate: null,
    });
    assert.deepStrictEqual(PROVIDER_REDIRECT_ADAPTERS.grok.resetPaths, ['**/*']);
    assert.deepStrictEqual(PROVIDER_REDIRECT_ADAPTERS.grok.support, {
      implementation: 'stub',
      verdict: 'not-yet-activated',
      gate: 'researcher-lane-provider-activation',
    });
  });

  test('Antigravity is an argv redirect with OS-keychain auth and no seedable file', () => {
    const agy = PROVIDER_REDIRECT_ADAPTERS.agy;

    assert.deepStrictEqual(agy.redirect, {
      kind: 'argv',
      name: '--gemini_dir',
      argumentShape: '--gemini_dir=<path>',
    });
    assert.notEqual(agy.redirect.kind, 'env');
    assert.deepStrictEqual(agy.auth, {
      kind: 'os-keychain',
      emptyHomeDeauthenticates: false,
      seedableFile: null,
    });
    assert.deepStrictEqual(agy.durableSessionPaths, [
      'antigravity-cli/brain/**',
      'antigravity-cli/conversations/**',
      'antigravity-cli/conversation_summaries.db',
    ]);
    assert.equal(agy.discovery.kind, 'antigravity-conversation-store');
    assert.deepStrictEqual(agy.resetPaths, ['**/*']);
    assert.deepStrictEqual(agy.support, {
      implementation: 'stub',
      verdict: 'not-yet-activated',
      gate: 'researcher-lane-provider-activation',
    });
  });
});

describe('support verdict resolution', () => {
  test('every adapter that has not been activated is explicit and never unsupported', () => {
    for (const provider of ['grok', 'agy'] as const) {
      const resolved = resolveProviderRedirectAdapter(provider);
      assert.equal(resolved.support.verdict, 'not-yet-activated');
      assert.notEqual(resolved.support.verdict, 'unsupported');
    }
  });

  test('codex resolves as an active degraded adapter', () => {
    const resolved = resolveProviderRedirectAdapter('codex');
    assert.equal(resolved.support.verdict, 'degraded');
    assert.notEqual(resolved.support.verdict, 'unsupported');
  });

  test('an absent adapter resolves to an explicit unsupported verdict', () => {
    assert.deepStrictEqual(resolveProviderRedirectAdapter('gemini'), {
      kind: 'missing-adapter',
      provider: 'gemini',
      support: {
        verdict: 'unsupported',
        gate: 'adapter-entry-required',
      },
    });
  });
});
