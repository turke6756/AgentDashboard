import { exec } from 'child_process';
import { PathType } from '../shared/types';

export function openInVSCode(dirPath: string, pathType: PathType): void {
  if (pathType === 'wsl') {
    // Use VS Code's remote WSL support
    const uri = `vscode://vscode-remote/wsl+Ubuntu${dirPath}`;
    exec(`start "" "${uri}"`);
  } else {
    exec(`code "${dirPath}"`);
  }
}

export function openFileInVSCode(filePath: string, pathType: PathType): void {
  if (pathType === 'wsl') {
    exec(`code --remote wsl+Ubuntu "${filePath}"`);
  } else {
    exec(`code "${filePath}"`);
  }
}
