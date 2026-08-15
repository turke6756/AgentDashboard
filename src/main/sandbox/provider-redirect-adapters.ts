import fs from 'fs';
import path from 'path';
import type { AgentProvider, LaunchableAgentProvider } from '../../shared/types';

export type RedirectMechanism =
  | { kind: 'env'; name: string }
  | { kind: 'argv'; name: string; argumentShape: string };

export type AuthSource =
  | {
      kind: 'redirected-home-files';
      emptyHomeDeauthenticates: true;
      seeds: readonly {
        path: string;
        strategy: 'copy-trusted' | 'generate-sanitized';
      }[];
    }
  | {
      kind: 'redirected-home-file-or-env';
      emptyHomeDeauthenticates: true;
      file: string;
      env: string;
      preferred: 'env';
    }
  | {
      kind: 'os-keychain';
      emptyHomeDeauthenticates: false;
      seedableFile: null;
    };

export type DiscoveryResolverShape =
  | {
      kind: 'cwd-slug-jsonl';
      pathPattern: 'projects/<cwd-slug>/<session-uuid>.jsonl';
      cwdEncoding: 'path-separators-and-colon-to-dash';
    }
  | {
      kind: 'dated-rollout-jsonl';
      pathPattern: 'sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl';
    }
  | {
      kind: 'antigravity-conversation-store';
      pathPatterns: readonly [
        'antigravity-cli/brain/<conversation-id>/**',
        'antigravity-cli/conversations/**',
      ];
    }
  | {
      kind: 'url-encoded-cwd-session-directory';
      pathPattern: 'sessions/<urlencoded-cwd>/<session-uuid>/chat_history.jsonl';
      companionPath: 'sessions/<urlencoded-cwd>/<session-uuid>/events.jsonl';
    };

export type AdapterSupport =
  | {
      implementation: 'active';
      verdict: 'supported' | 'degraded';
      gate: string | null;
    }
  | {
      implementation: 'stub';
      verdict: 'not-yet-activated';
      gate: 'researcher-lane-provider-activation';
      inactiveReason?: string;
    };

export function formatResearcherLaunchRefusal(
  provider: string,
  support: Extract<AdapterSupport, { implementation: 'stub' }>,
): string {
  const reason = support.inactiveReason ? ` because ${support.inactiveReason}` : '';
  return `Cannot launch ${provider} researcher: the researcher lane is ${support.verdict} for ${provider}${reason}`;
}

export interface ProviderRedirectAdapter {
  provider: LaunchableAgentProvider;
  /** Provider state directory under the human account home. */
  stateDirectory: string;
  redirect: RedirectMechanism;
  auth: AuthSource;
  /** Root-relative paths retained across the default-deny reset. */
  durableSessionPaths: readonly string[];
  /** Root-relative globs removed after durable paths are extracted. */
  resetPaths: readonly string[];
  discovery: DiscoveryResolverShape;
  support: AdapterSupport;
}

export interface UnsupportedProviderRedirect {
  kind: 'missing-adapter';
  provider: string;
  support: {
    verdict: 'unsupported';
    gate: 'adapter-entry-required';
  };
}

const DEFAULT_DENY_RESET = ['**/*'] as const;

export const PROVIDER_REDIRECT_ADAPTERS = {
  claude: {
    provider: 'claude',
    stateDirectory: '.claude',
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
    resetPaths: DEFAULT_DENY_RESET,
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
  },
  codex: {
    provider: 'codex',
    stateDirectory: '.codex',
    redirect: { kind: 'env', name: 'CODEX_HOME' },
    auth: {
      kind: 'redirected-home-files',
      emptyHomeDeauthenticates: true,
      seeds: [{ path: 'auth.json', strategy: 'copy-trusted' }],
    },
    durableSessionPaths: ['sessions/**'],
    resetPaths: DEFAULT_DENY_RESET,
    discovery: {
      kind: 'dated-rollout-jsonl',
      pathPattern: 'sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl',
    },
    support: {
      implementation: 'active',
      verdict: 'degraded',
      gate: null,
    },
  },
  grok: {
    provider: 'grok',
    stateDirectory: '.grok',
    redirect: { kind: 'env', name: 'GROK_HOME' },
    auth: {
      kind: 'redirected-home-file-or-env',
      emptyHomeDeauthenticates: true,
      file: 'auth.json',
      env: 'XAI_API_KEY',
      preferred: 'env',
    },
    durableSessionPaths: ['sessions/**', 'memory/**'],
    resetPaths: DEFAULT_DENY_RESET,
    discovery: {
      kind: 'url-encoded-cwd-session-directory',
      pathPattern: 'sessions/<urlencoded-cwd>/<session-uuid>/chat_history.jsonl',
      companionPath: 'sessions/<urlencoded-cwd>/<session-uuid>/events.jsonl',
    },
    support: {
      implementation: 'stub',
      verdict: 'not-yet-activated',
      gate: 'researcher-lane-provider-activation',
      inactiveReason: 'no tool-restriction mechanism exists for this provider',
    },
  },
  agy: {
    provider: 'agy',
    stateDirectory: '.gemini',
    redirect: {
      kind: 'argv',
      name: '--gemini_dir',
      argumentShape: '--gemini_dir=<path>',
    },
    auth: {
      kind: 'os-keychain',
      emptyHomeDeauthenticates: false,
      seedableFile: null,
    },
    durableSessionPaths: [
      'antigravity-cli/brain/**',
      'antigravity-cli/conversations/**',
      'antigravity-cli/conversation_summaries.db',
    ],
    resetPaths: DEFAULT_DENY_RESET,
    discovery: {
      kind: 'antigravity-conversation-store',
      pathPatterns: [
        'antigravity-cli/brain/<conversation-id>/**',
        'antigravity-cli/conversations/**',
      ],
    },
    support: {
      implementation: 'active',
      verdict: 'degraded',
      gate: null,
    },
  },
} as const satisfies Record<LaunchableAgentProvider, ProviderRedirectAdapter>;

export type ResolvedProviderRedirect = ProviderRedirectAdapter | UnsupportedProviderRedirect;

export function resolveProviderRedirectAdapter(provider: string): ResolvedProviderRedirect {
  if (Object.prototype.hasOwnProperty.call(PROVIDER_REDIRECT_ADAPTERS, provider)) {
    return PROVIDER_REDIRECT_ADAPTERS[provider as LaunchableAgentProvider];
  }

  return {
    kind: 'missing-adapter',
    provider,
    support: {
      verdict: 'unsupported',
      gate: 'adapter-entry-required',
    },
  };
}

/** Return the provider's normal state directory under the human account home. */
export function researcherProviderStateDirectory(provider: AgentProvider): string | null {
  const adapter = resolveProviderRedirectAdapter(provider);
  return 'kind' in adapter ? null : adapter.stateDirectory;
}

/**
 * Preflight only the credentials that are represented by files. Researchers
 * use the same provider state root as workers; this check never copies, seeds,
 * redirects, creates, or removes anything.
 */
export function assertResearcherProviderCredentials(
  provider: AgentProvider,
  providerStateRoot: string | null,
): void {
  const adapter = resolveProviderRedirectAdapter(provider);
  if ('kind' in adapter) {
    throw new Error(`Cannot launch ${provider} researcher: no provider adapter exists`);
  }
  if (adapter.support.implementation !== 'active') {
    throw new Error(formatResearcherLaunchRefusal(provider, adapter.support));
  }

  if (adapter.auth.kind === 'os-keychain') return;
  if (adapter.auth.kind === 'redirected-home-file-or-env' && process.env[adapter.auth.env]) return;

  const credentialPaths = adapter.auth.kind === 'redirected-home-files'
    ? adapter.auth.seeds
      .filter((seed) => seed.strategy === 'copy-trusted')
      .map((seed) => seed.path)
    : [adapter.auth.file];

  for (const credentialPath of credentialPaths) {
    const source = providerStateRoot
      ? path.join(providerStateRoot, ...credentialPath.split('/'))
      : path.join(adapter.stateDirectory, ...credentialPath.split('/'));
    if (!providerStateRoot || !fs.existsSync(source)) {
      throw new Error(`Cannot launch ${provider} researcher: credential file is missing: ${source}`);
    }
    if (!fs.statSync(source).isFile()) {
      throw new Error(`Cannot launch ${provider} researcher: credential path is not a file: ${source}`);
    }
  }
}
