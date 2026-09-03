import fs from 'node:fs';

export interface DevInstanceDiscovery {
  port: number;
  host: string;
  token: string;
  pid: number;
  userData: string;
  startedAt: string;
}

type DiscoveryFs = Pick<typeof fs, 'writeFileSync' | 'chmodSync' | 'unlinkSync'>;

export function writeDevInstanceDiscovery(
  file: string,
  discovery: DevInstanceDiscovery,
  fileSystem: DiscoveryFs = fs,
): void {
  fileSystem.writeFileSync(file, JSON.stringify(discovery), { encoding: 'utf8', mode: 0o600 });
  try {
    fileSystem.chmodSync(file, 0o600);
  } catch {
    // Windows and some mounted filesystems do not implement POSIX modes.
  }
}

export function removeDevInstanceDiscovery(file: string, fileSystem: DiscoveryFs = fs): void {
  try {
    fileSystem.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
