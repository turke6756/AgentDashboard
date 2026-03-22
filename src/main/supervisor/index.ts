import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { execFileSync, execFile, spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { Agent, AgentStatus, ContextStats, LaunchAgentInput, QueryResult } from '../../shared/types';
import {
  TMUX_SESSION_PREFIX, DEFAULT_COMMAND, DEFAULT_COMMAND_WSL, PROVIDER_COMMANDS,
  SUPERVISOR_AGENT_NAME, SUPERVISOR_AGENT_MD, SUPERVISOR_MEMORY_MD, SUPERVISOR_SKILLS_README,
  SCRIPT_READ_AGENT_LOG, SCRIPT_LIST_AGENTS, SCRIPT_SEND_MESSAGE, SCRIPT_GET_CONTEXT_STATS,
} from '../../shared/constants';
import { WindowsRunner } from './windows-runner';
import { WslRunner } from './wsl-runner';
import { StatusMonitor } from './status-monitor';
import { ContextStatsMonitor, JsonlFileActivity } from './context-stats-monitor';
import { FileActivityTracker } from './file-activity-tracker';
import {
  createAgent, getAgent, getActiveAgents, getAllAgents, getSupervisorAgent, getWorkspace, updateAgentStatus, updateAgentPid,
  updateAgentExitCode, incrementRestartCount, updateAgentLastOutput,
  updateAgentAttached, addEvent, deleteAgent as dbDeleteAgent,
  updateAgentResumeSessionId, addFileActivity
} from '../database';
import { detectPathType, windowsToWslPath, uncToWslPath } from '../path-utils';
import { tmuxListSessions, tmuxSendKeys } from '../wsl-bridge';

function parseQueryResponse(stdout: string): QueryResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { result: '', sessionId: '', isError: false };
  }

  // Try parsing the whole output as JSON first (works for Windows/clean stdout)
  try {
    const parsed = JSON.parse(trimmed);
    return {
      result: parsed.result || trimmed,
      sessionId: parsed.session_id || '',
      isError: false,
    };
  } catch {
    // WSL: login shell profile scripts may print to stdout before the JSON.
    // Scan backwards for the last line that looks like JSON.
    const lines = trimmed.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{')) {
        try {
          const parsed = JSON.parse(line);
          return {
            result: parsed.result || line,
            sessionId: parsed.session_id || '',
            isError: false,
          };
        } catch {
          continue;
        }
      }
    }
    // No JSON found — return raw output as the result
    return { result: trimmed, sessionId: '', isError: false };
  }
}

function formatQueryError(err: Error | null, stdout: string, stderr: string): QueryResult {
  const parts = [stderr.trim(), stdout.trim(), err?.message || ''].filter(Boolean);
  return {
    result: parts.join('\n') || 'Query failed',
    sessionId: '',
    isError: true,
  };
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function getWindowsSystemPath(...parts: string[]): string {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', ...parts);
}

function findWindowsClaudePath(_env: NodeJS.ProcessEnv): Promise<string> {
  // Use known install path directly — avoids all PATH/shell resolution issues in Electron
  const knownPath = path.join(process.env.USERPROFILE || 'C:\\Users\\turke', '.local', 'bin', 'claude.exe');
  if (fs.existsSync(knownPath)) {
    return Promise.resolve(knownPath);
  }

  // Fallback: try where.exe through cmd.exe
  return new Promise<string>((resolve, reject) => {
    execFile(getWindowsSystemPath('cmd.exe'), ['/c', 'where', 'claude'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message || 'Failed to locate claude'));
        return;
      }

      const match = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => /claude(\.exe)?$/i.test(line));

      if (!match) {
        reject(new Error('Failed to locate claude'));
        return;
      }

      resolve(match);
    });
  });
}

export class AgentSupervisor extends EventEmitter {
  private windowsRunners = new Map<string, WindowsRunner>();
  private wslRunners = new Map<string, WslRunner>();
  private fileTrackers = new Map<string, FileActivityTracker>();
  private monitor: StatusMonitor;
  private contextStatsMonitor: ContextStatsMonitor;
  private logsDir: string;

  constructor() {
    super();
    const appData = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
    this.logsDir = path.join(appData, 'AgentDashboard', 'logs');
    if (!fs.existsSync(this.logsDir)) fs.mkdirSync(this.logsDir, { recursive: true });

    this.monitor = new StatusMonitor(
      (agent) => this.checkAlive(agent),
      (agentId) => this.getLastOutputTime(agentId)
    );

    this.monitor.on('statusChanged', (data) => {
      this.emit('statusChanged', data);
      // Handle auto-restart on crash
      const agent = getAgent(data.agentId);
      if (agent && data.status === 'crashed' && agent.autoRestartEnabled) {
        this.handleAutoRestart(agent);
      }
    });

    this.contextStatsMonitor = new ContextStatsMonitor(() => {
      const agents = getActiveAgents();
      return agents
        .filter(a => a.resumeSessionId)
        .map(a => ({
          agentId: a.id,
          sessionId: a.resumeSessionId!,
          workingDirectory: a.workingDirectory,
        }));
    });

    this.contextStatsMonitor.on('statsChanged', (stats: ContextStats) => {
      this.emit('contextStatsChanged', stats);
    });

    // JSONL-based file activity tracking (reliable for both Windows and WSL agents)
    this.contextStatsMonitor.on('fileActivity', (activity: JsonlFileActivity) => {
      const dbActivity = addFileActivity(activity.agentId, activity.filePath, activity.operation);
      if (dbActivity) {
        this.emit('fileActivity', dbActivity);
      }
    });

    // Update registry whenever any status changes
    this.on('statusChanged', () => this.writeAgentRegistry());
    this.on('agentDeleted', () => this.writeAgentRegistry());
  }

  start(): void {
    this.monitor.start();
    this.contextStatsMonitor.start();
  }

  stop(): void {
    this.monitor.stop();
    this.contextStatsMonitor.stop();
  }

  getContextStats(agentId: string): ContextStats | null {
    return this.contextStatsMonitor.getStats(agentId);
  }

  getSupervisorAgent(workspaceId: string): Agent | null {
    return getSupervisorAgent(workspaceId);
  }

  /** Write ~/.claude/agent-registry.json so other Claude instances can discover agents */
  private writeAgentRegistry(): void {
    try {
      const agents = getAllAgents();
      const registry = {
        updatedAt: new Date().toISOString(),
        agents: agents
          .filter(a => a.resumeSessionId && a.status !== 'done')
          .map(a => ({
            id: a.id,
            title: a.title,
            status: a.status,
            sessionId: a.resumeSessionId,
            workingDirectory: a.workingDirectory,
            roleDescription: a.roleDescription || '',
          })),
      };
      const registryPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'agent-registry.json');
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    } catch (err) {
      console.error('[registry] Failed to write agent registry:', err);
    }
  }

  async launchAgent(input: LaunchAgentInput): Promise<Agent> {
    const workspace = getWorkspace(input.workspaceId);
    if (!workspace) throw new Error('Workspace not found');

    // Prevent duplicate supervisors per workspace
    if (input.isSupervisor) {
      const existing = getSupervisorAgent(input.workspaceId);
      if (existing && !['done', 'crashed'].includes(existing.status)) {
        throw new Error(`Supervisor already running for this workspace (${existing.id})`);
      }
    }

    let workDir = input.workingDirectory || workspace.path;
    const pathType = detectPathType(workDir);
    // Convert UNC WSL paths (\\wsl.localhost\...) to Linux paths (/home/...)
    if (pathType === 'wsl' && workDir.startsWith('\\\\')) {
      workDir = uncToWslPath(workDir);
    }
    const provider = input.provider || 'claude';
    const defaultCmd = PROVIDER_COMMANDS[provider][pathType];
    const command = input.command || (workspace.defaultCommand === DEFAULT_COMMAND ? defaultCmd : workspace.defaultCommand);
    const agentId = uuidv4().substring(0, 8);
    const logPath = path.join(this.logsDir, `${agentId}.log`);

    let tmuxSessionName: string | null = null;

    if (pathType === 'wsl') {
      const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 20);
      tmuxSessionName = `${TMUX_SESSION_PREFIX}${slug}__${agentId}`;
    }

    const agent = createAgent({
      workspaceId: input.workspaceId,
      title: input.title,
      roleDescription: input.roleDescription || '',
      workingDirectory: workDir,
      command,
      provider,
      isSupervisor: input.isSupervisor,
      tmuxSessionName,
      autoRestartEnabled: input.autoRestartEnabled ?? true,
      logPath,
    });

    // Assign a session ID for resume/fork/query support (Claude only)
    let sessionId: string | undefined;
    if (provider === 'claude') {
      sessionId = uuidv4();
      updateAgentResumeSessionId(agent.id, sessionId);
    }

    addEvent(agent.id, 'launched');

    // Auto-create .claude/agents/supervisor/ scaffold if this is a supervisor launch
    if (input.isSupervisor) {
      this.ensureSupervisorScaffold(workDir, pathType);
    }

    // Auto-load agent.md/AGENT.md if present
    const agentMdPrompt = this.loadAgentMd(workDir, pathType);

    if (pathType === 'windows') {
      await this.launchWindowsAgent(agent, false, agentMdPrompt, sessionId);
    } else {
      await this.launchWslAgent(agent, false, agentMdPrompt, undefined, sessionId);
    }

    return getAgent(agent.id)!;
  }

  /** Scaffold file map: relative path → content.
   *  Scripts get +x on WSL. */
  private static SUPERVISOR_FILES: Record<string, { content: string; executable?: boolean }> = {
    [`.claude/agents/${SUPERVISOR_AGENT_NAME}.md`]:                    { content: SUPERVISOR_AGENT_MD },
    [`.claude/agents/${SUPERVISOR_AGENT_NAME}/memory/MEMORY.md`]:     { content: SUPERVISOR_MEMORY_MD },
    [`.claude/agents/${SUPERVISOR_AGENT_NAME}/skills/README.md`]:     { content: SUPERVISOR_SKILLS_README },
    [`.claude/agents/${SUPERVISOR_AGENT_NAME}/scripts/read-agent-log.sh`]:   { content: SCRIPT_READ_AGENT_LOG, executable: true },
    [`.claude/agents/${SUPERVISOR_AGENT_NAME}/scripts/list-agents.sh`]:      { content: SCRIPT_LIST_AGENTS, executable: true },
    [`.claude/agents/${SUPERVISOR_AGENT_NAME}/scripts/send-message.sh`]:     { content: SCRIPT_SEND_MESSAGE, executable: true },
    [`.claude/agents/${SUPERVISOR_AGENT_NAME}/scripts/get-context-stats.sh`]:{ content: SCRIPT_GET_CONTEXT_STATS, executable: true },
  };

  /** Create the full .claude/agents/supervisor/ scaffold in a workspace.
   *  Only writes files that don't already exist — never overwrites user edits. */
  private ensureSupervisorScaffold(workDir: string, pathType: string): void {
    const files = AgentSupervisor.SUPERVISOR_FILES;
    let created = 0;

    if (pathType === 'wsl') {
      for (const [relPath, { content, executable }] of Object.entries(files)) {
        try {
          execFileSync('wsl.exe', ['bash', '-lc', `test -f '${workDir}/${relPath}'`], { timeout: 5000 });
          // File exists, skip
        } catch {
          try {
            const dir = relPath.substring(0, relPath.lastIndexOf('/'));
            // Base64-encode to avoid shell escaping issues with $, backticks, etc.
            const b64 = Buffer.from(content, 'utf-8').toString('base64');
            let cmd = `mkdir -p '${workDir}/${dir}' && echo '${b64}' | base64 -d > '${workDir}/${relPath}'`;
            if (executable) {
              cmd += ` && chmod +x '${workDir}/${relPath}'`;
            }
            execFileSync('wsl.exe', ['bash', '-lc', cmd], { timeout: 5000 });
            created++;
          } catch (err) {
            console.error(`[supervisor] Failed to create ${relPath} in WSL:`, err);
          }
        }
      }
    } else {
      for (const [relPath, { content }] of Object.entries(files)) {
        const fullPath = path.join(workDir, relPath);
        if (fs.existsSync(fullPath)) continue;
        try {
          const dir = path.dirname(fullPath);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fullPath, content, 'utf-8');
          created++;
        } catch (err) {
          console.error(`[supervisor] Failed to create ${fullPath}:`, err);
        }
      }
    }

    if (created > 0) {
      console.log(`[supervisor] Scaffolded ${created} files in ${workDir}/.claude/agents/supervisor/`);
      addEvent('system', 'supervisor_scaffold_created', JSON.stringify({ workDir, filesCreated: created }));
    } else {
      console.log(`[supervisor] Scaffold already exists in ${workDir}`);
    }
  }

  /** Read the supervisor.md from the scaffold we created.
   *  Returns the file content to pass via --system-prompt. */
  private loadSupervisorPrompt(workDir: string, pathType: string): string {
    const relPath = `.claude/agents/${SUPERVISOR_AGENT_NAME}.md`;

    if (pathType === 'wsl') {
      try {
        const content = execFileSync('wsl.exe', ['bash', '-lc', `cat '${workDir}/${relPath}'`], {
          encoding: 'utf-8',
          timeout: 5000,
        });
        if (content && content.trim()) return content.trim();
      } catch { /* fall through */ }
    } else {
      const fullPath = path.join(workDir, relPath);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (content && content.trim()) return content.trim();
      } catch { /* fall through */ }
    }

    // Fallback to the built-in constant if file read fails
    console.warn(`[supervisor] Could not read ${relPath}, using built-in default`);
    return SUPERVISOR_AGENT_MD;
  }

  private loadAgentMd(workDir: string, pathType: string): string | null {
    const candidates = ['agent.md', 'AGENT.md'];
    const MAX_SIZE = 10 * 1024; // 10KB cap

    if (pathType === 'wsl') {
      for (const name of candidates) {
        try {
          const content = execFileSync('wsl.exe', ['bash', '-lc', `cat '${workDir}/${name}'`], {
            encoding: 'utf-8',
            timeout: 5000,
          });
          if (content && content.trim()) {
            const trimmed = content.substring(0, MAX_SIZE);
            addEvent('system', 'agent_md_loaded', `${workDir}/${name}`);
            return trimmed;
          }
        } catch {
          // File doesn't exist, try next
        }
      }
    } else {
      for (const name of candidates) {
        const fullPath = path.join(workDir, name);
        if (fs.existsSync(fullPath)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            if (content && content.trim()) {
              const trimmed = content.substring(0, MAX_SIZE);
              addEvent('system', 'agent_md_loaded', fullPath);
              return trimmed;
            }
          } catch {
            // Read error, skip
          }
        }
      }
    }
    return null;
  }

  private setupFileTracker(agentId: string, workingDirectory: string): FileActivityTracker {
    const tracker = new FileActivityTracker(agentId, workingDirectory);
    this.fileTrackers.set(agentId, tracker);
    tracker.on('activity', (activity) => {
      this.emit('fileActivity', activity);
    });
    return tracker;
  }

  private async launchWindowsAgent(agent: Agent, resume = false, agentMdPrompt?: string | null, sessionId?: string, overrideArgs?: string[]): Promise<void> {
    const runner = new WindowsRunner();
    this.windowsRunners.set(agent.id, runner);

    // Parse command into executable and args
    const parts = agent.command.split(/\s+/);
    const cmd = parts[0];
    let args = overrideArgs || parts.slice(1);

    if (!overrideArgs) {
      const isClaude = agent.provider === 'claude';

      // Inject supervisor prompt via --system-prompt
      if (agent.isSupervisor && isClaude) {
        const supPrompt = this.loadSupervisorPrompt(agent.workingDirectory, 'windows');
        args.push('--system-prompt', supPrompt);
        console.log(`[Windows] Supervisor agent ${agent.title} (${agent.id}) — loaded system prompt (${supPrompt.length} chars)`);
      }

      // Add session ID on fresh launch (Claude only)
      if (!resume && sessionId && isClaude) {
        args.push('--session-id', sessionId);
        console.log(`[Windows] Fresh launch ${agent.title} (${agent.id}) with session-id: ${sessionId}`);
      }

      // Use --resume with session ID if available, else fall back to --continue (Claude only)
      if (resume && isClaude && !args.includes('--continue') && !args.includes('-c')) {
        const latest = getAgent(agent.id);
        if (latest?.resumeSessionId) {
          args.push('--resume', latest.resumeSessionId);
          console.log(`[Windows] Resuming ${agent.title} (${agent.id}) with session: ${latest.resumeSessionId}`);
        } else {
          args.push('--continue');
          console.log(`[Windows] Resuming ${agent.title} (${agent.id}) with --continue (no session ID)`);
        }
      }

      // Append agent.md content as final positional argument (Claude only)
      if (agentMdPrompt && !resume && isClaude) {
        args.push(agentMdPrompt);
      }
    }

    // Setup file activity tracker
    const tracker = this.setupFileTracker(agent.id, agent.workingDirectory);

    runner.on('data', (data: string) => {
      updateAgentLastOutput(agent.id);
      tracker.processData(data);
    });

    runner.on('exit', (exitCode: number) => {
      updateAgentExitCode(agent.id, exitCode);
      this.windowsRunners.delete(agent.id);
      const status: AgentStatus = exitCode === 0 ? 'done' : 'crashed';
      updateAgentStatus(agent.id, status);
      addEvent(agent.id, status, JSON.stringify({ exitCode }));
      this.emit('statusChanged', { agentId: agent.id, status });

      // Auto-restart
      const latest = getAgent(agent.id);
      if (latest && status === 'crashed' && latest.autoRestartEnabled) {
        this.handleAutoRestart(latest);
      }
    });

    // Supervisor agents use directSpawn to avoid cmd.exe mangling multiline --system-prompt.
    // This requires the full path to claude.exe since cmd.exe won't resolve PATH.
    let launchCmd = cmd;
    const useDirectSpawn = agent.isSupervisor && agent.provider === 'claude';
    if (useDirectSpawn) {
      try {
        launchCmd = await findWindowsClaudePath(process.env as NodeJS.ProcessEnv);
        console.log(`[Windows] Supervisor using direct spawn with: ${launchCmd}`);
      } catch (err) {
        console.warn(`[Windows] Could not resolve claude.exe path, falling back to cmd.exe:`, err);
      }
    }

    runner.launch(agent.workingDirectory, launchCmd, args, agent.logPath || '', useDirectSpawn && launchCmd !== cmd);
    updateAgentPid(agent.id, runner.pid);
    updateAgentStatus(agent.id, 'working');
    this.emit('statusChanged', { agentId: agent.id, status: 'working' });
  }

  private async launchWslAgent(agent: Agent, resume = false, agentMdPrompt?: string | null, overrideCommand?: string, sessionId?: string): Promise<void> {
    if (!agent.tmuxSessionName) throw new Error('No tmux session name');

    const runner = new WslRunner(agent.tmuxSessionName);
    this.wslRunners.set(agent.id, runner);

    // Do not convert log path to WSL; WslRunner runs in Windows Node.js and needs a native path.
    const nativeLogPath = agent.logPath || '';
    const wslWorkDir = agent.workingDirectory; // Already a WSL path

    let command = overrideCommand || agent.command;
    const isClaude = agent.provider === 'claude';

    if (!overrideCommand) {
      // Inject supervisor prompt via --system-prompt (reads from scaffolded .claude/agents/supervisor.md)
      if (agent.isSupervisor && isClaude) {
        const supPrompt = this.loadSupervisorPrompt(agent.workingDirectory, 'wsl');
        const escapedPrompt = supPrompt.replace(/'/g, "'\\''");
        command += ` --system-prompt '${escapedPrompt}'`;
        console.log(`[WSL] Supervisor agent ${agent.title} (${agent.id}) — loaded system prompt (${supPrompt.length} chars)`);
      }

      // Add session ID on fresh launch (Claude only)
      if (!resume && sessionId && isClaude) {
        command += ` --session-id ${sessionId}`;
        console.log(`[WSL] Fresh launch ${agent.title} (${agent.id}) with session-id: ${sessionId}`);
      }

      // Use --resume with session ID if available, else fall back to --continue (Claude only)
      if (resume && isClaude && !command.includes('--continue') && !command.includes('-c ')) {
        const latest = getAgent(agent.id);
        if (latest?.resumeSessionId) {
          command += ` --resume ${latest.resumeSessionId}`;
          console.log(`[WSL] Resuming ${agent.title} (${agent.id}) with session: ${latest.resumeSessionId}`);
        } else {
          command += ' --continue';
          console.log(`[WSL] Resuming ${agent.title} (${agent.id}) with --continue (no session ID)`);
        }
      }

      // Append agent.md content (shell-escaped) as final argument (Claude only)
      if (agentMdPrompt && !resume && isClaude) {
        const escaped = agentMdPrompt.replace(/'/g, "'\\''");
        command += ` '${escaped}'`;
      }
    }

    // Setup file activity tracker
    const tracker = this.setupFileTracker(agent.id, agent.workingDirectory);

    runner.on('data', (data: string) => {
      updateAgentLastOutput(agent.id);
      tracker.processData(data);
    });

    runner.on('exit', (exitCode: number) => {
      updateAgentExitCode(agent.id, exitCode);
      this.wslRunners.delete(agent.id);
      const status: AgentStatus = exitCode === 0 ? 'done' : 'crashed';
      updateAgentStatus(agent.id, status);
      addEvent(agent.id, status, JSON.stringify({ exitCode }));
      this.emit('statusChanged', { agentId: agent.id, status });

      const latest = getAgent(agent.id);
      if (latest && status === 'crashed' && latest.autoRestartEnabled) {
        this.handleAutoRestart(latest);
      }
    });

    console.log(`[WSL] Launching agent '${agent.tmuxSessionName}' in ${wslWorkDir}`);
    console.log(`[WSL] Command: ${command}`);
    await runner.launch(wslWorkDir, command, nativeLogPath);
    updateAgentStatus(agent.id, 'working');
    this.emit('statusChanged', { agentId: agent.id, status: 'working' });
  }

  private async handleAutoRestart(agent: Agent): Promise<void> {
    if (agent.restartCount >= 5) {
      addEvent(agent.id, 'restart_limit_reached');
      return;
    }

    updateAgentStatus(agent.id, 'restarting');
    addEvent(agent.id, 'restarting');
    this.emit('statusChanged', { agentId: agent.id, status: 'restarting' });
    incrementRestartCount(agent.id);

    // Wait a bit before restarting with --continue to resume conversation
    setTimeout(async () => {
      const latest = getAgent(agent.id);
      if (!latest || latest.status !== 'restarting') return;

      try {
        const pathType = detectPathType(latest.workingDirectory);
        if (pathType === 'windows') {
          await this.launchWindowsAgent(latest, true);
        } else {
          await this.launchWslAgent(latest, true);
        }
      } catch (err) {
        updateAgentStatus(agent.id, 'crashed');
        addEvent(agent.id, 'restart_failed', String(err));
        this.emit('statusChanged', { agentId: agent.id, status: 'crashed' });
      }
    }, 2000);
  }

  async forkAgent(sourceAgentId: string): Promise<Agent> {
    const source = getAgent(sourceAgentId);
    if (!source) throw new Error('Source agent not found');
    if (source.provider !== 'claude') throw new Error('Fork is only supported for Claude agents');
    if (!source.resumeSessionId) throw new Error('Source agent has no session ID — cannot fork');

    const workspace = getWorkspace(source.workspaceId);
    if (!workspace) throw new Error('Workspace not found');

    const newSessionId = uuidv4();
    const logPath = path.join(this.logsDir, `${uuidv4().substring(0, 8)}.log`);

    let tmuxSessionName: string | null = null;
    const pathType = detectPathType(source.workingDirectory);
    if (pathType === 'wsl') {
      const slug = (source.title + ' fork').toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 20);
      tmuxSessionName = `${TMUX_SESSION_PREFIX}${slug}__${uuidv4().substring(0, 8)}`;
    }

    const newAgent = createAgent({
      workspaceId: source.workspaceId,
      title: source.title + ' (fork)',
      roleDescription: source.roleDescription,
      workingDirectory: source.workingDirectory,
      command: source.command,
      provider: source.provider,
      tmuxSessionName,
      autoRestartEnabled: source.autoRestartEnabled,
      logPath,
    });

    updateAgentResumeSessionId(newAgent.id, newSessionId);
    addEvent(newAgent.id, 'forked', JSON.stringify({ sourceAgentId, sourceSessionId: source.resumeSessionId }));

    if (pathType === 'windows') {
      const parts = source.command.split(/\s+/);
      const cmd = parts[0];
      const forkArgs = [...parts.slice(1), '--resume', source.resumeSessionId, '--fork-session', '--session-id', newSessionId];
      await this.launchWindowsAgent(newAgent, false, null, undefined, forkArgs);
    } else {
      const forkCommand = `${source.command} --resume ${source.resumeSessionId} --fork-session --session-id ${newSessionId}`;
      await this.launchWslAgent(newAgent, false, null, forkCommand);
    }

    return getAgent(newAgent.id)!;
  }

  async queryAgent(targetAgentId: string, question: string, sourceAgentId?: string): Promise<QueryResult> {
    const target = getAgent(targetAgentId);
    if (!target) throw new Error('Target agent not found');
    if (target.provider !== 'claude') throw new Error('Inter-agent query is only supported for Claude agents');
    if (!target.resumeSessionId) throw new Error('Target agent has no session ID — cannot query');

    const source = sourceAgentId ? getAgent(sourceAgentId) : null;

    // Strong identity-anchored prompt to prevent history pattern-matching
    const sourceRef = source ? ` ("${source.title}")` : '';
    const prefixedQuestion = [
      `You are "${target.title}" — a Claude Code agent being consulted by another agent${sourceRef} in the same workspace.`,
      '',
      'This is NOT a task. Do NOT perform actions, use tools, run commands, or delegate work.',
      '',
      'You are being asked a question. Answer it directly from what you already know — your conversation history, the files you have read, the context you have built up. Everything you need is already in your memory.',
      '',
      'NOTE: Your conversation history may contain previous /query-agent skill invocations where you queried OTHER agents. Ignore those patterns. You are not running a query right now — you are ANSWERING one.',
      '',
      `Question: ${question}`,
    ].join('\n');

    const pathType = detectPathType(target.workingDirectory);

    const runQuery = (resumeArgs: string[]): Promise<QueryResult> => {
      return new Promise<QueryResult>((resolve) => {
        // Build a clean env: inherit everything but remove vars that block Claude
        const env = { ...process.env };
        delete env.CLAUDECODE;
        delete env.ELECTRON_RUN_AS_NODE;
        // Ensure the env vars are truly absent, not empty strings
        if ('CLAUDECODE' in env) delete env.CLAUDECODE;

        const mode = resumeArgs[0] === '--resume' ? 'resume' : 'continue';
        const resumeValue = resumeArgs[1] || '';

        if (pathType === 'windows') {
          const claudePath = path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe');
          const args = ['-p', prefixedQuestion];
          if (mode === 'resume') {
            args.push('--resume', resumeValue);
          } else {
            args.push('--continue');
          }
          args.push('--fork-session', '--dangerously-skip-permissions', '--max-turns', '1', '--output-format', 'json');

          console.log('[query] Spawning:', claudePath, args.join(' '), 'cwd:', target.workingDirectory);

          // Use spawn so we can close stdin — claude -p hangs if stdin stays open
          const child = spawn(claudePath, args, {
            cwd: target.workingDirectory,
            windowsHide: true,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

          const timer = setTimeout(() => { child.kill(); }, 60000);

          child.on('close', (code: number | null) => {
            clearTimeout(timer);
            if (code !== 0) {
              console.error('[query] Windows exit code:', code, 'stderr:', stderr, 'stdout:', stdout.substring(0, 200));
              resolve(formatQueryError(new Error(`Exit code ${code}`), stdout, stderr));
              return;
            }
            resolve(parseQueryResponse(stdout));
          });

          child.on('error', (err: Error) => {
            clearTimeout(timer);
            console.error('[query] Windows spawn error:', err.message);
            resolve(formatQueryError(err, '', ''));
          });
        } else {
          // Use spawn with stdin closed — same fix as Windows.
          // claude -p hangs if stdin stays open (execFile keeps it open as a pipe).
          const script = [
            'set -e',
            'cd "$AGENT_DASHBOARD_WORKDIR"',
            'args=(-p "$AGENT_DASHBOARD_QUERY")',
            'if [ "$AGENT_DASHBOARD_RESUME_MODE" = "resume" ]; then',
            '  args+=(--resume "$AGENT_DASHBOARD_RESUME_VALUE")',
            'else',
            '  args+=(--continue)',
            'fi',
            'args+=(--fork-session --dangerously-skip-permissions --max-turns 1 --output-format json)',
            'claude "${args[@]}"',
          ].join('\n');

          // Declare WSLENV so custom env vars reliably propagate into WSL
          // (default sharing can be disabled via /etc/wsl.conf interop settings)
          const queryVars = 'AGENT_DASHBOARD_WORKDIR:AGENT_DASHBOARD_QUERY:AGENT_DASHBOARD_RESUME_MODE:AGENT_DASHBOARD_RESUME_VALUE';
          const currentWslenv = env.WSLENV || '';
          const wslenv = currentWslenv ? `${currentWslenv}:${queryVars}` : queryVars;

          const child = spawn(getWindowsSystemPath('wsl.exe'), ['bash', '-lc', script], {
            windowsHide: true,
            env: {
              ...env,
              WSLENV: wslenv,
              AGENT_DASHBOARD_WORKDIR: target.workingDirectory,
              AGENT_DASHBOARD_QUERY: prefixedQuestion,
              AGENT_DASHBOARD_RESUME_MODE: mode,
              AGENT_DASHBOARD_RESUME_VALUE: resumeValue,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let stdout = '';
          let stderr = '';
          child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

          const timer = setTimeout(() => { child.kill(); }, 60000);

          child.on('close', (code: number | null) => {
            clearTimeout(timer);
            if (code !== 0) {
              console.error('[query] WSL exit code:', code, 'stderr:', stderr, 'stdout:', stdout.substring(0, 200));
              resolve(formatQueryError(new Error(`Exit code ${code}`), stdout, stderr));
              return;
            }
            resolve(parseQueryResponse(stdout));
          });

          child.on('error', (err: Error) => {
            clearTimeout(timer);
            console.error('[query] WSL spawn error:', err.message);
            resolve(formatQueryError(err, '', ''));
          });
        }
      });
    };

    // Try --resume first; fall back to --continue if session not found
    let result = await runQuery(['--resume', target.resumeSessionId!]);
    if (result.isError && /conversation|session|not found/i.test(result.result)) {
      console.log('[query] --resume failed, falling back to --continue for', target.title);
      result = await runQuery(['--continue']);
    }

    // Auto-inject response into the source agent's terminal so it has context
    if (source && !result.isError && result.result) {
      const injection = `[INTER-AGENT RESPONSE from "${target.title}"]: ${result.result}`;
      const winRunner = this.windowsRunners.get(sourceAgentId!);
      if (winRunner) {
        winRunner.write(injection + '\n');
        console.log('[query] Injected response into', source.title);
      }
      const wslRunner = this.wslRunners.get(sourceAgentId!);
      if (wslRunner) {
        wslRunner.write(injection + '\n');
        console.log('[query] Injected response into', source.title, '(WSL)');
      }
    }

    return result;
  }

  async stopAgent(agentId: string): Promise<void> {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      winRunner.kill();
      this.windowsRunners.delete(agentId);
    }

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      await wslRunner.kill();
      this.wslRunners.delete(agentId);
    }

    this.fileTrackers.delete(agentId);
    updateAgentStatus(agentId, 'done');
    updateAgentExitCode(agentId, 0);
    addEvent(agentId, 'stopped');
    this.emit('statusChanged', { agentId, status: 'done' });
  }

  async deleteAgent(agentId: string): Promise<void> {
    // Stop process if running
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      winRunner.kill();
      this.windowsRunners.delete(agentId);
    }

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      await wslRunner.kill();
      this.wslRunners.delete(agentId);
    }

    this.fileTrackers.delete(agentId);
    dbDeleteAgent(agentId);
    this.emit('agentDeleted', { agentId });
  }

  async restartAgent(agentId: string): Promise<void> {
    await this.stopAgent(agentId);
    const agent = getAgent(agentId);
    if (!agent) return;

    updateAgentStatus(agentId, 'restarting');
    incrementRestartCount(agentId);
    this.emit('statusChanged', { agentId, status: 'restarting' });

    setTimeout(async () => {
      const latest = getAgent(agentId);
      if (!latest) return;
      try {
        const pathType = detectPathType(latest.workingDirectory);
        if (pathType === 'windows') {
          await this.launchWindowsAgent(latest, true);
        } else {
          await this.launchWslAgent(latest, true);
        }
      } catch (err) {
        updateAgentStatus(agentId, 'crashed');
        this.emit('statusChanged', { agentId, status: 'crashed' });
      }
    }, 1000);
  }

  attachAgent(agentId: string): { write: (data: string) => void; resize: (cols: number, rows: number) => void; onData: (cb: (data: string) => void) => void } {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      updateAgentAttached(agentId, true);
      return {
        write: (data) => winRunner.write(data),
        resize: (cols, rows) => winRunner.resize(cols, rows),
        onData: (cb) => winRunner.on('data', cb),
      };
    }

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      wslRunner.attach();
      updateAgentAttached(agentId, true);
      return {
        write: (data) => wslRunner.write(data),
        resize: (cols, rows) => wslRunner.resize(cols, rows),
        onData: (cb) => wslRunner.on('data', cb),
      };
    }

    throw new Error('Agent not found or not running');
  }

  writeToAgent(agentId: string, data: string): void {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) { winRunner.write(data); return; }
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) { wslRunner.write(data); }
  }

  async sendInput(agentId: string, text: string): Promise<void> {
    // For WSL agents, use tmux send-keys (reliable, doesn't need PTY host)
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      const agent = getAgent(agentId);
      if (agent?.tmuxSessionName) {
        await tmuxSendKeys(agent.tmuxSessionName, text);
        return;
      }
    }
    // For Windows agents, write directly with \r for Enter
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      winRunner.write(text + '\r');
      return;
    }
  }

  removeAgentListener(agentId: string, listener: (data: string) => void): void {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      winRunner.off('data', listener);
      return;
    }
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      wslRunner.off('data', listener);
      return;
    }
  }

  resizeAgent(agentId: string, cols: number, rows: number): void {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) { winRunner.resize(cols, rows); return; }
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) { wslRunner.resize(cols, rows); }
  }

  detachAgent(agentId: string): void {
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      wslRunner.detach();
    }
    // Windows runners don't need detach - we just stop forwarding
    updateAgentAttached(agentId, false);
  }

  async getAgentLog(agentId: string, lines = 50): Promise<string> {
    const agent = getAgent(agentId);
    if (!agent) return '';

    // If requesting a large history (like TerminalPanel does with 500+ lines),
    // always prefer the raw log file on disk. The log file contains the full,
    // persistent history with all raw ANSI color codes intact.
    // tmux capture-pane strips colors and is limited by the pane buffer.
    // Windows in-memory ring buffer is also limited.
    if (lines >= 500 && agent.logPath && fs.existsSync(agent.logPath)) {
      try {
        const content = fs.readFileSync(agent.logPath, 'utf-8');
        const allLines = content.split('\n');
        return allLines.slice(-lines).join('\n');
      } catch (err) {
        console.error(`[getAgentLog] Failed to read large log from disk for agent ${agentId}:`, err);
      }
    }

    // For WSL agents, try tmux capture first (always current)
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      try {
        return await wslRunner.captureOutput(lines);
      } catch {
        // Fall through to log file
      }
    }

    // For Windows agents, use in-memory ring buffer (instant, avoids file flush delays)
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      return winRunner.captureOutput(lines);
    }

    // Fallback: read from log file
    if (agent.logPath && fs.existsSync(agent.logPath)) {
      const content = fs.readFileSync(agent.logPath, 'utf-8');
      const allLines = content.split('\n');
      return allLines.slice(-lines).join('\n');
    }

    return '';
  }

  private async checkAlive(agent: Agent): Promise<boolean> {
    if (agent.tmuxSessionName) {
      const wslRunner = this.wslRunners.get(agent.id);
      if (!wslRunner) return false;
      return wslRunner.isStillAlive();
    } else {
      return this.windowsRunners.has(agent.id);
    }
  }

  private getLastOutputTime(agentId: string): number {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) return winRunner.lastOutputTime;

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) return wslRunner.lastOutputTime;

    return 0;
  }

  async reconcile(): Promise<void> {
    // Relaunch agents that were running before the app was closed
    const activeAgents = getActiveAgents();
    for (const agent of activeAgents) {
      // These agents were "working"/"idle" when the app closed but their
      // processes are gone. Relaunch with --continue to resume conversations.
      const hasRunner = this.windowsRunners.has(agent.id) || this.wslRunners.has(agent.id);
      if (!hasRunner) {
        const agentForReconnect = getAgent(agent.id);
        console.log(`Reconnecting agent: ${agent.title} (${agent.id}) sessionId=${agentForReconnect?.resumeSessionId || 'NONE'}`);
        try {
          const pathType = detectPathType(agent.workingDirectory);
          if (pathType === 'windows') {
            await this.launchWindowsAgent(agent, true);
          } else {
            await this.launchWslAgent(agent, true);
          }
          addEvent(agent.id, 'reconnected');
        } catch (err) {
          console.error(`Failed to reconnect agent ${agent.id}:`, err);
          updateAgentStatus(agent.id, 'crashed');
          addEvent(agent.id, 'reconnect_failed', String(err));
          this.emit('statusChanged', { agentId: agent.id, status: 'crashed' });
        }
      }
    }

    // Check for orphaned tmux sessions
    try {
      const sessions = await tmuxListSessions();
      const cadSessions = sessions.filter(s => s.name.startsWith(TMUX_SESSION_PREFIX));
      for (const session of cadSessions) {
        console.log(`Found existing tmux session: ${session.name}`);
      }
    } catch {
      // WSL might not be available
    }

    // Now that agents are active, do an immediate context stats poll
    // so data is available before the first interval tick.
    this.contextStatsMonitor.pollNow();
  }
}
