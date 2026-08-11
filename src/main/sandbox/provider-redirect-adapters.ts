import type { LaunchableAgentProvider } from '../../shared/types';

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
    };

export interface ProviderRedirectAdapter {
  provider: LaunchableAgentProvider;
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
      implementation: 'stub',
      verdict: 'not-yet-activated',
      gate: 'researcher-lane-provider-activation',
    },
  },
  grok: {
    provider: 'grok',
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
    },
  },
  agy: {
    provider: 'agy',
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
      implementation: 'stub',
      verdict: 'not-yet-activated',
      gate: 'researcher-lane-provider-activation',
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
