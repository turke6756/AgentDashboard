import fs from 'node:fs';

export interface DevInstanceDiscovery {
  port: number;
  host: string;
  token: string;
  pid: number;
  userData: string;
  startedAt: string;
}

interface DiscoveryFs {
  readFileSync(file: string, encoding: 'utf8'): string;
  writeFileSync(file: string, data: string, options: { encoding: 'utf8'; mode: number }): void;
  chmodSync(file: string, mode: number): void;
  unlinkSync(file: string): void;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writeDevInstanceDiscovery(
  file: string,
  discovery: DevInstanceDiscovery,
  fileSystem: DiscoveryFs = fs,
  pidIsAlive: (pid: number) => boolean = isProcessAlive,
): void {
  try {
    const existing = JSON.parse(fileSystem.readFileSync(file, 'utf8')) as Partial<DevInstanceDiscovery>;
    if (typeof existing.pid === 'number' && existing.pid !== process.pid && pidIsAlive(existing.pid)) {
      console.warn(`[dev-instance] refusing to overwrite live discovery record for pid ${existing.pid}`);
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  fileSystem.writeFileSync(file, JSON.stringify(discovery), { encoding: 'utf8', mode: 0o600 });
  try {
    fileSystem.chmodSync(file, 0o600);
  } catch {
    // Windows and some mounted filesystems do not implement POSIX modes.
  }
}

export function removeDevInstanceDiscovery(
  file: string,
  expectedPid: number = process.pid,
  fileSystem: DiscoveryFs = fs,
): void {
  try {
    const existing = JSON.parse(fileSystem.readFileSync(file, 'utf8')) as Partial<DevInstanceDiscovery>;
    if (existing.pid !== expectedPid) return;
    fileSystem.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
}
