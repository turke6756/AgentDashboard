// Pure signal evaluation for the external Lares watchdog.
//
// This is observability, not protection: an in-process timer cannot rescue a
// starved Electron main process. The caller is deliberately a separate Node
// process (scripts/lares-watchdog.mjs).

export const TELEMETRY_CADENCE_MS = 15_000;
export const DEFAULT_HEARTBEAT_GAP_MS = TELEMETRY_CADENCE_MS * 4;
export const DEFAULT_RSS_THRESHOLD_BYTES = 3 * 1024 ** 3;
export const DEFAULT_RSS_SUSTAIN_SAMPLES = 3;

export interface WatchdogSample {
  /** Epoch timestamp for either a telemetry heartbeat or an external RSS poll. */
  timestampMs: number;
  /** Main-process resident set measured by the external watcher, in bytes. */
  rssBytes?: number;
}

export interface WatchdogThresholds {
  heartbeatGapMs?: number;
  rssThresholdBytes?: number;
  rssSustainSamples?: number;
}

export interface WatchdogSignal {
  kind: 'heartbeat-gap' | 'rss-threshold';
  observed: number;
  threshold: number;
  message: string;
}

export interface WatchdogEvaluation {
  tripped: boolean;
  signals: WatchdogSignal[];
  latestHeartbeatMs: number | null;
  heartbeatGapMs: number | null;
  consecutiveHighRssSamples: number;
}

export interface WatchdogEvaluationInput {
  nowMs: number;
  telemetrySamples: readonly WatchdogSample[];
  rssSamples: readonly WatchdogSample[];
  thresholds?: WatchdogThresholds;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Evaluate watchdog state with no I/O or retained state.
 *
 * A heartbeat trip means the latest usable telemetry heartbeat is at least
 * four normal 15 s cadences old by default. RSS trips only when the most recent
 * N external polls are all at/above the threshold, avoiding a one-poll spike.
 * No telemetry yet is quiet rather than an incident: the watcher may start
 * before Lares creates its log.
 */
export function evaluateWatchdogSignals(input: WatchdogEvaluationInput): WatchdogEvaluation {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : 0;
  const heartbeatGapThreshold = positiveOrDefault(
    input.thresholds?.heartbeatGapMs,
    DEFAULT_HEARTBEAT_GAP_MS,
  );
  const rssThreshold = positiveOrDefault(
    input.thresholds?.rssThresholdBytes,
    DEFAULT_RSS_THRESHOLD_BYTES,
  );
  const rssSustainSamples = Math.max(1, Math.floor(positiveOrDefault(
    input.thresholds?.rssSustainSamples,
    DEFAULT_RSS_SUSTAIN_SAMPLES,
  )));

  const heartbeatTimes = input.telemetrySamples
    .map((sample) => sample.timestampMs)
    .filter((timestampMs) => Number.isFinite(timestampMs) && timestampMs <= nowMs);
  const latestHeartbeatMs = heartbeatTimes.length > 0 ? Math.max(...heartbeatTimes) : null;
  const heartbeatGapMs = latestHeartbeatMs === null ? null : nowMs - latestHeartbeatMs;

  const usableRss = input.rssSamples
    .filter((sample) => Number.isFinite(sample.timestampMs)
      && sample.timestampMs <= nowMs
      && typeof sample.rssBytes === 'number'
      && Number.isFinite(sample.rssBytes)
      && sample.rssBytes >= 0)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  let consecutiveHighRssSamples = 0;
  for (let i = usableRss.length - 1; i >= 0; i--) {
    if ((usableRss[i].rssBytes as number) < rssThreshold) break;
    consecutiveHighRssSamples++;
  }

  const signals: WatchdogSignal[] = [];
  if (heartbeatGapMs !== null && heartbeatGapMs >= heartbeatGapThreshold) {
    signals.push({
      kind: 'heartbeat-gap',
      observed: heartbeatGapMs,
      threshold: heartbeatGapThreshold,
      message: `Telemetry heartbeat gap ${heartbeatGapMs} ms exceeded ${heartbeatGapThreshold} ms`,
    });
  }
  if (consecutiveHighRssSamples >= rssSustainSamples) {
    const observed = usableRss[usableRss.length - 1].rssBytes as number;
    signals.push({
      kind: 'rss-threshold',
      observed,
      threshold: rssThreshold,
      message: `Main-process RSS ${observed} bytes remained at/above ${rssThreshold} bytes for ${consecutiveHighRssSamples} polls`,
    });
  }

  return {
    tripped: signals.length > 0,
    signals,
    latestHeartbeatMs,
    heartbeatGapMs,
    consecutiveHighRssSamples,
  };
}
