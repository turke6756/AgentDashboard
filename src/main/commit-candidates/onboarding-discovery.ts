import { createHash } from 'node:crypto';

import { COMMIT_CANDIDATE_CLUTTER_RECOGNITION_PATTERNS } from '../../shared/constants';
import { GitCommandError, runGitBytes as realRunGitBytes } from '../git-checkpoints/git-command';
import type { GitRunBytesResult, RunGitOptions } from '../git-checkpoints/git-command';
import {
  DIRTY_ENTRY_BUDGET,
  PATH_BYTES_BUDGET,
  SNAPSHOT_TIME_BUDGET,
  STATUS_OUTPUT_BYTE_BUDGET,
  type DirtyBudgetReason,
} from './dirty-inventory';
import {
  SCRATCH_POLICY_SCHEMA_VERSION,
  ScratchPolicyStore,
  type OnboardingDecision,
  type OnboardingProjection,
  type ScratchPolicyRecord,
} from './scratch-policy-store';

export type OnboardingRunGitBytes = (
  cwd: string,
  args: string[],
  options: RunGitOptions,
) => Promise<GitRunBytesResult>;

export interface OnboardingDiscoveryBudgets {
  maxEntries: number;
  maxStatusBytes: number;
  maxPathBytes: number;
  deadlineAt: number;
}

export interface OnboardingRecommendation {
  pathBytesBase64: string;
  displayPath: string;
  pattern: string;
  count: number;
  countExact: boolean;
  countLabel: string;
}

export interface FirstContactDiscovery {
  schemaVersion: typeof SCRATCH_POLICY_SCHEMA_VERSION;
  repositoryKey: string;
  workspaceKey: string;
  recommendations: OnboardingRecommendation[];
  discoveredRoots: Array<{ pathBytesBase64: string; displayPath: string }>;
  trackedChanges: Array<{ pathBytesBase64: string; displayPath: string }>;
  recommendationFingerprint: string | null;
  presentation: 'first-contact' | 'established' | null;
  completeness: 'complete' | 'partial';
  observedStopReasons: DirtyBudgetReason[];
  observedEntries: number;
  observedStatusBytes: number;
  observedPathBytes: number;
  totalsExact: boolean;
}

export interface DiscoverFirstContactRootsOptions {
  repoRoot: string;
  pathspec?: string;
  repositoryKey: string;
  workspaceKey: string;
  policyStore: ScratchPolicyStore;
  runGitBytes?: OnboardingRunGitBytes;
  gitExe?: string;
  budgets?: Partial<Omit<OnboardingDiscoveryBudgets, 'deadlineAt'>> & { deadlineAt?: number };
}

interface ParsedStatusRecord {
  kind: 'tracked' | 'untracked';
  path: Buffer;
}

function displayPath(raw: Buffer): string {
  return raw.toString('utf8').replace(/\\/g, '/');
}

function parseStatus(stdout: Buffer): ParsedStatusRecord[] {
  const tokens: Buffer[] = [];
  let offset = 0;
  while (offset < stdout.length) {
    const nul = stdout.indexOf(0, offset);
    if (nul < 0) break;
    tokens.push(stdout.subarray(offset, nul));
    offset = nul + 1;
  }

  const records: ParsedStatusRecord[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token[0] === 0x3f && token[1] === 0x20) {
      records.push({ kind: 'untracked', path: token.subarray(2) });
      continue;
    }
    const kind = token[0];
    const fieldCount = kind === 0x31 ? 8 : kind === 0x32 ? 9 : kind === 0x75 ? 10 : 0;
    if (fieldCount === 0) continue;
    let spaces = 0;
    let pathOffset = -1;
    for (let cursor = 0; cursor < token.length; cursor += 1) {
      if (token[cursor] !== 0x20) continue;
      spaces++;
      if (spaces === fieldCount) {
        pathOffset = cursor + 1;
        break;
      }
    }
    if (pathOffset >= 0 && pathOffset < token.length) {
      records.push({ kind: 'tracked', path: token.subarray(pathOffset) });
    }
    if (kind === 0x32) index++; // porcelain v2 rename/copy source-path token
  }
  return records;
}

function matchingPattern(rawPath: Buffer): string | null {
  const decoded = rawPath.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(rawPath)) return null;
  const normalized = decoded.replace(/\\/g, '/').replace(/^\.\//, '');
  return COMMIT_CANDIDATE_CLUTTER_RECOGNITION_PATTERNS.find((pattern) =>
    normalized === pattern || normalized.endsWith(`/${pattern}`),
  ) ?? null;
}

function fingerprint(recommendations: readonly OnboardingRecommendation[]): string | null {
  if (recommendations.length === 0) return null;
  const hash = createHash('sha256');
  recommendations
    .map((item) => item.pathBytesBase64)
    .sort()
    .forEach((item) => hash.update(item, 'utf8').update('\0'));
  return hash.digest('hex');
}

function projectionFor(record: ScratchPolicyRecord, workspaceKey: string): OnboardingProjection | undefined {
  return record.onboardingProjections.find((item) => item.workspaceKey === workspaceKey);
}

function choosePresentation(
  projection: OnboardingProjection | undefined,
  recommendationFingerprint: string | null,
): FirstContactDiscovery['presentation'] {
  if (!recommendationFingerprint) return null;
  if (!projection) return 'first-contact';
  // Generation changes alone are not a reason to nag. A changed recommendation
  // set is material and is re-offered, including after an earlier keep-everything.
  return projection.recommendationFingerprint === recommendationFingerprint
    ? 'established'
    : 'first-contact';
}

/**
 * Git-aware first-contact discovery. Git supplies the only candidate roots;
 * recognition never initiates a filesystem walk and never bypasses a budget.
 */
export async function discoverFirstContactRoots(
  options: DiscoverFirstContactRootsOptions,
): Promise<FirstContactDiscovery> {
  const runGitBytes = options.runGitBytes ?? realRunGitBytes;
  const budgets: OnboardingDiscoveryBudgets = {
    maxEntries: options.budgets?.maxEntries ?? DIRTY_ENTRY_BUDGET.hard,
    maxStatusBytes: options.budgets?.maxStatusBytes ?? STATUS_OUTPUT_BYTE_BUDGET.hard,
    maxPathBytes: options.budgets?.maxPathBytes ?? PATH_BYTES_BUDGET.hard,
    deadlineAt: options.budgets?.deadlineAt ?? Date.now() + SNAPSHOT_TIME_BUDGET.hardMs,
  };
  const stopReasons: DirtyBudgetReason[] = [];
  let observedEntries = 0;
  let observedStatusBytes = 0;
  let observedPathBytes = 0;
  const stop = (reason: DirtyBudgetReason): void => {
    if (!stopReasons.includes(reason)) stopReasons.push(reason);
  };

  const readStatus = async (untracked: 'normal' | 'all', pathspec?: Buffer): Promise<ParsedStatusRecord[]> => {
    if (Date.now() >= budgets.deadlineAt) {
      stop('deadline');
      return [];
    }
    const remainingBytes = budgets.maxStatusBytes - observedStatusBytes;
    if (remainingBytes <= 0) {
      stop('status-bytes');
      return [];
    }
    const args = ['--no-optional-locks', 'status', '--porcelain=v2', '-z', `--untracked-files=${untracked}`, '--'];
    if (pathspec) args.push(pathspec.toString('utf8'));
    else if (options.pathspec) args.push(options.pathspec);
    let result: GitRunBytesResult;
    try {
      result = await runGitBytes(options.repoRoot, args, {
        maxBytes: remainingBytes,
        deadlineAt: budgets.deadlineAt,
        gitExe: options.gitExe,
      });
    } catch (error) {
      if (error instanceof GitCommandError && error.kind === 'deadline') stop('deadline');
      else if (error instanceof GitCommandError && /maxBytes/.test(error.message)) stop('status-bytes');
      else throw error;
      return [];
    }
    const stdout = result.stdout.length > remainingBytes
      ? result.stdout.subarray(0, remainingBytes)
      : result.stdout;
    observedStatusBytes += result.stdout.length;
    if (result.stdout.length > remainingBytes) stop('status-bytes');
    const admitted: ParsedStatusRecord[] = [];
    for (const record of parseStatus(stdout)) {
      observedEntries++;
      observedPathBytes += record.path.length;
      if (observedEntries > budgets.maxEntries) stop('entries');
      if (observedPathBytes > budgets.maxPathBytes) stop('path-bytes');
      if (Date.now() >= budgets.deadlineAt) stop('deadline');
      if (stopReasons.length > 0) break;
      admitted.push(record);
    }
    return admitted;
  };

  const discovered = await readStatus('normal');
  const discoveredRoots = discovered
    .filter((record) => record.kind === 'untracked')
    .map((record) => ({ pathBytesBase64: record.path.toString('base64'), displayPath: displayPath(record.path) }));
  const trackedChanges = discovered
    .filter((record) => record.kind === 'tracked')
    .map((record) => ({ pathBytesBase64: record.path.toString('base64'), displayPath: displayPath(record.path) }));
  const roots = discovered
    .filter((record) => record.kind === 'untracked')
    .map((record) => ({ record, pattern: matchingPattern(record.path) }))
    .filter((item): item is { record: ParsedStatusRecord; pattern: string } => item.pattern !== null);

  const recommendations: OnboardingRecommendation[] = [];
  for (const root of roots) {
    const beforeEntries = observedEntries;
    const reasonsBefore = stopReasons.length;
    const wasScannable = stopReasons.length === 0;
    if (wasScannable) await readStatus('all', root.record.path);
    const count = Math.max(1, observedEntries - beforeEntries);
    const countExact = wasScannable && reasonsBefore === stopReasons.length;
    recommendations.push({
      pathBytesBase64: root.record.path.toString('base64'),
      displayPath: displayPath(root.record.path),
      pattern: root.pattern,
      count,
      countExact,
      countLabel: `${countExact ? '' : '>='}${count.toLocaleString('en-US')}`,
    });
  }

  const recommendationFingerprint = fingerprint(recommendations);
  const policy = options.policyStore.read(options.repositoryKey);
  const presentation = choosePresentation(
    projectionFor(policy, options.workspaceKey),
    recommendationFingerprint,
  );
  const completeness = stopReasons.length === 0 ? 'complete' : 'partial';
  return {
    schemaVersion: SCRATCH_POLICY_SCHEMA_VERSION,
    repositoryKey: options.repositoryKey,
    workspaceKey: options.workspaceKey,
    recommendations,
    discoveredRoots,
    trackedChanges,
    recommendationFingerprint,
    presentation,
    completeness,
    observedStopReasons: stopReasons,
    observedEntries,
    observedStatusBytes,
    observedPathBytes,
    totalsExact: completeness === 'complete',
  };
}

/** Persist a decision only for an applicable prompt. Exclusions remain in the
 * repository-keyed authority and are merged with existing raw-path policy. */
export function recordOnboardingDecision(
  store: ScratchPolicyStore,
  discovery: FirstContactDiscovery,
  decision: OnboardingDecision,
  selectedPathBytesBase64: readonly string[] = [],
): ScratchPolicyRecord {
  if (discovery.presentation !== 'first-contact' || !discovery.recommendationFingerprint
      || discovery.recommendations.length === 0) {
    throw new Error('Onboarding completion cannot be persisted when the prompt was not applicable.');
  }
  if (decision === 'exclude-selected') {
    const allowed = new Set(discovery.recommendations.map((item) => item.pathBytesBase64));
    const selected = selectedPathBytesBase64.filter((item) => allowed.has(item));
    const existing = store.read(discovery.repositoryKey).exclusions.map((item) => Buffer.from(item.value, 'base64'));
    store.setExclusions(discovery.repositoryKey, [
      ...existing,
      ...selected.map((item) => Buffer.from(item, 'base64')),
    ]);
  }
  return store.setOnboardingProjection(
    discovery.repositoryKey,
    discovery.workspaceKey,
    decision,
    discovery.recommendationFingerprint,
  );
}
