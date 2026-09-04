import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export const WSL_DISABLED_MESSAGE = 'WSL is disabled in Lares';

let cachedEnabled: boolean | null = null;
let storagePathOverride: string | null = null;

function settingsFile(): string {
  return storagePathOverride ?? path.join(app.getPath('userData'), 'wsl-enabled.json');
}

/** Read the app-level WSL preference. First run and unreadable files default on. */
export function isWslEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    if (typeof raw?.enabled === 'boolean') {
      cachedEnabled = raw.enabled;
      return raw.enabled;
    }
  } catch { /* first run or unreadable -- default enabled */ }
  cachedEnabled = true;
  return true;
}

/** Persist the preference without ever making settings I/O fatal to the app. */
export function setWslEnabled(enabled: boolean): void {
  cachedEnabled = Boolean(enabled);
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify({ enabled: cachedEnabled }), 'utf8');
  } catch (err) {
    console.error('Failed to persist WSL enabled setting:', err);
  }
}

export function assertWslEnabled(): void {
  if (!isWslEnabled()) throw new Error(WSL_DISABLED_MESSAGE);
}

/** Test-only storage seam. Null restores production userData resolution. */
export function __setWslEnabledStoragePathForTest(filePath: string | null): void {
  storagePathOverride = filePath;
  cachedEnabled = null;
}

/** Test-only cache seam for callers that must prove a no-spawn short circuit. */
export function __setWslEnabledForTest(enabled: boolean | null): void {
  cachedEnabled = enabled;
}
