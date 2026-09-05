import { TextDecoder } from 'node:util';
import type {
  LandedCommitEvidenceV2,
  LandedCommitRefusal,
  LandedCommitTouchV2,
  LandedCommitVerification,
} from '../../shared/types';
import { runGit, runGitBytes } from '../git-checkpoints/git-command';
import { briefedWorkPackageId } from './work-package-id';

export type { LandedCommitRefusal, LandedCommitVerification } from '../../shared/types';

export interface LandedCommitVerificationInput {
  repositoryKey: string;
  branchRef: string;
  dispatchTipOid: string;
  frozenPaths: readonly string[];
  planArtifactId: string;
  wpId: string;
  commitOid: string;
}

export interface GitCommitView {
  oid: string;
  subject: string;
  message: string;
  parentOids: string[];
}

export interface LandedCommitGitOracle {
  resolveCommit(repositoryKey: string, revision: string): Promise<string | null>;
  isAncestor(repositoryKey: string, ancestorOid: string, descendantOid: string): Promise<boolean>;
  listFirstParentRange(
    repositoryKey: string,
    dispatchTipOid: string,
    gateTipOid: string,
    cap?: number,
  ): Promise<{ commitOids: string[]; truncated: boolean }>;
  readCommit(repositoryKey: string, commitOid: string): Promise<GitCommitView>;
  interpretTrailers(repositoryKey: string, message: string): Promise<Array<{ key: string; value: string }>>;
  changedPaths(repositoryKey: string, parentOid: string, commitOid: string): Promise<Buffer[]>;
}

/** Compatibility projection retained until the asserted tier adopts its V2 union. */
export interface MatchingCommit {
  commitOid: string;
  subject: string;
  verifiedTrailer: string | null;
  scopeOmittedTrailer: string | null;
  parentOid: string;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

function decodedPath(value: Buffer): string | null {
  try {
    const decoded = utf8.decode(value);
    return Buffer.from(decoded, 'utf8').equals(value) ? decoded : null;
  } catch {
    return null;
  }
}

function encodedFrozenPaths(paths: readonly string[]): Buffer[] | null {
  const encoded: Buffer[] = [];
  for (const value of paths) {
    const bytes = Buffer.from(value, 'utf8');
    if (utf8.decode(bytes) !== value) return null;
    encoded.push(bytes);
  }
  return encoded;
}

function decodedPaths(values: readonly Buffer[]): string[] | null {
  const paths: string[] = [];
  for (const value of values) {
    const path = decodedPath(value);
    if (path === null) return null;
    paths.push(path);
  }
  return paths;
}

function samePathSet(actual: readonly Buffer[], frozen: readonly Buffer[]): boolean {
  if (actual.length !== frozen.length) return false;
  const actualHex = new Set(actual.map((value) => value.toString('hex')));
  const frozenHex = new Set(frozen.map((value) => value.toString('hex')));
  return actualHex.size === actual.length && frozenHex.size === frozen.length
    && actualHex.size === frozenHex.size && [...actualHex].every((value) => frozenHex.has(value));
}

function trailerValues(trailers: readonly { key: string; value: string }[], key: string): string[] {
  return trailers.filter((entry) => entry.key === key).map((entry) => entry.value);
}

async function commitTouch(
  repositoryKey: string,
  commitOid: string,
  frozen: readonly Buffer[],
  git: LandedCommitGitOracle,
): Promise<LandedCommitTouchV2 | null | LandedCommitRefusal> {
  const commit = await git.readCommit(repositoryKey, commitOid);
  if (commit.parentOids.length === 0) return null;
  const rawPaths = await git.changedPaths(repositoryKey, commit.parentOids[0], commitOid);
  const paths = decodedPaths(rawPaths);
  if (!paths) return 'unrepresentable-paths';
  if (!rawPaths.some((path) => frozen.some((expected) => expected.equals(path)))) return null;
  const trailers = await git.interpretTrailers(repositoryKey, commit.message);
  return {
    commitOid,
    parentOids: [...commit.parentOids],
    paths,
    planTrailers: trailerValues(trailers, 'Plan'),
    wpTrailers: trailerValues(trailers, 'WP'),
  };
}

function withLegacyAliases(evidence: LandedCommitEvidenceV2): LandedCommitVerification {
  const result = { outcome: 'verified' as const, evidence } as LandedCommitVerification;
  // Current gate service consumes these until WP-4 moves it to evidence V2.
  Object.defineProperties(result, {
    commitOid: { value: evidence.namedCommit.commitOid },
    parentOid: { value: evidence.namedCommit.parentOid },
    subject: { value: evidence.namedCommit.subject },
    verifiedTrailer: { value: evidence.labels.verified[0] ?? null },
    scopeOmittedTrailer: { value: evidence.labels.scopeOmitted[0] ?? null },
  });
  return result;
}

export async function verifyLandedCommit(
  input: LandedCommitVerificationInput,
  git: LandedCommitGitOracle,
): Promise<LandedCommitVerification> {
  try {
    const gateTipOid = await git.resolveCommit(input.repositoryKey, `${input.branchRef}^{commit}`);
    if (!gateTipOid) return { outcome: 'refused', reason: 'branch-unresolvable' };
    if (!await git.isAncestor(input.repositoryKey, input.dispatchTipOid, gateTipOid)) {
      return { outcome: 'refused', reason: 'dispatch-tip-not-ancestor' };
    }
    const range = await git.listFirstParentRange(input.repositoryKey, input.dispatchTipOid, gateTipOid);
    if (range.truncated) return { outcome: 'refused', reason: 'range-truncated' };
    const namedIndex = range.commitOids.indexOf(input.commitOid);
    if (namedIndex < 0) return { outcome: 'refused', reason: 'named-commit-not-in-range' };

    const named = await git.readCommit(input.repositoryKey, input.commitOid);
    if (named.parentOids.length !== 1) {
      return { outcome: 'refused', reason: 'named-commit-not-single-parent' };
    }
    const frozen = encodedFrozenPaths(input.frozenPaths);
    if (!frozen) return { outcome: 'refused', reason: 'unrepresentable-paths' };
    const rawChangedPaths = await git.changedPaths(input.repositoryKey, named.parentOids[0], named.oid);
    const changedPaths = decodedPaths(rawChangedPaths);
    if (!changedPaths) return { outcome: 'refused', reason: 'unrepresentable-paths' };
    if (!samePathSet(rawChangedPaths, frozen)) {
      return { outcome: 'refused', reason: 'changed-paths-diverge' };
    }

    const trailers = await git.interpretTrailers(input.repositoryKey, named.message);
    const plans = trailerValues(trailers, 'Plan');
    const workPackages = trailerValues(trailers, 'WP');
    const expectedWp = briefedWorkPackageId(input.wpId, input.planArtifactId);
    if (plans.length !== 1 || plans[0] !== input.planArtifactId
        || workPackages.length !== 1 || asciiLower(workPackages[0]) !== asciiLower(expectedWp)) {
      return { outcome: 'refused', reason: 'labels-mismatch' };
    }

    const collectTouches = async (oids: readonly string[]): Promise<LandedCommitTouchV2[] | LandedCommitRefusal> => {
      const touches: LandedCommitTouchV2[] = [];
      for (const oid of oids) {
        const touch = await commitTouch(input.repositoryKey, oid, frozen, git);
        if (typeof touch === 'string') return touch;
        if (touch) touches.push(touch);
      }
      return touches;
    };
    const priorFrozenPathTouches = await collectTouches(range.commitOids.slice(namedIndex + 1));
    if (typeof priorFrozenPathTouches === 'string') {
      return { outcome: 'refused', reason: priorFrozenPathTouches };
    }
    const postClaimTouches = await collectTouches(range.commitOids.slice(0, namedIndex));
    if (typeof postClaimTouches === 'string') return { outcome: 'refused', reason: postClaimTouches };

    return withLegacyAliases({
      schemaVersion: 2,
      repositoryKey: input.repositoryKey,
      branchRef: input.branchRef,
      dispatchTipOid: input.dispatchTipOid,
      gateTipOid,
      namedCommit: { commitOid: named.oid, parentOid: named.parentOids[0], subject: named.subject },
      labels: {
        plan: plans[0],
        wp: workPackages[0],
        verified: trailerValues(trailers, 'Verified'),
        scopeOmitted: trailerValues(trailers, 'Scope-omitted'),
      },
      changedPaths,
      priorFrozenPathTouches,
      postClaimTouches,
    });
  } catch {
    return { outcome: 'refused', reason: 'verifier-unavailable' };
  }
}

/** Compatibility scan used by asserted-tier until WP-5 replaces candidate discovery. */
export async function scanMatchingCommits(
  input: Omit<LandedCommitVerificationInput, 'commitOid' | 'frozenPaths'>,
  git: LandedCommitGitOracle,
  cap?: number,
): Promise<
  | { outcome: 'scanned'; gateTipOid: string; matches: MatchingCommit[]; truncated: boolean }
  | { outcome: 'refused'; reason: 'branch-unresolvable' | 'dispatch-tip-not-ancestor' }
> {
  const gateTipOid = await git.resolveCommit(input.repositoryKey, `${input.branchRef}^{commit}`);
  if (!gateTipOid) return { outcome: 'refused', reason: 'branch-unresolvable' };
  if (!await git.isAncestor(input.repositoryKey, input.dispatchTipOid, gateTipOid)) {
    return { outcome: 'refused', reason: 'dispatch-tip-not-ancestor' };
  }
  const range = await git.listFirstParentRange(input.repositoryKey, input.dispatchTipOid, gateTipOid, cap);
  const expectedWp = briefedWorkPackageId(input.wpId, input.planArtifactId);
  const matches: MatchingCommit[] = [];
  for (const oid of range.commitOids) {
    const commit = await git.readCommit(input.repositoryKey, oid);
    if (commit.parentOids.length !== 1) continue;
    const trailers = await git.interpretTrailers(input.repositoryKey, commit.message);
    const plans = trailerValues(trailers, 'Plan');
    const workPackages = trailerValues(trailers, 'WP');
    if (plans.length !== 1 || plans[0] !== input.planArtifactId || workPackages.length !== 1
        || asciiLower(workPackages[0]) !== asciiLower(expectedWp)) continue;
    matches.push({
      commitOid: oid,
      subject: commit.subject,
      parentOid: commit.parentOids[0],
      verifiedTrailer: trailerValues(trailers, 'Verified')[0] ?? null,
      scopeOmittedTrailer: trailerValues(trailers, 'Scope-omitted')[0] ?? null,
    });
  }
  return { outcome: 'scanned', gateTipOid, matches, truncated: range.truncated };
}

export async function changedPathsMatchFrozen(
  repositoryKey: string,
  match: MatchingCommit,
  frozenPaths: readonly string[],
  git: LandedCommitGitOracle,
): Promise<boolean> {
  const frozen = encodedFrozenPaths(frozenPaths);
  if (!frozen) return false;
  return samePathSet(await git.changedPaths(repositoryKey, match.parentOid, match.commitOid), frozen);
}

export function createGitOracle(repositoryRoot: string): LandedCommitGitOracle {
  const text = (args: string[], allowNonzero = false, stdin?: string) => runGit(repositoryRoot, args, {
    maxBytes: 64 * 1024 * 1024, timeoutMs: 30_000, allowNonzero, stdin,
  });
  return {
    async resolveCommit(_repositoryKey, revision) {
      const result = await text(['rev-parse', '--verify', revision], true);
      const oid = result.stdout.trim();
      return result.code === 0 && /^[0-9a-f]{40}$/.test(oid) ? oid : null;
    },
    async isAncestor(_repositoryKey, ancestorOid, descendantOid) {
      return (await text(['merge-base', '--is-ancestor', ancestorOid, descendantOid], true)).code === 0;
    },
    async listFirstParentRange(_repositoryKey, dispatchTipOid, gateTipOid, cap) {
      const args = ['rev-list', '--first-parent'];
      if (cap !== undefined) args.push(`--max-count=${cap + 1}`);
      args.push(`${dispatchTipOid}..${gateTipOid}`);
      const oids = (await text(args)).stdout.trim().split(/\r?\n/).filter(Boolean);
      const truncated = cap !== undefined && oids.length > cap;
      return { commitOids: truncated ? oids.slice(0, cap) : oids, truncated };
    },
    async readCommit(_repositoryKey, commitOid) {
      const result = await text(['show', '-s', '--format=%H%x00%P%x00%s%x00%B', commitOid]);
      const [oid, parents, subject, ...body] = result.stdout.split('\0');
      return { oid, parentOids: parents ? parents.split(' ') : [], subject, message: body.join('\0') };
    },
    async interpretTrailers(_repositoryKey, message) {
      const result = await text(['interpret-trailers', '--parse'], false, message);
      return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
        const index = line.indexOf(':');
        return { key: line.slice(0, index), value: line.slice(index + 1).trimStart() };
      });
    },
    async changedPaths(_repositoryKey, parentOid, commitOid) {
      const result = await runGitBytes(repositoryRoot,
        ['diff-tree', '-r', '-z', '--no-renames', '--name-only', parentOid, commitOid],
        { maxBytes: 64 * 1024 * 1024, timeoutMs: 30_000 });
      const pieces = result.stdout.subarray(0, result.stdout.length && result.stdout.at(-1) === 0 ? -1 : undefined);
      return pieces.length === 0 ? [] : pieces.toString('binary').split('\0').map((value) => Buffer.from(value, 'binary'));
    },
  };
}
