import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SCRATCH_POLICY_SCHEMA_VERSION = 1 as const;
export const LARES_SCRATCH_SENTINEL = '.lares-scratch.json';

export type ScratchDisposition = 'disposable' | 'review-before-sweep';

export interface ScratchSentinel {
  schemaVersion: 1;
  creator: string;
  workPackage: string;
  disposition: ScratchDisposition;
  creationId: string;
}

export interface RawPathExclusion {
  encoding: 'base64';
  value: string;
}

export interface MarkedScratchRegistration extends ScratchSentinel {
  canonicalRoot: string;
}

export type OnboardingDecision = 'exclude-selected' | 'keep-everything' | 'decide-later';

export interface OnboardingProjection {
  workspaceKey: string;
  decision: OnboardingDecision;
  policyGeneration: number;
  schemaVersion: 1;
  recommendationFingerprint?: string;
}

export interface ScratchPolicyRecord {
  schemaVersion: 1;
  repositoryKey: string;
  policyGeneration: number;
  exclusions: RawPathExclusion[];
  registrations: MarkedScratchRegistration[];
  onboardingProjections: OnboardingProjection[];
}

export interface RegisterScratchInput extends Omit<ScratchSentinel, 'schemaVersion'> {
  repositoryKey: string;
  repositoryRoot: string;
  scratchRoot: string;
}

export interface MarkedMemberInput {
  repositoryKey: string;
  repositoryRoot: string;
  memberPath: string;
  tracked: boolean;
}

export type MarkedMemberDecision =
  | { exclude: true; registration: MarkedScratchRegistration }
  | { exclude: false; reason: 'tracked' | 'unregistered' | 'invalid-sentinel' | 'unsafe-path' };

function emptyRecord(repositoryKey: string): ScratchPolicyRecord {
  return {
    schemaVersion: SCRATCH_POLICY_SCHEMA_VERSION,
    repositoryKey,
    policyGeneration: 0,
    exclusions: [],
    registrations: [],
    onboardingProjections: [],
  };
}

function isDisposition(value: unknown): value is ScratchDisposition {
  return value === 'disposable' || value === 'review-before-sweep';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseSentinel(value: unknown): ScratchSentinel | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ScratchSentinel>;
  if (
    candidate.schemaVersion !== SCRATCH_POLICY_SCHEMA_VERSION
    || !isNonEmptyString(candidate.creator)
    || !isNonEmptyString(candidate.workPackage)
    || !isDisposition(candidate.disposition)
    || !isNonEmptyString(candidate.creationId)
  ) return null;
  return {
    schemaVersion: SCRATCH_POLICY_SCHEMA_VERSION,
    creator: candidate.creator,
    workPackage: candidate.workPackage,
    disposition: candidate.disposition,
    creationId: candidate.creationId,
  };
}

function assertPolicyRecord(value: unknown, repositoryKey: string): asserts value is ScratchPolicyRecord {
  if (!value || typeof value !== 'object') throw new Error('Scratch policy record must be a JSON object.');
  const record = value as Partial<ScratchPolicyRecord>;
  if (record.schemaVersion !== SCRATCH_POLICY_SCHEMA_VERSION) {
    throw new Error(`Unsupported scratch policy schema: ${String(record.schemaVersion)}`);
  }
  if (record.repositoryKey !== repositoryKey) throw new Error('Scratch policy repositoryKey mismatch.');
  if (!Number.isSafeInteger(record.policyGeneration) || (record.policyGeneration ?? -1) < 0) {
    throw new Error('Scratch policyGeneration must be a non-negative safe integer.');
  }
  if (!Array.isArray(record.exclusions) || !record.exclusions.every((item) =>
    item && item.encoding === 'base64' && typeof item.value === 'string')) {
    throw new Error('Scratch policy exclusions must be base64-encoded raw paths.');
  }
  if (!Array.isArray(record.registrations) || !record.registrations.every((item) =>
    parseSentinel(item) !== null && isNonEmptyString(item.canonicalRoot))) {
    throw new Error('Scratch policy registrations are invalid.');
  }
  if (!Array.isArray(record.onboardingProjections) || !record.onboardingProjections.every((item) =>
    item && isNonEmptyString(item.workspaceKey)
    && (item.decision === 'exclude-selected' || item.decision === 'keep-everything' || item.decision === 'decide-later')
    && item.schemaVersion === SCRATCH_POLICY_SCHEMA_VERSION
    && Number.isSafeInteger(item.policyGeneration))) {
    throw new Error('Scratch policy onboarding projections are invalid.');
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32'
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
  return normalize(left) === normalize(right);
}

function isContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function hasLinkComponent(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (!relative) return false;
  let cursor = parent;
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor);
    // On Windows, directory junctions are reported by Node as symbolic links.
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

function safeCanonicalContained(repositoryRoot: string, target: string): string | null {
  try {
    const canonicalRepository = fs.realpathSync.native(path.resolve(repositoryRoot));
    const resolvedTarget = path.resolve(target);
    if (!isContained(canonicalRepository, resolvedTarget)) return null;
    if (hasLinkComponent(canonicalRepository, resolvedTarget)) return null;
    const canonicalTarget = fs.realpathSync.native(resolvedTarget);
    // A canonical target that differs from the route supplied to lstat crossed a
    // reparse point even if the host did not expose it as isSymbolicLink().
    if (!samePath(resolvedTarget, canonicalTarget)) return null;
    return isContained(canonicalRepository, canonicalTarget) ? canonicalTarget : null;
  } catch {
    return null;
  }
}

function sentinelMatches(left: ScratchSentinel, right: ScratchSentinel): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.creator === right.creator
    && left.workPackage === right.workPackage
    && left.disposition === right.disposition
    && left.creationId === right.creationId;
}

function readSentinel(canonicalRoot: string): ScratchSentinel | null {
  const sentinelPath = path.join(canonicalRoot, LARES_SCRATCH_SENTINEL);
  try {
    if (fs.lstatSync(sentinelPath).isSymbolicLink()) return null;
    return parseSentinel(JSON.parse(fs.readFileSync(sentinelPath, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * App-owned repository policy authority. Callers supply an installation/user-data
 * directory, never a workspace directory; records are selected solely by
 * repositoryKey so workspace aliases cannot acquire divergent policy files.
 */
export class ScratchPolicyStore {
  constructor(private readonly storageDirectory: string) {}

  read(repositoryKey: string): ScratchPolicyRecord {
    const recordPath = this.recordPath(repositoryKey);
    if (!fs.existsSync(recordPath)) return emptyRecord(repositoryKey);
    const parsed: unknown = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assertPolicyRecord(parsed, repositoryKey);
    return structuredClone(parsed);
  }

  setExclusions(repositoryKey: string, rawPaths: readonly Buffer[]): ScratchPolicyRecord {
    const record = this.read(repositoryKey);
    const values = [...new Set(rawPaths.map((rawPath) => rawPath.toString('base64')))].sort();
    record.exclusions = values.map((value) => ({ encoding: 'base64', value }));
    record.policyGeneration++;
    return this.write(record);
  }

  registerMarkedScratch(input: RegisterScratchInput): ScratchPolicyRecord {
    const canonicalRoot = safeCanonicalContained(input.repositoryRoot, input.scratchRoot);
    if (!canonicalRoot) throw new Error('Scratch root is outside the repository or crosses a symlink/reparse point.');
    const sentinel = readSentinel(canonicalRoot);
    const expected: ScratchSentinel = {
      schemaVersion: SCRATCH_POLICY_SCHEMA_VERSION,
      creator: input.creator,
      workPackage: input.workPackage,
      disposition: input.disposition,
      creationId: input.creationId,
    };
    if (!sentinel || !sentinelMatches(sentinel, expected)) {
      throw new Error('Scratch sentinel is missing, invalid, or does not match the registration.');
    }

    const record = this.read(input.repositoryKey);
    const registration: MarkedScratchRegistration = { ...expected, canonicalRoot };
    record.registrations = record.registrations.filter((item) => !samePath(item.canonicalRoot, canonicalRoot));
    record.registrations.push(registration);
    record.policyGeneration++;
    return this.write(record);
  }

  setOnboardingProjection(
    repositoryKey: string,
    workspaceKey: string,
    decision: OnboardingDecision,
    recommendationFingerprint?: string,
  ): ScratchPolicyRecord {
    const record = this.read(repositoryKey);
    const projection: OnboardingProjection = {
      workspaceKey,
      decision,
      policyGeneration: record.policyGeneration,
      schemaVersion: SCRATCH_POLICY_SCHEMA_VERSION,
      ...(recommendationFingerprint ? { recommendationFingerprint } : {}),
    };
    record.onboardingProjections = record.onboardingProjections.filter((item) => item.workspaceKey !== workspaceKey);
    record.onboardingProjections.push(projection);
    return this.write(record);
  }

  evaluateMarkedMember(input: MarkedMemberInput): MarkedMemberDecision {
    if (input.tracked) return { exclude: false, reason: 'tracked' };
    const canonicalRepository = safeCanonicalContained(input.repositoryRoot, input.repositoryRoot);
    const canonicalMember = safeCanonicalContained(input.repositoryRoot, input.memberPath);
    if (!canonicalRepository || !canonicalMember) return { exclude: false, reason: 'unsafe-path' };

    const record = this.read(input.repositoryKey);
    const registration = record.registrations.find((item) => isContained(item.canonicalRoot, canonicalMember));
    if (!registration) return { exclude: false, reason: 'unregistered' };
    const canonicalRoot = safeCanonicalContained(canonicalRepository, registration.canonicalRoot);
    if (!canonicalRoot || !samePath(canonicalRoot, registration.canonicalRoot)) {
      return { exclude: false, reason: 'unsafe-path' };
    }
    const sentinel = readSentinel(canonicalRoot);
    if (!sentinel || !sentinelMatches(sentinel, registration)) {
      return { exclude: false, reason: 'invalid-sentinel' };
    }
    return { exclude: true, registration };
  }

  private recordPath(repositoryKey: string): string {
    const name = createHash('sha256').update(repositoryKey, 'utf8').digest('hex');
    return path.join(this.storageDirectory, `${name}.json`);
  }

  private write(record: ScratchPolicyRecord): ScratchPolicyRecord {
    fs.mkdirSync(this.storageDirectory, { recursive: true });
    const target = this.recordPath(record.repositoryKey);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, target);
    return structuredClone(record);
  }
}
