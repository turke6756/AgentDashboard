import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { tmuxNewSession, tmuxKillSession, isTmuxSessionAlive, tmuxCapturePane } from '../wsl-bridge';

export class WslRunner extends EventEmitter {
  private attachHost: ChildProcess | null = null;
  private sessionName: string;
  private _lastOutputTime: number = 0;
  private buffer: string = '';

  constructor(sessionName: string) {
    super();
    this.sessionName = sessionName;
  }

  get lastOutputTime(): number {
    return this._lastOutputTime;
  }

  async launch(workDir: string, command: string, logPath: string): Promise<void> {
    const fullCmd = `${command} 2>&1 | tee -a '${logPath}'`;
    await tmuxNewSession(this.sessionName, workDir, fullCmd);
    this._lastOutputTime = Date.now();
  }

  async isAlive(): Promise<boolean> {
    return isTmuxSessionAlive(this.sessionName);
  }

  async captureOutput(lines = 50): Promise<string> {
    return tmuxCapturePane(this.sessionName, lines);
  }

  attach(): void {
    if (this.attachHost) return;

    const ptyHostPath = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'pty-host.js');

    const env = { ...process.env };
    delete env.CLAUDECODE;

    this.attachHost = spawn('node', [ptyHostPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.attachHost.stdout?.setEncoding('utf-8');
    this.attachHost.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          this.handleAttachMessage(msg);
        } catch {}
      }
    });

    this.attachHost.on('exit', () => {
      this.attachHost = null;
      this.emit('detached');
    });

    // Once ready, spawn wsl tmux attach
    this.sendToHost({
      type: 'spawn',
      command: 'wsl.exe',
      args: ['bash', '-lc', `tmux attach -t '${this.sessionName}'`],
      cols: 120,
      rows: 40,
    });
  }

  private handleAttachMessage(msg: any): void {
    switch (msg.type) {
      case 'data':
        this._lastOutputTime = Date.now();
        this.emit('data', msg.data);
        break;
      case 'exit':
        this.attachHost = null;
        this.emit('detached');
        break;
    }
  }

  private sendToHost(msg: any): void {
    if (this.attachHost?.stdin?.writable) {
      this.attachHost.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  detach(): void {
    if (this.attachHost) {
      // Send tmux detach key
      this.sendToHost({ type: 'write', data: '\x02d' });
      setTimeout(() => {
        this.sendToHost({ type: 'kill' });
        setTimeout(() => {
          if (this.attachHost && !this.attachHost.killed) {
            this.attachHost.kill();
          }
          this.attachHost = null;
        }, 500);
      }, 500);
    }
  }

  write(data: string): void {
    this.sendToHost({ type: 'write', data });
  }

  resize(cols: number, rows: number): void {
    this.sendToHost({ type: 'resize', cols, rows });
  }

  async kill(): Promise<void> {
    this.detach();
    await tmuxKillSession(this.sessionName);
  }
}
