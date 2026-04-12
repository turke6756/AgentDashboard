import path from 'path';
import { app } from 'electron';

export function getScriptsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'scripts');
  }
  return path.join(__dirname, '..', '..', '..', '..', 'scripts');
}

export function getScriptPath(scriptName: string): string {
  return path.join(getScriptsDir(), scriptName);
}
