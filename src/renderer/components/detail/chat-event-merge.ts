import type { SessionEvent } from '../../../shared/session-events';

/** Merge chat snapshots and live pushes without rendering the same event twice. */
export function mergeChatEvents(
  earlier: readonly SessionEvent[],
  later: readonly SessionEvent[],
): SessionEvent[] {
  const seen = new Set<string>();
  const merged: SessionEvent[] = [];
  for (const event of [...earlier, ...later]) {
    if (seen.has(event.uuid)) continue;
    seen.add(event.uuid);
    merged.push(event);
  }
  return merged;
}
