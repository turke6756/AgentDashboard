import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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
  // Create session with login shell in the right directory
  const result = await wslExec(
    `tmux new-session -d -s '${name}' -c '${workDir}'`,
    15000
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create tmux session: ${result.stderr}`);
  }
  // Type the command into the shell — use single quotes to prevent bash expansion of $ and backticks
  const escapedCmd = command.replace(/'/g, "'\\''");
  const sendResult = await wslExec(
    `tmux send-keys -t '${name}' '${escapedCmd}' Enter`,
    5000
  );
  if (sendResult.exitCode !== 0) {
    console.error(`[tmux] send-keys failed: ${sendResult.stderr}`);
  }
}

export async function tmuxSendKeys(name: string, text: string): Promise<void> {
  const escaped = text.replace(/'/g, "'\\''");
  await wslExec(`tmux send-keys -t '${name}' '${escaped}' Enter`, 5000);
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
