// Pre/post-launch rollout discovery for CLIs that mint their own session IDs.
//
// Codex has no supported machine-readable "current session id" API. The stable
// source is the rollout file under ~/.codex/sessions/YYYY/MM/DD/. Discovery is
// therefore filesystem based, but scoped to the launched agent's home root and
// validated against session_meta before persisting anything.

import {
  type CodexRolloutFile,
  type CodexSessionHome,
  listCodexRolloutFiles,
  readCodexSessionMeta,
} from './log-readers/codex-rollout-reader';

export interface CodexSessionSnapshot {
  home: CodexSessionHome;
  paths: Set<string>;
}

export interface DiscoveryResult {
  sessionId: string;
  filename: string;
  path: string;
  cwd: string;
  cliVersion: string | null;
}

export interface DiscoverCodexSessionOptions {
  workingDirectory: string;
  launchedAfterMs: number;
  timeoutMs?: number;
  listFiles?: (home: CodexSessionHome) => CodexRolloutFile[];
}

/** Snapshot rollout paths currently on disk for one Codex home root. */
export async function snapshotCodexSessions(home: CodexSessionHome): Promise<CodexSessionSnapshot> {
  return {
    home,
    paths: new Set(listCodexRolloutFiles({ home }).map((file) => file.path)),
  };
}

/**
 * Poll until a new, validated Codex rollout appears, or timeout elapses.
 *
 * Validation rejects unrelated concurrent sessions by requiring:
 * - file path was absent from the pre-launch snapshot
 * - file mtime is after launch start
 * - filename UUID matches session_meta.payload.id
 * - session_meta.payload.cwd matches the launched agent working directory
 */
export async function discoverNewCodexSession(
  before: CodexSessionSnapshot,
  options: DiscoverCodexSessionOptions
): Promise<DiscoveryResult | null> {
  const pollIntervalMs = 500;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  const targetCwd = normalizeCwd(options.workingDirectory);

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const current = options.listFiles
      ? options.listFiles(before.home)
      : listCodexRolloutFiles({ home: before.home });
    const candidates = current
      .filter((file) => !before.paths.has(file.path))
      .filter((file) => file.mtimeMs >= options.launchedAfterMs)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const file of candidates) {
      const valid = validateCandidate(file, targetCwd);
      if (valid) return valid;
    }
  }
  return null;
}

function validateCandidate(file: CodexRolloutFile, targetCwd: string): DiscoveryResult | null {
  const meta = readCodexSessionMeta(file.path);
  if (!meta.id || meta.id !== file.sessionId) return null;
  if (!meta.cwd || normalizeCwd(meta.cwd) !== targetCwd) return null;
  return {
    sessionId: file.sessionId,
    filename: file.filename,
    path: file.path,
    cwd: meta.cwd,
    cliVersion: meta.cliVersion,
  };
}

function normalizeCwd(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
