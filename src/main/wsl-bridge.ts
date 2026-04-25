import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export function wslSpawn(command: string): ChildProcess {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn('wsl.exe', ['bash', '-lc', command], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export interface WslExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function wslExec(command: string, timeout = 10000): Promise<WslExecResult> {
  try {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout, stderr } = await execFileAsync('wsl.exe', ['bash', '-lc', command], {
      encoding: 'utf-8',
      env,
      timeout,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || err.message,
      exitCode: err.code || 1,
    };
  }
}

export async function isWslAvailable(): Promise<boolean> {
  try {
    const result = await wslExec('echo ok');
    return result.stdout === 'ok';
  } catch {
    return false;
  }
}

export async function isTmuxAvailable(): Promise<boolean> {
  const result = await wslExec('tmux -V');
  return result.exitCode === 0;
}

export async function isClaudeAvailableInWsl(): Promise<boolean> {
  const result = await wslExec('which claude');
  return result.exitCode === 0;
}

let inotifywaitAvailable: boolean | null = null;
export async function isInotifywaitAvailable(): Promise<boolean> {
  if (inotifywaitAvailable !== null) return inotifywaitAvailable;
  const result = await wslExec('which inotifywait');
  inotifywaitAvailable = result.exitCode === 0;
  return inotifywaitAvailable;
}

export interface TmuxSession {
  name: string;
  attached: boolean;
}

export async function tmuxListSessions(): Promise<TmuxSession[]> {
  const result = await wslExec("tmux ls -F '#{session_name}:#{session_attached}' 2>/dev/null || true");
  if (!result.stdout) return [];
  return result.stdout.split('\n').filter(Boolean).map(line => {
    const [name, attached] = line.split(':');
    return { name, attached: attached === '1' };
  });
}

export async function tmuxNewSession(name: string, workDir: string, command: string): Promise<void> {
  // Create session with the command as the pane process.
  // When the command exits, the tmux pane/session closes automatically,
  // which causes `tmux attach` in the PTY to exit → proper status update.
  // Use bash -lic (login + interactive) to ensure .bashrc aliases/venv are loaded.
  const escapedCmd = command.replace(/'/g, "'\\''");
  const result = await wslExec(
    `tmux new-session -d -s '${name}' -c '${workDir}' -- bash -lic '${escapedCmd}'`,
    15000
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create tmux session: ${result.stderr}`);
  }
}

export async function tmuxSendKeys(name: string, text: string): Promise<void> {
  // Chain literal-text send and Enter into a single wsl.exe invocation so they
  // either both happen or neither does. Splitting them across two wsl.exe
  // spawns lets a flaky second spawn drop the Enter silently, leaving the
  // message typed but unsubmitted in Claude Code's prompt buffer.
  const escaped = text.replace(/'/g, "'\\''");
  const result = await wslExec(
    `tmux send-keys -t '${name}' -l '${escaped}' \\; send-keys -t '${name}' Enter`,
    5000
  );
  if (result.exitCode !== 0) {
    throw new Error(`tmux send-keys failed: ${result.stderr || 'unknown error'}`);
  }
}

export async function tmuxKillSession(name: string): Promise<void> {
  await wslExec(`tmux kill-session -t '${name}' 2>/dev/null || true`);
}

export async function isTmuxSessionAlive(name: string): Promise<boolean> {
  const result = await wslExec(`tmux has-session -t '${name}' 2>/dev/null && echo yes || echo no`);
  return result.stdout === 'yes';
}

export async function tmuxCapturePane(name: string, lines = 50): Promise<string> {
  const result = await wslExec(
    `tmux capture-pane -t '${name}' -p -S -${lines} 2>/dev/null || echo ''`
  );
  return result.stdout;
}
