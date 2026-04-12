import { execFile } from 'child_process';
import * as path from 'path';

export interface NotebookExecResult {
  ok: boolean;
  notebookPath: string;
  kernel: string;
  duration: number;
  error?: string;
  stderr?: string;
}

/**
 * Execute a Jupyter notebook in-place using `jupyter nbconvert --execute`.
 * Supports both Windows-local and WSL paths.
 */
export function executeNotebook(
  notebookPath: string,
  kernelName?: string,
  timeout = 600,
): Promise<NotebookExecResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const isWsl = notebookPath.startsWith('/');

    // Build the nbconvert command
    const args: string[] = [
      'nbconvert',
      '--to', 'notebook',
      '--execute',
      notebookPath,
      '--output', path.basename(notebookPath),
      `--ExecutePreprocessor.timeout=${timeout}`,
    ];
    if (kernelName) {
      args.push(`--ExecutePreprocessor.kernel_name=${kernelName}`);
    }

    const overallTimeout = (timeout + 60) * 1000; // per-cell timeout + buffer

    if (isWsl) {
      // Run via WSL
      const cmd = `jupyter ${args.map((a) => `'${a}'`).join(' ')}`;
      execFile('wsl.exe', ['bash', '-lc', cmd], { timeout: overallTimeout }, (err, stdout, stderr) => {
        const duration = Date.now() - start;
        if (err) {
          resolve({
            ok: false,
            notebookPath,
            kernel: kernelName || 'auto',
            duration,
            error: err.message,
            stderr: stderr || undefined,
          });
        } else {
          resolve({
            ok: true,
            notebookPath,
            kernel: kernelName || 'auto',
            duration,
            stderr: stderr || undefined,
          });
        }
      });
    } else {
      // Run directly on Windows
      execFile('jupyter', args, { timeout: overallTimeout, shell: true }, (err, stdout, stderr) => {
        const duration = Date.now() - start;
        if (err) {
          resolve({
            ok: false,
            notebookPath,
            kernel: kernelName || 'auto',
            duration,
            error: err.message,
            stderr: stderr || undefined,
          });
        } else {
          resolve({
            ok: true,
            notebookPath,
            kernel: kernelName || 'auto',
            duration,
            stderr: stderr || undefined,
          });
        }
      });
    }
  });
}
