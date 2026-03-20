import { exec } from 'child_process';
import { PathType } from '../shared/types';

/** Strip Electron env vars so VS Code spawns with a clean environment */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.ELECTRON_NO_ASAR;
  delete env.CLAUDECODE;
  delete env.NODE_OPTIONS;
  return env;
}

export function openInVSCode(dirPath: string, pathType: PathType): void {
  const env = cleanEnv();
  if (pathType === 'wsl') {
    exec(`code --new-window --remote wsl+Ubuntu "${dirPath}"`, { env });
  } else {
    exec(`code --new-window "${dirPath}"`, { env });
  }
}

export function openFileInVSCode(filePath: string, pathType: PathType): void {
  const env = cleanEnv();
  if (pathType === 'wsl') {
    exec(`code --remote wsl+Ubuntu "${filePath}"`, { env });
  } else {
    exec(`code "${filePath}"`, { env });
  }
}

export function openFileInWorkspace(filePath: string, workspaceDir: string, pathType: PathType): void {
  const env = cleanEnv();
  if (pathType === 'wsl') {
    exec(`code --remote wsl+Ubuntu "${workspaceDir}" --goto "${filePath}"`, { env });
  } else {
    exec(`code "${workspaceDir}" --goto "${filePath}"`, { env });
  }
}
