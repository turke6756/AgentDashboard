// Entering tests for the pure external-watchdog decision seam.
//   npx tsc -p tsconfig.main.json
//   node dist/main/main/watchdog/watchdog-logic.test.js

import assert from 'node:assert/strict';
import {
  DEFAULT_HEARTBEAT_GAP_MS,
  evaluateWatchdogSignals,
  type WatchdogSample,
} from './watchdog-logic';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, run: () => void): void { tests.push({ name, run }); }

const NOW = Date.parse('2026-08-10T12:00:00.000Z');
const heartbeat = (ageMs: number): WatchdogSample => ({ timestampMs: NOW - ageMs });
const rss = (ageMs: number, rssBytes: number): WatchdogSample => ({
  timestampMs: NOW - ageMs,
  rssBytes,
});

test('steady telemetry cadence and ordinary RSS remain quiet', () => {
  const result = evaluateWatchdogSignals({
    nowMs: NOW,
    telemetrySamples: [heartbeat(15_000)],
    rssSamples: [rss(10_000, 800), rss(5_000, 900), rss(0, 1_000)],
    thresholds: { rssThresholdBytes: 2_000, rssSustainSamples: 3 },
  });
  assert.equal(result.tripped, false);
  assert.deepEqual(result.signals, []);
  assert.equal(result.heartbeatGapMs, 15_000);
});

test('four missed 15 second cadences trip the heartbeat-gap signal', () => {
  const result = evaluateWatchdogSignals({
    nowMs: NOW,
    telemetrySamples: [heartbeat(DEFAULT_HEARTBEAT_GAP_MS)],
    rssSamples: [],
  });
  assert.equal(result.tripped, true, 'REACHABILITY:external-watchdog-logic');
  assert.equal(result.signals[0]?.kind, 'heartbeat-gap');
  assert.equal(result.signals[0]?.observed, DEFAULT_HEARTBEAT_GAP_MS);
});

test('a gap below the configured boundary is quiet', () => {
  const result = evaluateWatchdogSignals({
    nowMs: NOW,
    telemetrySamples: [heartbeat(59_999)],
    rssSamples: [],
    thresholds: { heartbeatGapMs: 60_000 },
  });
  assert.equal(result.tripped, false);
});

test('RSS must remain high for the configured number of latest polls', () => {
  const thresholds = { rssThresholdBytes: 1_000, rssSustainSamples: 3 };
  const oneSpike = evaluateWatchdogSignals({
    nowMs: NOW,
    telemetrySamples: [heartbeat(0)],
    rssSamples: [rss(10_000, 900), rss(5_000, 900), rss(0, 1_500)],
    thresholds,
  });
  assert.equal(oneSpike.tripped, false);
  assert.equal(oneSpike.consecutiveHighRssSamples, 1);

  const sustained = evaluateWatchdogSignals({
    nowMs: NOW,
    telemetrySamples: [heartbeat(0)],
    rssSamples: [rss(10_000, 1_000), rss(5_000, 1_100), rss(0, 1_200)],
    thresholds,
  });
  assert.equal(sustained.tripped, true);
  assert.equal(sustained.signals[0]?.kind, 'rss-threshold');
  assert.equal(sustained.consecutiveHighRssSamples, 3);
});

test('a recent recovery resets sustained high RSS', () => {
  const result = evaluateWatchdogSignals({
    nowMs: NOW,
    telemetrySamples: [heartbeat(0)],
    rssSamples: [rss(10_000, 1_100), rss(5_000, 1_100), rss(0, 999)],
    thresholds: { rssThresholdBytes: 1_000, rssSustainSamples: 2 },
  });
  assert.equal(result.tripped, false);
  assert.equal(result.consecutiveHighRssSamples, 0);
});

test('no telemetry yet is quiet so the watcher can start before the app', () => {
  const result = evaluateWatchdogSignals({
    nowMs: NOW,
    telemetrySamples: [],
    rssSamples: [],
  });
  assert.equal(result.tripped, false);
  assert.equal(result.latestHeartbeatMs, null);
  assert.equal(result.heartbeatGapMs, null);
});

let failures = 0;
for (const entry of tests) {
  try {
    entry.run();
    console.log(`ok - ${entry.name}`);
  } catch (error) {
    failures++;
    console.error(`not ok - ${entry.name}`);
    console.error(error);
  }
}
if (failures > 0) process.exitCode = 1;
else console.log(`watchdog-logic: ${tests.length} tests passed`);
