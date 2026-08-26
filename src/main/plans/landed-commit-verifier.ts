import { runGit, runGitBytes } from '../git-checkpoints/git-command';

export type LandedCommitRefusal =
  | 'branch-unresolvable'
  | 'dispatch-tip-not-ancestor'
  | 'no-matching-commit'
  | 'multiple-matching-commits'
  | 'commit-oid-not-the-match'
  | 'changed-paths-diverge';

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

export interface MatchingCommit {
  commitOid: string;
  subject: string;
  verifiedTrailer: string | null;
  scopeOmittedTrailer: string | null;
  parentOid: string;
}

export type LandedCommitVerification =
  | ({ outcome: 'verified' } & MatchingCommit)
  | { outcome: 'refused'; reason: LandedCommitRefusal };

const ALLOWED_TRAILERS = new Set(['Plan', 'WP', 'Verified', 'Scope-omitted']);
const TRAILER_LINE = /^([^:\s][^:]*):[ \t](.*)$/;

function finalParagraph(message: string): string[] {
  const normalized = message.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const paragraphs = normalized.split(/\n\n+/);
  return (paragraphs.at(-1) ?? '').split('\n');
}

async function parseMatchingCommit(
  input: Pick<LandedCommitVerificationInput, 'repositoryKey' | 'planArtifactId' | 'wpId'>,
  oid: string,
  git: LandedCommitGitOracle,
): Promise<MatchingCommit | null> {
  const commit = await git.readCommit(input.repositoryKey, oid);
  if (commit.parentOids.length !== 1) return null;
  const physical = finalParagraph(commit.message);
  if (physical.length < 3) return null;
  const fullCounts = new Map<string, number>();
  for (const line of commit.message.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^([^:\s][^:]*):(?:[ \t]|$)/.exec(line);
    if (!match) continue;
    const canonical = [...ALLOWED_TRAILERS].find((key) => key.toLowerCase() === match[1].toLowerCase());
    if (!canonical) continue;
    if (match[1] !== canonical) return null;
    fullCounts.set(canonical, (fullCounts.get(canonical) ?? 0) + 1);
  }
  const parsedPhysical: Array<{ key: string; value: string }> = [];
  for (const line of physical) {
    const match = TRAILER_LINE.exec(line);
    if (!match || !ALLOWED_TRAILERS.has(match[1])) return null;
    parsedPhysical.push({ key: match[1], value: match[2] });
  }
  const counts = new Map<string, number>();
  for (const trailer of parsedPhysical) counts.set(trailer.key, (counts.get(trailer.key) ?? 0) + 1);
  if (counts.get('Plan') !== 1 || counts.get('WP') !== 1 || counts.get('Verified') !== 1
      || (counts.get('Scope-omitted') ?? 0) > 1
      || fullCounts.get('Plan') !== 1 || fullCounts.get('WP') !== 1 || fullCounts.get('Verified') !== 1
      || (fullCounts.get('Scope-omitted') ?? 0) > 1) return null;

  // Git remains the parsing authority; the physical pass above supplies the
  // duplicate/folded/alternate-case/unknown-key guarantees it does not expose.
  const interpreted = await git.interpretTrailers(input.repositoryKey, commit.message);
  if (interpreted.length !== parsedPhysical.length
      || interpreted.some((value, index) => value.key !== parsedPhysical[index].key
        || value.value !== parsedPhysical[index].value)) return null;
  const one = (key: string): string | null => parsedPhysical.find((entry) => entry.key === key)?.value ?? null;
  if (one('Plan') !== input.planArtifactId || one('WP') !== input.wpId) return null;
  return {
    commitOid: oid,
    subject: commit.subject,
    verifiedTrailer: one('Verified'),
    scopeOmittedTrailer: one('Scope-omitted'),
    parentOid: commit.parentOids[0],
  };
}

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
  const matches: MatchingCommit[] = [];
  for (const oid of range.commitOids) {
    const match = await parseMatchingCommit(input, oid, git);
    if (match) matches.push(match);
  }
  return { outcome: 'scanned', gateTipOid, matches, truncated: range.truncated };
}

function samePathSet(actual: readonly Buffer[], frozen: readonly string[]): boolean {
  if (actual.length !== frozen.length) return false;
  const actualHex = new Set(actual.map((value) => value.toString('hex')));
  const frozenHex = new Set(frozen.map((value) => Buffer.from(value, 'utf8').toString('hex')));
  return actualHex.size === actual.length && frozenHex.size === frozen.length
    && actualHex.size === frozenHex.size && [...actualHex].every((value) => frozenHex.has(value));
}

export async function changedPathsMatchFrozen(
  repositoryKey: string,
  match: MatchingCommit,
  frozenPaths: readonly string[],
  git: LandedCommitGitOracle,
): Promise<boolean> {
  return samePathSet(await git.changedPaths(repositoryKey, match.parentOid, match.commitOid), frozenPaths);
}

export async function verifyLandedCommit(
  input: LandedCommitVerificationInput,
  git: LandedCommitGitOracle,
): Promise<LandedCommitVerification> {
  try {
    const scan = await scanMatchingCommits(input, git);
    if (scan.outcome === 'refused') return scan;
    if (scan.matches.length === 0) return { outcome: 'refused', reason: 'no-matching-commit' };
    if (scan.matches.length !== 1) return { outcome: 'refused', reason: 'multiple-matching-commits' };
    const match = scan.matches[0];
    if (input.commitOid !== match.commitOid) return { outcome: 'refused', reason: 'commit-oid-not-the-match' };
    if (!await changedPathsMatchFrozen(input.repositoryKey, match, input.frozenPaths, git)) {
      return { outcome: 'refused', reason: 'changed-paths-diverge' };
    }
    return { outcome: 'verified', ...match };
  } catch {
    return { outcome: 'refused', reason: 'branch-unresolvable' };
  }
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
      const parsed = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
        const index = line.indexOf(':');
        return { key: line.slice(0, index), value: line.slice(index + 1).trimStart() };
      });
      return parsed;
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
