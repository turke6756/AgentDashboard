import type { App } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { devProfileDirName, isDevInstance } from './dev-instance';

export type BootstrapFileSystem = Pick<typeof fs, 'mkdirSync'>;

export function applyDevInstanceProfile(
  electronApp: Pick<App, 'getPath' | 'setPath'>,
  fileSystem: BootstrapFileSystem,
): void {
  if (isDevInstance()) {
    const profileDir = path.join(electronApp.getPath('appData'), devProfileDirName());
    fileSystem.mkdirSync(profileDir, { recursive: true });
    electronApp.setPath('userData', profileDir);
    electronApp.setPath('sessionData', profileDir);
  }
}

export function bootstrapMain(
  electronApp: Pick<App, 'getPath' | 'setPath'>,
  fileSystem: BootstrapFileSystem,
  loadMain: () => void,
): void {
  applyDevInstanceProfile(electronApp, fileSystem);
  loadMain();
}

if ((process as NodeJS.Process & { type?: string }).type === 'browser') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron');
  bootstrapMain(app, fs, () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('./index');
  });
}
