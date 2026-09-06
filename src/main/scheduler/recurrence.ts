import type { RecurrenceRule } from '../../shared/schedule-types';

const MINUTE_MS = 60_000;

function nextLocalDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 12);
}

export function resolveLocalDailySlot(date: Date, atMinuteOfDay: number): number {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const start = new Date(year, month, day, 0, 0, 0, 0).getTime();
  const end = new Date(year, month, day + 1, 0, 0, 0, 0).getTime();

  // Walk actual instants in chronological order. On a gap the first local minute
  // at or after the requested minute is the next valid instant; on an overlap
  // the first matching minute is therefore the first occurrence only.
  for (let epochMs = start; epochMs < end; epochMs += MINUTE_MS) {
    const local = new Date(epochMs);
    if (
      local.getFullYear() === year &&
      local.getMonth() === month &&
      local.getDate() === day &&
      local.getHours() * 60 + local.getMinutes() >= atMinuteOfDay
    ) {
      return epochMs;
    }
  }

  throw new RangeError('local calendar date has no valid instant');
}

export function computeNextFireAt(
  recurrence: RecurrenceRule,
  priorNextFireAt: number,
  nowEpochMs: number,
): number {
  if (recurrence.kind === 'interval') {
    let nextFireAt = priorNextFireAt + recurrence.everyMs;
    while (nextFireAt <= nowEpochMs) {
      nextFireAt += recurrence.everyMs;
    }
    return nextFireAt;
  }

  let localDate = nextLocalDate(new Date(priorNextFireAt));
  let nextFireAt = resolveLocalDailySlot(localDate, recurrence.atMinuteOfDay);
  while (nextFireAt <= nowEpochMs) {
    localDate = nextLocalDate(localDate);
    nextFireAt = resolveLocalDailySlot(localDate, recurrence.atMinuteOfDay);
  }
  return nextFireAt;
}

export function firstFutureDailySlot(nowEpochMs: number, atMinuteOfDay: number): number {
  const todaySlot = resolveLocalDailySlot(new Date(nowEpochMs), atMinuteOfDay);
  if (todaySlot > nowEpochMs) return todaySlot;
  return computeNextFireAt({ kind: 'daily', atMinuteOfDay }, todaySlot, nowEpochMs);
}

export interface UntilBoundaryResult {
  claimable: boolean;
  nextFireAt: number | null;
  exhausted: boolean;
}

export function evaluateUntilBoundary(
  dueAt: number,
  nextFireAt: number,
  endAtEpochMs: number,
): UntilBoundaryResult {
  if (dueAt > endAtEpochMs) {
    return { claimable: false, nextFireAt: null, exhausted: true };
  }
  if (nextFireAt > endAtEpochMs) {
    return { claimable: true, nextFireAt: null, exhausted: true };
  }
  return { claimable: true, nextFireAt, exhausted: false };
}
