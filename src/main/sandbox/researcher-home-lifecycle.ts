import fs from 'fs';
import path from 'path';
import type { AgentProvider } from '../../shared/types';
import {
  resolveProviderRedirectAdapter,
  type ProviderRedirectAdapter,
} from './provider-redirect-adapters';
import type { ResearcherSandboxHome } from './researcher-home-factory';

export interface PrepareResearcherSandboxHomeInput {
  provider: AgentProvider;
  sandboxHome: ResearcherSandboxHome;
  /** Native path used by the Electron process (UNC for a WSL home). */
  filesystemHomePath?: string;
  /** Native account provider root from which copy-trusted auth is refreshed. */
  trustedProviderStateRoot: string;
  /** Logical account temp path, supplied explicitly for WSL and test fixtures. */
  accountTempPath?: string;
}

export interface PreparedResearcherSandboxHome {
  researcherSandboxHomePath: string;
  filesystemHomePath: string;
  tmpPath: string;
  spoolPath: string;
  /** The restricted child inherits the bootstrap environment, so this is the only injection surface. */
  extraEnv: Record<string, string>;
  /** Native argv redirect, when the provider does not use an environment variable. */
  extraArgs: string[];
}

const SPOOL_DIR = 'spool';
const SPOOL_FILE = 'pending-status.jsonl';

function activeAdapter(provider: AgentProvider): ProviderRedirectAdapter {
  const adapter = resolveProviderRedirectAdapter(provider);
  if ('kind' in adapter) {
    throw new Error(`Researcher sandbox provider '${provider}' is unsupported: no adapter entry`);
  }
  if (adapter.support.implementation !== 'active') {
    throw new Error(`Researcher sandbox provider '${provider}' is ${adapter.support.verdict}`);
  }
  return adapter;
}

function firstPathSegment(pattern: string): string {
  const normalized = pattern.replace(/\\/g, '/');
  const first = normalized.split('/').find(Boolean) ?? '';
  if (!first || first === '.' || first === '..' || /[*?\[\]]/.test(first)) {
    throw new Error(`Researcher sandbox durable path must begin with a literal segment: ${pattern}`);
  }
  return first;
}

function isInsideOrEqual(candidate: string, root: string, pathApi: typeof path.win32 | typeof path.posix): boolean {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative));
}

function atomicCopy(source: string, destination: string): void {
  const temporary = `${destination}.lares-seed-${process.pid}-${Date.now()}`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort temp cleanup */ }
    throw error;
  }
}

/**
 * Production prelaunch seam for the persistent researcher home. Each call
 * performs a default-deny reset before returning the environment that must be
 * merged into the actual restricted bootstrap environment.
 */
export function prepareResearcherSandboxHome(
  input: PrepareResearcherSandboxHomeInput,
): PreparedResearcherSandboxHome {
  const adapter = activeAdapter(input.provider);
  if (input.sandboxHome.launchRedirect.kind !== adapter.redirect.kind) {
    throw new Error(`Researcher sandbox redirect does not match the '${input.provider}' adapter`);
  }
  if (input.sandboxHome.launchRedirect.kind === 'env' && adapter.redirect.kind === 'env'
    && input.sandboxHome.launchRedirect.name !== adapter.redirect.name) {
    throw new Error(`Researcher sandbox redirect does not match the '${input.provider}' adapter`);
  }

  const logicalHome = input.sandboxHome.researcherSandboxHomePath;
  const pathApi = logicalHome.startsWith('/') ? path.posix : path.win32;
  const accountTemp = input.accountTempPath ?? process.env.TEMP ?? process.env.TMP;
  if (accountTemp && isInsideOrEqual(logicalHome, accountTemp, pathApi)) {
    throw new Error(`Researcher sandbox home must stay outside the account temp directory: ${logicalHome}`);
  }

  const filesystemHome = path.resolve(input.filesystemHomePath ?? logicalHome);
  const trustedRoot = path.resolve(input.trustedProviderStateRoot);
  if (isInsideOrEqual(trustedRoot, filesystemHome, path)) {
    throw new Error('Researcher sandbox trusted auth source must be outside the sandbox home');
  }

  fs.mkdirSync(filesystemHome, { recursive: true });
  const durableRoots = new Set(adapter.durableSessionPaths.map(firstPathSegment));
  durableRoots.add(SPOOL_DIR);
  for (const entry of fs.readdirSync(filesystemHome, { withFileTypes: true })) {
    if (!durableRoots.has(entry.name)) {
      fs.rmSync(path.join(filesystemHome, entry.name), { recursive: true, force: true });
    }
  }

  const filesystemTmp = path.join(filesystemHome, 'tmp');
  fs.rmSync(filesystemTmp, { recursive: true, force: true });
  fs.mkdirSync(filesystemTmp, { recursive: true });
  fs.mkdirSync(path.join(filesystemHome, SPOOL_DIR), { recursive: true });

  if (adapter.auth.kind === 'redirected-home-files') {
    for (const seed of adapter.auth.seeds) {
      const destination = path.join(filesystemHome, ...seed.path.split('/'));
      fs.rmSync(destination, { recursive: true, force: true });
      if (seed.strategy === 'copy-trusted') {
        const source = path.join(trustedRoot, ...seed.path.split('/'));
        if (!fs.statSync(source).isFile()) {
          throw new Error(`Researcher sandbox trusted auth source is not a file: ${source}`);
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        atomicCopy(source, destination);
      }
      // generate-sanitized is intentionally left absent until WP-7 settles the
      // Claude minimal-seed gate. The adapter remains explicitly degraded.
    }
  }

  const logicalTmp = pathApi.join(logicalHome, 'tmp');
  const logicalSpool = pathApi.join(logicalHome, SPOOL_DIR, SPOOL_FILE);
  const extraArgs = input.sandboxHome.launchRedirect.kind === 'argv'
    ? [input.sandboxHome.launchRedirect.argument]
    : [];
  return {
    researcherSandboxHomePath: logicalHome,
    filesystemHomePath: filesystemHome,
    tmpPath: logicalTmp,
    spoolPath: logicalSpool,
    extraEnv: {
      ...(input.sandboxHome.launchRedirect.kind === 'env'
        ? { [input.sandboxHome.launchRedirect.name]: input.sandboxHome.launchRedirect.value }
        : {}),
      TMP: logicalTmp,
      TEMP: logicalTmp,
      DASHBOARD_SPOOL_PATH: logicalSpool,
    },
    extraArgs,
  };
}

/** Explicit/operator and agent-row deletion purge seam. Normal launches never call it. */
export function purgeResearcherSandboxHome(filesystemHomePath: string): void {
  fs.rmSync(path.resolve(filesystemHomePath), { recursive: true, force: true });
}
