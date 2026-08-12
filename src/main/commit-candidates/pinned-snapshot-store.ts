import { createHash, randomUUID } from 'node:crypto';

import { canonicalize } from './jcs';

export type PinnedSnapshotStability = 'stable' | 'unstable';

export interface PinnedSnapshotDescriptor {
  snapshotId: string;
  boundaryInputFingerprint: string;
  repositoryKey: string;
  targetWorkspaceId: string;
  policyGeneration: number;
  pinnedHeadOid: string | null;
  indexFingerprint: string;
  scopePathspecBytes: string | null;
  boundaryInputs: {
    completeness: 'complete' | 'partial';
    stopReasons: readonly string[];
  };
  entries: readonly unknown[];
  grouping: readonly { saveUnitId: string; saveUnitKind: string; memberEntryIds: readonly string[] }[];
  intentUnits: readonly unknown[];
  fallbackUnits: readonly unknown[];
  componentEntryIds: Readonly<Record<string, readonly string[]>>;
  unattributedEntryIds: readonly string[];
  stability: PinnedSnapshotStability;
}

export interface PinnedSnapshotPublishOptions {
  retentionClass?: 'previous' | 'current' | 'finalization';
  /** A card snapshot protected by a finalization write. */
  sharedCardSnapshotId?: string;
}

export interface PinnedSnapshotStoreOptions {
  maxCount?: number;
  maxBytes?: number;
  estimateBytes?: (descriptor: PinnedSnapshotDescriptor) => number;
}

interface SnapshotRecord {
  descriptor: PinnedSnapshotDescriptor;
  bytes: number;
  retentionClass: 'previous' | 'current' | 'finalization';
  lastUsed: number;
  sequence: number;
}

export class PinnedSnapshotStore {
  private readonly records = new Map<string, SnapshotRecord>();
  private readonly maxCount: number;
  private readonly maxBytes: number;
  private readonly estimateBytes: (descriptor: PinnedSnapshotDescriptor) => number;
  private sequence = 0;

  constructor(options: PinnedSnapshotStoreOptions = {}) {
    this.maxCount = options.maxCount ?? 32;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.estimateBytes = options.estimateBytes ?? ((descriptor) =>
      Buffer.byteLength(JSON.stringify(descriptor, (_key, value) =>
        value === undefined ? null : value), 'utf8'));
  }

  publish(
    descriptor: Omit<PinnedSnapshotDescriptor, 'snapshotId' | 'boundaryInputFingerprint'> &
      Partial<Pick<PinnedSnapshotDescriptor, 'snapshotId' | 'boundaryInputFingerprint'>>,
    options: PinnedSnapshotPublishOptions = {},
  ): { snapshotId: string; boundaryInputFingerprint: string } {
    const fingerprint = descriptor.boundaryInputFingerprint ?? fingerprintFor(descriptor);
    const snapshotId = descriptor.snapshotId ?? randomUUID();
    const full = Object.freeze({
      ...descriptor,
      snapshotId,
      boundaryInputFingerprint: fingerprint,
      entries: Object.freeze([...descriptor.entries]),
      grouping: Object.freeze(descriptor.grouping.map((unit) => Object.freeze({
        ...unit, memberEntryIds: Object.freeze([...unit.memberEntryIds]),
      }))),
      intentUnits: Object.freeze([...descriptor.intentUnits]),
      fallbackUnits: Object.freeze([...descriptor.fallbackUnits]),
      unattributedEntryIds: Object.freeze([...descriptor.unattributedEntryIds]),
    }) as PinnedSnapshotDescriptor;
    const record: SnapshotRecord = {
      descriptor: full,
      bytes: this.estimateBytes(full),
      retentionClass: options.retentionClass ?? 'current',
      lastUsed: ++this.sequence,
      sequence: this.sequence,
    };
    this.records.set(snapshotId, record);
    this.enforceLimits(options.sharedCardSnapshotId);
    return { snapshotId, boundaryInputFingerprint: fingerprint };
  }

  resolve(snapshotId: string): PinnedSnapshotDescriptor | null {
    const record = this.records.get(snapshotId);
    if (!record) return null;
    record.lastUsed = ++this.sequence;
    return record.descriptor;
  }

  /** Record a finalization write without allowing it to evict the shared card pin. */
  writeFinalization(
    descriptor: Omit<PinnedSnapshotDescriptor, 'snapshotId' | 'boundaryInputFingerprint'> &
      Partial<Pick<PinnedSnapshotDescriptor, 'snapshotId' | 'boundaryInputFingerprint'>>,
    sharedCardSnapshotId: string,
  ): { snapshotId: string; boundaryInputFingerprint: string } {
    return this.publish(descriptor, { retentionClass: 'finalization', sharedCardSnapshotId });
  }

  has(snapshotId: string): boolean { return this.records.has(snapshotId); }
  get byteSize(): number { return [...this.records.values()].reduce((n, r) => n + r.bytes, 0); }
  get size(): number { return this.records.size; }

  private enforceLimits(protectedId?: string): void {
    while (this.records.size > this.maxCount || this.byteSize > this.maxBytes) {
      const candidates = [...this.records.values()]
        .filter((record) => record.descriptor.snapshotId !== protectedId)
        .sort((a, b) => {
          const rank = (value: SnapshotRecord['retentionClass']) => value === 'previous' ? 0 : value === 'current' ? 1 : 2;
          return rank(a.retentionClass) - rank(b.retentionClass) || a.lastUsed - b.lastUsed;
        });
      const victim = candidates[0];
      if (!victim) break;
      this.records.delete(victim.descriptor.snapshotId);
    }
  }
}

export function fingerprintFor(value: unknown): string {
  // Test/legacy projections may omit optional fields. JCS intentionally rejects
  // undefined, so normalize only for the digest; the retained descriptor stays
  // byte-for-byte faithful to the producer's shape.
  const normalized = JSON.parse(JSON.stringify(value, (_key, item) =>
    item === undefined ? null : item));
  return createHash('sha256').update(canonicalize(normalized), 'utf8').digest('hex');
}
