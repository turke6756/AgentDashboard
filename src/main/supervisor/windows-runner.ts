import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

/**
 * Spawns Claude via a separate Node.js process that uses node-pty.
 * This avoids Electron's native module mismatch — node-pty works
 * under regular Node but not under Electron without VS Build Tools rebuild.
 */
export class WindowsRunner extends EventEmitter {
  private host: ChildProcess | null = null;
  private logStream: fs.WriteStream | null = null;
  private _lastOutputTime: number = 0;
  private _lastMeaningfulBurst: number = 0;
  private _recentOutputBytes: number = 0;
  private _outputWindowStart: number = 0;
  private _pid: number | null = null;
  private _alive: boolean = false;
  private buffer: string = '';

  get pid(): number | null {
    return this._pid;
  }

  /** Time of last sustained output burst (Claude actively generating) */
  get lastOutputTime(): number {
    return this._lastMeaningfulBurst;
  }

  get isAlive(): boolean {
    return this._alive;
  }

  launch(workDir: string, command: string, args: string[], logPath: string): void {
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    this.logStream = fs.createWriteStream(logPath, { flags: 'a' });

    // Find the pty-host script
    const ptyHostPath = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'pty-host.js');

    // Spawn pty-host under regular Node.js (not Electron)
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ELECTRON_RUN_AS_NODE;

    this.host = spawn('node', [ptyHostPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.host.stdout?.setEncoding('utf-8');
    this.host.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          this.handleMessage(msg);
        } catch {
          // ignore parse errors
        }
      }
    });

    this.host.stderr?.on('data', (data: Buffer) => {
      console.error('[pty-host stderr]', data.toString());
    });

    this.host.on('exit', () => {
      if (this._alive) {
        this._alive = false;
        this.logStream?.end();
        this.logStream = null;
        this.emit('exit', 1, null);
      }
      this.host = null;
    });

    // Send spawn command
    this.sendToHost({
      type: 'spawn',
      command,
      args,
      cwd: workDir,
      cols: 120,
      rows: 40,
    });

    this._alive = true;
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'data':
        this._lastOutputTime = Date.now();
        // Track output volume to distinguish active generation from idle echo.
        // When Claude is working, it streams lots of text quickly (>200 bytes in 3s).
        // User keystrokes echo back as tiny chunks.
        if (this.hasMeaningfulContent(msg.data)) {
          const now = Date.now();
          if (now - this._outputWindowStart > 3000) {
            // Start a new measurement window
            this._outputWindowStart = now;
            this._recentOutputBytes = 0;
          }
          this._recentOutputBytes += msg.data.length;
          if (this._recentOutputBytes > 200) {
            this._lastMeaningfulBurst = now;
          }
        }
        this.logStream?.write(msg.data);
        this.emit('data', msg.data);
        break;

      case 'pid':
        this._pid = msg.pid;
        break;

      case 'exit':
        this._alive = false;
        this.logStream?.end();
        this.logStream = null;
        this.emit('exit', msg.exitCode ?? 1, msg.signal);
        // Kill the host process too
        if (this.host && !this.host.killed) {
          this.host.kill();
        }
        this.host = null;
        break;

      case 'ready':
        // pty-host is ready
        break;
    }
  }

  private hasMeaningfulContent(data: string): boolean {
    // Strip ANSI escape sequences and control characters
    const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // CSI sequences
                        .replace(/\x1b\][^\x07]*\x07/g, '')       // OSC sequences
                        .replace(/\x1b[()][0-9A-Z]/g, '')         // Character set
                        .replace(/\x1b\[[\?]?[0-9;]*[hlm]/g, '') // Mode changes
                        .replace(/[\x00-\x1f]/g, '');              // Control chars
    return stripped.trim().length > 0;
  }

  private sendToHost(msg: any): void {
    if (this.host?.stdin?.writable) {
      this.host.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  write(data: string): void {
    this.sendToHost({ type: 'write', data });
  }

  resize(cols: number, rows: number): void {
    this.sendToHost({ type: 'resize', cols, rows });
  }

  kill(): void {
    this._alive = false;
    this.sendToHost({ type: 'kill' });
    setTimeout(() => {
      if (this.host && !this.host.killed) {
        this.host.kill();
      }
      this.host = null;
    }, 1000);
  }
}
