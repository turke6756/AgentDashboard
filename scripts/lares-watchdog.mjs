#!/usr/bin/env node
// External Lares main-process watchdog. This is observability, not protection:
// it cannot restart or heal the app, and intentionally has no in-process hook.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  DEFAULT_HEARTBEAT_GAP_MS,
  DEFAULT_RSS_SUSTAIN_SAMPLES,
  DEFAULT_RSS_THRESHOLD_BYTES,
  evaluateWatchdogSignals,
} = require('../dist/main/main/watchdog/watchdog-logic.js');

const MAX_INITIAL_TAIL_BYTES = 256 * 1024;
const MAX_RETAINED_RECORDS = 128;

function usage(message) {
  if (message) console.error(message);
  console.error('usage: npm run watchdog -- [telemetry.jsonl] [--pid PID] [--once]');
  console.error('       [--poll-ms N] [--gap-ms N] [--rss-mb N] [--rss-samples N]');
  process.exit(2);
}

function positiveNumber(raw, flag) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) usage(`${flag} requires a positive number`);
  return value;
}

function parseArgs(argv) {
  const options = {
    telemetryPath: null,
    pid: null,
    once: false,
    pollMs: 5_000,
    heartbeatGapMs: DEFAULT_HEARTBEAT_GAP_MS,
    rssThresholdBytes: DEFAULT_RSS_THRESHOLD_BYTES,
    rssSustainSamples: DEFAULT_RSS_SUSTAIN_SAMPLES,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once') options.once = true;
    else if (arg === '--pid') options.pid = Math.floor(positiveNumber(argv[++i], arg));
    else if (arg === '--poll-ms') options.pollMs = positiveNumber(argv[++i], arg);
    else if (arg === '--gap-ms') options.heartbeatGapMs = positiveNumber(argv[++i], arg);
    else if (arg === '--rss-mb') options.rssThresholdBytes = positiveNumber(argv[++i], arg) * 1024 ** 2;
    else if (arg === '--rss-samples') options.rssSustainSamples = Math.floor(positiveNumber(argv[++i], arg));
    else if (arg.startsWith('-')) usage(`unknown option: ${arg}`);
    else if (options.telemetryPath === null) options.telemetryPath = path.resolve(arg);
    else usage(`unexpected argument: ${arg}`);
  }
  return options;
}

function defaultTelemetryPath() {
  const appData = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library', 'Application Support')
      : path.join(process.env.HOME || '', '.config'));
  for (const name of ['lares-app', 'agent-dashboard', 'AgentDashboard', 'Lares', 'lares']) {
    const candidate = path.join(appData, name, 'logs', 'heap-telemetry.jsonl');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

class JsonlTail {
  constructor(filePath) {
    this.filePath = filePath;
    this.offset = null;
    this.partial = '';
  }

  readNewRecords() {
    if (!existsSync(this.filePath)) return [];
    const size = statSync(this.filePath).size;
    let discardFirstPartial = false;
    if (this.offset === null) {
      this.offset = Math.max(0, size - MAX_INITIAL_TAIL_BYTES);
      discardFirstPartial = this.offset > 0;
    } else if (size < this.offset) {
      // The telemetry writer rotated/truncated the file.
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) return [];

    const length = size - this.offset;
    const buffer = Buffer.allocUnsafe(length);
    const fd = openSync(this.filePath, 'r');
    try {
      readSync(fd, buffer, 0, length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    let text = this.partial + buffer.toString('utf8');
    if (discardFirstPartial) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : '';
    }
    const lines = text.split('\n');
    this.partial = lines.pop() || '';
    const records = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record === 'object') records.push(record);
      } catch {
        // A torn/malformed line is not a watcher failure; wait for later data.
      }
    }
    return records;
  }
}

function processRssBytes(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 4_000 });
      const value = Number(output.trim());
      return Number.isFinite(value) ? value : null;
    }
    if (process.platform === 'linux' && existsSync(`/proc/${pid}/statm`)) {
      const pages = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8', timeout: 2_000 }).trim());
      const statm = require('node:fs').readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(/\s+/);
      const residentPages = Number(statm[1]);
      return Number.isFinite(pages * residentPages) ? pages * residentPages : null;
    }
    const kib = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 }).trim());
    return Number.isFinite(kib) ? kib * 1024 : null;
  } catch {
    return null;
  }
}

function timestampFor(record) {
  return typeof record.t === 'string' ? Date.parse(record.t) : NaN;
}

function browserPidFrom(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].kind !== 'processes' || !Array.isArray(records[i].procs)) continue;
    const main = records[i].procs.find((proc) => proc?.type === 'Browser' && Number.isInteger(proc.pid));
    if (main) return main.pid;
  }
  return null;
}

function safeStamp(iso) {
  return iso.replaceAll(':', '-').replaceAll('.', '-');
}

function captureHeapSummary(telemetryPath, pid, evaluation, recentRecords, rssSamples) {
  const directory = path.join(path.dirname(telemetryPath), 'watchdog-snapshots');
  mkdirSync(directory, { recursive: true });
  const capturedAt = new Date().toISOString();
  const snapshotPath = path.join(directory, `heap-summary-${safeStamp(capturedAt)}.json`);
  const summary = {
    kind: 'lares-external-watchdog-heap-summary',
    capturedAt,
    telemetryPath,
    pid,
    evaluation,
    latestExternalRss: rssSamples.at(-1) || null,
    recentTelemetry: recentRecords.slice(-64),
    note: 'External observability snapshot; the watchdog does not restart or heal Lares.',
  };
  writeFileSync(snapshotPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return snapshotPath;
}

function alertLocally(telemetryPath, evaluation, snapshotPath) {
  const line = JSON.stringify({
    kind: 'lares-watchdog-alert',
    t: new Date().toISOString(),
    signals: evaluation.signals,
    snapshotPath,
  });
  const alertPath = path.join(path.dirname(telemetryPath), 'watchdog-alerts.log');
  appendFileSync(alertPath, `${line}\n`, 'utf8');
  console.error(`[lares-watchdog] TRIPPED: ${evaluation.signals.map((signal) => signal.message).join('; ')}`);
  console.error(`[lares-watchdog] diagnostic snapshot: ${snapshotPath}`);
  console.error(`[lares-watchdog] local alert log: ${alertPath}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.telemetryPath ||= defaultTelemetryPath();
  if (!options.telemetryPath) usage('no telemetry path supplied and no live Lares telemetry file was found');

  const tail = new JsonlTail(options.telemetryPath);
  const telemetrySamples = [];
  const rssSamples = [];
  const recentRecords = [];
  let inferredPid = options.pid;
  let incidentActive = false;

  const tick = () => {
    const records = tail.readNewRecords();
    recentRecords.push(...records);
    if (recentRecords.length > MAX_RETAINED_RECORDS) {
      recentRecords.splice(0, recentRecords.length - MAX_RETAINED_RECORDS);
    }
    for (const record of records) {
      // Old records without a kind are heap records for backward compatibility.
      if (record.kind === 'heap' || !record.kind) {
        const timestampMs = timestampFor(record);
        if (Number.isFinite(timestampMs)) telemetrySamples.push({ timestampMs });
      }
    }
    if (!options.pid) inferredPid = browserPidFrom(recentRecords) || inferredPid;
    const nowMs = Date.now();
    const rssBytes = processRssBytes(inferredPid);
    if (rssBytes !== null) rssSamples.push({ timestampMs: nowMs, rssBytes });
    if (telemetrySamples.length > MAX_RETAINED_RECORDS) telemetrySamples.splice(0, telemetrySamples.length - MAX_RETAINED_RECORDS);
    if (rssSamples.length > MAX_RETAINED_RECORDS) rssSamples.splice(0, rssSamples.length - MAX_RETAINED_RECORDS);

    const evaluation = evaluateWatchdogSignals({
      nowMs,
      telemetrySamples,
      rssSamples,
      thresholds: {
        heartbeatGapMs: options.heartbeatGapMs,
        rssThresholdBytes: options.rssThresholdBytes,
        rssSustainSamples: options.rssSustainSamples,
      },
    });
    if (evaluation.tripped && !incidentActive) {
      const snapshotPath = captureHeapSummary(options.telemetryPath, inferredPid, evaluation, recentRecords, rssSamples);
      alertLocally(options.telemetryPath, evaluation, snapshotPath);
    }
    incidentActive = evaluation.tripped;
    if (options.once) {
      if (!evaluation.tripped) {
        console.log(`[lares-watchdog] quiet: ${options.telemetryPath}; pid=${inferredPid ?? 'not-yet-observed'}`);
      }
      return evaluation.tripped ? 2 : 0;
    }
    return null;
  };

  console.log(`[lares-watchdog] watching ${options.telemetryPath} every ${options.pollMs} ms`);
  const firstResult = tick();
  if (firstResult !== null) {
    process.exitCode = firstResult;
    return;
  }
  const timer = setInterval(() => {
    try { tick(); }
    catch (error) { console.error('[lares-watchdog] poll failed:', error); }
  }, options.pollMs);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      clearInterval(timer);
      console.log('[lares-watchdog] stopped');
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('[lares-watchdog] fatal:', error);
    process.exitCode = 1;
  });
}
