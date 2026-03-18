// This script runs under regular Node.js (not Electron) so node-pty works.
// It communicates with the Electron main process via stdin/stdout JSON messages.

const pty = require('node-pty');

let ptyProcess = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

process.stdin.setEncoding('utf-8');
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      send({ type: 'error', error: 'Invalid JSON: ' + e.message });
      continue;
    }
    try {
      handleMessage(msg);
    } catch (e) {
      send({ type: 'error', error: 'Handler error: ' + e.message });
    }
  }
});

function handleMessage(msg) {
  switch (msg.type) {
    case 'spawn': {
      if (ptyProcess) {
        ptyProcess.kill();
      }

      const env = { ...process.env };
      delete env.CLAUDECODE;
      
      // Force CLI tools like Claude Code to output ANSI colors even when wrapped
      // inside cmd.exe under node-pty on Windows.
      env.FORCE_COLOR = '3';
      env.CLICOLOR_FORCE = '1';
      env.TERM = 'xterm-256color';

      // On Windows, node-pty can't resolve commands from PATH directly.
      // Spawn via cmd.exe /c so the shell resolves the command.
      let spawnCmd, spawnArgs;
      if (process.platform === 'win32' && msg.command !== 'cmd.exe' && msg.command !== 'wsl.exe') {
        spawnCmd = 'cmd.exe';
        const fullCommand = [msg.command, ...(msg.args || [])].join(' ');
        spawnArgs = ['/c', fullCommand];
      } else {
        spawnCmd = msg.command;
        spawnArgs = msg.args || [];
      }

      ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols: msg.cols || 120,
        rows: msg.rows || 40,
        cwd: msg.cwd || process.cwd(),
        env,
      });

      send({ type: 'pid', pid: ptyProcess.pid });

      ptyProcess.onData((data) => {
        send({ type: 'data', data });
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        send({ type: 'exit', exitCode, signal });
        ptyProcess = null;
      });
      break;
    }

    case 'write': {
      if (ptyProcess) {
        ptyProcess.write(msg.data);
      }
      break;
    }

    case 'resize': {
      if (ptyProcess) {
        ptyProcess.resize(msg.cols, msg.rows);
      }
      break;
    }

    case 'kill': {
      if (ptyProcess) {
        ptyProcess.kill();
        ptyProcess = null;
      }
      send({ type: 'killed' });
      break;
    }

    case 'ping': {
      send({ type: 'pong' });
      break;
    }
  }
}

process.on('SIGTERM', () => {
  if (ptyProcess) ptyProcess.kill();
  process.exit(0);
});

send({ type: 'ready' });
