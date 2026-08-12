import fs from 'node:fs';
import path from 'node:path';

/**
 * Lares-created files which are workspace exhaust rather than user work.
 * Rules are root-anchored so a user's ordinary `scratch/` or `archive/`
 * directory outside the state directory remains visible.
 */
export const LARES_EXHAUST_GITIGNORE_RULES = Object.freeze([
  '/.lares/workers/',
  '/.dashboard/workers/',
  '/.lares/agent-homes/',
  '/.dashboard/agent-homes/',
  '/reachability-mutations/',
  '/.lares/reachability-mutations/',
  '/.dashboard/reachability-mutations/',
  '/.lares/research/inbox/',
  '/.dashboard/research/inbox/',
  '/.lares/research/scratch/',
  '/.dashboard/research/scratch/',
  '/.lares/scratch/',
  '/.dashboard/scratch/',
  '/.lares/archive/',
  '/.dashboard/archive/',
  '/.lares/tmp/',
  '/.dashboard/tmp/',
  '/.lares/tmp-*',
  '/.dashboard/tmp-*',
  '/.lares/*.log',
  '/.dashboard/*.log',
] as const);

/** Common generated or large repository-local payloads which should not enter a scan. */
export const STANDARD_LARGE_FILE_GITIGNORE_RULES = Object.freeze([
  'node_modules/',
  'dist/',
  'release*/',
  '*.zip',
  '*.tar',
  '*.tar.gz',
  '*.7z',
  '*.iso',
  '*.dmg',
] as const);

export const SUGGESTED_GITIGNORE_RULES = Object.freeze([
  ...LARES_EXHAUST_GITIGNORE_RULES,
  ...STANDARD_LARGE_FILE_GITIGNORE_RULES,
] as const);

export interface GitignoreSuggestionEvent {
  kind: 'gitignore-additions-suggested';
  workspaceRoot: string;
  gitignorePath: string;
  missingRules: readonly string[];
}

export interface GitignoreAcceptanceResult {
  gitignorePath: string;
  appendedRules: readonly string[];
}

export interface GitignoreSuggestionNotice extends GitignoreSuggestionEvent {
  workspaceId: string;
}

export interface GitignoreSuggestionIpc {
  handle(channel: string, listener: (_event: unknown, workspaceId: string) => unknown): void;
}

export interface GitignoreSuggestionController {
  workspaceOpened(workspaceId: string): GitignoreSuggestionNotice | null;
}

export const GITIGNORE_SUGGESTION_CHANNELS = Object.freeze({
  suggest: 'workspace:gitignore-suggest',
  accept: 'workspace:gitignore-accept',
  suggested: 'workspace:gitignore-suggested',
});

type SuggestionListener = (event: GitignoreSuggestionEvent) => void;
const suggestionListeners = new Set<SuggestionListener>();

/** Subscribe the workspace-open/UI adapter to ask the user about a suggestion. */
export function onGitignoreSuggestion(listener: SuggestionListener): () => void {
  suggestionListeners.add(listener);
  return () => suggestionListeners.delete(listener);
}

function readGitignore(gitignorePath: string): string {
  try {
    return fs.readFileSync(gitignorePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function configuredRules(content: string): Set<string> {
  const rules = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return new Set(rules);
}

function missingRules(content: string, candidates: readonly string[]): string[] {
  const configured = configuredRules(content);
  return candidates.filter((rule) => !configured.has(rule));
}

/**
 * Compute and emit an ask-first suggestion. This function never writes.
 * Production calls the same seam for workspace-open and explicit on-demand scans.
 */
export function suggestGitignoreAdditions(workspaceRoot: string): GitignoreSuggestionEvent | null {
  const resolvedRoot = path.resolve(workspaceRoot);
  const gitignorePath = path.join(resolvedRoot, '.gitignore');
  const missing = missingRules(readGitignore(gitignorePath), SUGGESTED_GITIGNORE_RULES);
  if (missing.length === 0) return null;

  const event: GitignoreSuggestionEvent = Object.freeze({
    kind: 'gitignore-additions-suggested',
    workspaceRoot: resolvedRoot,
    gitignorePath,
    missingRules: Object.freeze(missing),
  });
  for (const listener of suggestionListeners) listener(event);
  return event;
}

/** Apply an accepted suggestion, re-diffing at write time to avoid duplicates. */
export function acceptGitignoreSuggestion(suggestion: GitignoreSuggestionEvent): GitignoreAcceptanceResult {
  const current = readGitignore(suggestion.gitignorePath);
  const append = missingRules(current, suggestion.missingRules);
  if (append.length === 0) {
    return { gitignorePath: suggestion.gitignorePath, appendedRules: Object.freeze([]) };
  }

  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const separator = current.length > 0 && !current.endsWith('\n') && !current.endsWith('\r') ? newline : '';
  fs.appendFileSync(suggestion.gitignorePath, `${separator}${append.join(newline)}${newline}`, 'utf8');
  return { gitignorePath: suggestion.gitignorePath, appendedRules: Object.freeze(append) };
}

/** Register the existing workspace IPC surface and return its workspace-open adapter. */
export function registerGitignoreSuggestionIpc(
  ipc: GitignoreSuggestionIpc,
  send: (channel: string, notice: GitignoreSuggestionNotice) => void,
  resolveWorkspaceRoot: (workspaceId: string) => string | null,
): GitignoreSuggestionController {
  const pending = new Map<string, GitignoreSuggestionNotice>();

  const publish = (workspaceId: string): GitignoreSuggestionNotice | null => {
    const workspaceRoot = resolveWorkspaceRoot(workspaceId);
    if (!workspaceRoot) return null;
    const suggestion = suggestGitignoreAdditions(workspaceRoot);
    if (!suggestion) {
      pending.delete(workspaceId);
      return null;
    }
    const notice = Object.freeze({ ...suggestion, workspaceId });
    pending.set(workspaceId, notice);
    send(GITIGNORE_SUGGESTION_CHANNELS.suggested, notice);
    return notice;
  };

  ipc.handle(GITIGNORE_SUGGESTION_CHANNELS.suggest, (_event, workspaceId) => publish(workspaceId));
  ipc.handle(GITIGNORE_SUGGESTION_CHANNELS.accept, (_event, workspaceId) => {
    const suggestion = pending.get(workspaceId);
    if (!suggestion) return { accepted: false as const, reason: 'suggestion-expired' as const };
    const result = acceptGitignoreSuggestion(suggestion);
    pending.delete(workspaceId);
    return { accepted: true as const, appendedRules: result.appendedRules };
  });

  return { workspaceOpened: publish };
}
