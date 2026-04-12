import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { AgentPersona, PathType } from '../shared/types';
import { SUPERVISOR_AGENT_NAME } from '../shared/constants';

const VALID_NAME = /^[a-z0-9_-]+$/;

/**
 * Scan .claude/agents/ for subdirectories containing CLAUDE.md.
 * Each is a persistent agent persona.
 */
export function scanPersonas(workspacePath: string, pathType: PathType): AgentPersona[] {
  const personas: AgentPersona[] = [];

  if (pathType === 'wsl') {
    try {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.ELECTRON_RUN_AS_NODE;
      const { stdout } = require('child_process').execFileSync(
        'wsl.exe',
        ['bash', '-lc', `for d in '${workspacePath}'/.claude/agents/*/; do [ -f "$d/CLAUDE.md" ] && basename "$d"; done 2>/dev/null || true`],
        { encoding: 'utf-8', timeout: 10000, env }
      ) as { stdout: string };
      const names = (stdout || '').trim().split('\n').filter(Boolean);
      for (const name of names) {
        const dir = `${workspacePath}/.claude/agents/${name}`;
        // Check if memory/MEMORY.md exists
        let hasMemory = false;
        try {
          execFileSync('wsl.exe', ['bash', '-lc', `test -f '${dir}/memory/MEMORY.md'`], { timeout: 5000, env });
          hasMemory = true;
        } catch { /* no memory dir */ }
        personas.push({
          name,
          directory: dir,
          hasMemory,
          isSupervisor: name === SUPERVISOR_AGENT_NAME,
        });
      }
    } catch {
      // .claude/agents/ doesn't exist or WSL unavailable
    }
  } else {
    const agentsDir = path.join(workspacePath, '.claude', 'agents');
    if (!fs.existsSync(agentsDir)) return personas;

    try {
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const claudeMdPath = path.join(agentsDir, entry.name, 'CLAUDE.md');
        if (!fs.existsSync(claudeMdPath)) continue;
        const memoryPath = path.join(agentsDir, entry.name, 'memory', 'MEMORY.md');
        personas.push({
          name: entry.name,
          directory: path.join(agentsDir, entry.name),
          hasMemory: fs.existsSync(memoryPath),
          isSupervisor: entry.name === SUPERVISOR_AGENT_NAME,
        });
      }
    } catch {
      // Permission error or similar
    }
  }

  return personas;
}

/**
 * Create a new persona directory with minimal scaffolding.
 */
export function scaffoldPersona(workspacePath: string, pathType: PathType, name: string, customClaudeMd?: string): AgentPersona {
  if (!VALID_NAME.test(name)) {
    throw new Error(`Invalid persona name "${name}". Only lowercase letters, numbers, hyphens, and underscores allowed.`);
  }

  if (name === SUPERVISOR_AGENT_NAME) {
    throw new Error(`Cannot create persona named "${SUPERVISOR_AGENT_NAME}" — reserved for supervisor.`);
  }

  const displayName = name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, ' ');
  const claudeMd = customClaudeMd || `# ${displayName} Agent\n\n<!-- Define this agent's identity and behavior here. -->\n`;
  const memoryMd = `# Memory Index\n`;

  if (pathType === 'wsl') {
    const dir = `${workspacePath}/.claude/agents/${name}`;
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ELECTRON_RUN_AS_NODE;

    const claudeB64 = Buffer.from(claudeMd, 'utf-8').toString('base64');
    const memoryB64 = Buffer.from(memoryMd, 'utf-8').toString('base64');
    const cmd = [
      `mkdir -p '${dir}/memory'`,
      `echo '${claudeB64}' | base64 -d > '${dir}/CLAUDE.md'`,
      `echo '${memoryB64}' | base64 -d > '${dir}/memory/MEMORY.md'`,
    ].join(' && ');

    execFileSync('wsl.exe', ['bash', '-lc', cmd], { timeout: 10000, env });

    return { name, directory: dir, hasMemory: true, isSupervisor: false };
  } else {
    const dir = path.join(workspacePath, '.claude', 'agents', name);
    const memoryDir = path.join(dir, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd, 'utf-8');
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), memoryMd, 'utf-8');

    return { name, directory: dir, hasMemory: true, isSupervisor: false };
  }
}
