import { canonicalize } from './jcs';
import {
  PinnedSnapshotStore,
  type PinnedSnapshotDescriptor,
  type PinnedSnapshotStability,
} from './pinned-snapshot-store';

export interface BuildPinnedSnapshotOptions<T extends Omit<PinnedSnapshotDescriptor, 'snapshotId' | 'boundaryInputFingerprint'>> {
  assemble: () => Promise<T> | T;
  identityBefore?: () => Promise<unknown> | unknown;
  identityAfter?: () => Promise<unknown> | unknown;
  store: PinnedSnapshotStore;
}

export async function buildPinnedSnapshot<
  T extends Omit<PinnedSnapshotDescriptor, 'snapshotId' | 'boundaryInputFingerprint'>,
>({ assemble, identityBefore, identityAfter, store }: BuildPinnedSnapshotOptions<T>): Promise<PinnedSnapshotDescriptor> {
  const before = identityBefore ? await identityBefore() : undefined;
  const assembled = await assemble();
  const after = identityAfter ? await identityAfter() : before;
  const stable = before === undefined && after === undefined
    ? true
    : canonicalize(before) === canonicalize(after);
  const descriptor = {
    ...assembled,
    stability: (stable ? assembled.stability : 'unstable') as PinnedSnapshotStability,
  };
  const handle = store.publish(descriptor);
  return store.resolve(handle.snapshotId)!;
}
