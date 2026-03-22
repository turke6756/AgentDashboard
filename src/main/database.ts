import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { Agent, AgentProvider, AgentStatus, CreateWorkspaceInput, FileActivity, FileOperation, Workspace } from '../shared/types';
import { DEFAULT_COMMAND, DEFAULT_COMMAND_WSL } from '../shared/constants';

let db: SqlJsDatabase;
let dbPath: string;

function getDbPath(): string {
  const appData = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
  const dir = path.join(appData, 'AgentDashboard');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'dashboard.db');
}

function saveDb(): void {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

export async function initDatabase(): Promise<void> {
  const SQL = await initSqlJs();
  dbPath = getDbPath();

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      path            TEXT NOT NULL,
      path_type       TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      default_command TEXT NOT NULL DEFAULT '${DEFAULT_COMMAND}',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      last_opened_at  TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id                    TEXT PRIMARY KEY,
      workspace_id          TEXT NOT NULL,
      title                 TEXT NOT NULL,
      slug                  TEXT NOT NULL,
      role_description      TEXT NOT NULL DEFAULT '',
      working_directory     TEXT NOT NULL,
      command               TEXT NOT NULL,
      tmux_session_name     TEXT,
      auto_restart_enabled  INTEGER NOT NULL DEFAULT 1,
      resume_session_id     TEXT,
      status                TEXT NOT NULL DEFAULT 'launching',
      is_attached           INTEGER NOT NULL DEFAULT 0,
      restart_count         INTEGER NOT NULL DEFAULT 0,
      last_exit_code        INTEGER,
      pid                   INTEGER,
      log_path              TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      last_output_at        TEXT,
      last_attached_at      TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS file_activities (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      operation   TEXT NOT NULL,
      timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration: add provider column to existing agents tables
  try { db.run(`ALTER TABLE agents ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`); } catch { /* column already exists */ }

  // Migration: add is_supervisor column
  try { db.run(`ALTER TABLE agents ADD COLUMN is_supervisor INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      payload     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  saveDb();
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 30);
}

function rowToWorkspace(row: any): Workspace {
  return {
    id: row.id,
    title: row.title,
    path: row.path,
    pathType: row.path_type,
    description: row.description,
    defaultCommand: row.default_command,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
  };
}

function rowToAgent(row: any): Agent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    slug: row.slug,
    roleDescription: row.role_description,
    workingDirectory: row.working_directory,
    command: row.command,
    provider: (row.provider || 'claude') as AgentProvider,
    isSupervisor: !!row.is_supervisor,
    tmuxSessionName: row.tmux_session_name,
    autoRestartEnabled: !!row.auto_restart_enabled,
    resumeSessionId: row.resume_session_id,
    status: row.status as AgentStatus,
    isAttached: !!row.is_attached,
    restartCount: row.restart_count,
    lastExitCode: row.last_exit_code,
    pid: row.pid,
    logPath: row.log_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOutputAt: row.last_output_at,
    lastAttachedAt: row.last_attached_at,
  };
}

function queryAll(sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results: any[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql: string, params: any[] = []): any | null {
  const results = queryAll(sql, params);
  return results[0] || null;
}

function run(sql: string, params: any[] = []): void {
  db.run(sql, params);
  saveDb();
}

// Workspace operations
export function createWorkspace(input: CreateWorkspaceInput): Workspace {
  const id = uuidv4();
  run(
    `INSERT INTO workspaces (id, title, path, path_type, description, default_command)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.title, input.path, input.pathType, input.description || '', input.defaultCommand || (input.pathType === 'wsl' ? DEFAULT_COMMAND_WSL : DEFAULT_COMMAND)]
  );
  return getWorkspace(id)!;
}

export function getWorkspace(id: string): Workspace | null {
  const row = queryOne('SELECT * FROM workspaces WHERE id = ?', [id]);
  return row ? rowToWorkspace(row) : null;
}

export function getWorkspaces(): Workspace[] {
  return queryAll('SELECT * FROM workspaces ORDER BY last_opened_at DESC, created_at DESC').map(rowToWorkspace);
}

export function deleteWorkspace(id: string): void {
  run('DELETE FROM agents WHERE workspace_id = ?', [id]);
  run('DELETE FROM workspaces WHERE id = ?', [id]);
}

export function touchWorkspace(id: string): void {
  run("UPDATE workspaces SET last_opened_at = datetime('now') WHERE id = ?", [id]);
}

// Agent operations
export function createAgent(data: {
  workspaceId: string;
  title: string;
  roleDescription: string;
  workingDirectory: string;
  command: string;
  provider?: AgentProvider;
  isSupervisor?: boolean;
  tmuxSessionName: string | null;
  autoRestartEnabled: boolean;
  logPath: string;
}): Agent {
  const id = uuidv4();
  const slug = slugify(data.title);
  run(
    `INSERT INTO agents (id, workspace_id, title, slug, role_description, working_directory,
      command, provider, is_supervisor, tmux_session_name, auto_restart_enabled, log_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, data.workspaceId, data.title, slug, data.roleDescription, data.workingDirectory,
      data.command, data.provider || 'claude', data.isSupervisor ? 1 : 0, data.tmuxSessionName, data.autoRestartEnabled ? 1 : 0, data.logPath]
  );
  return getAgent(id)!;
}

export function getAgent(id: string): Agent | null {
  const row = queryOne('SELECT * FROM agents WHERE id = ?', [id]);
  return row ? rowToAgent(row) : null;
}

export function getAgentsByWorkspace(workspaceId: string): Agent[] {
  return queryAll('SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at DESC', [workspaceId]).map(rowToAgent);
}

export function getAllAgents(): Agent[] {
  return queryAll('SELECT * FROM agents ORDER BY created_at DESC').map(rowToAgent);
}

export function getSupervisorAgent(workspaceId: string): Agent | null {
  const row = queryOne('SELECT * FROM agents WHERE workspace_id = ? AND is_supervisor = 1 ORDER BY created_at DESC LIMIT 1', [workspaceId]);
  return row ? rowToAgent(row) : null;
}

export function getActiveAgents(): Agent[] {
  return queryAll(
    "SELECT * FROM agents WHERE status NOT IN ('done', 'crashed') ORDER BY created_at DESC"
  ).map(rowToAgent);
}

export function updateAgentStatus(id: string, status: AgentStatus): void {
  run("UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, id]);
}

export function updateAgentPid(id: string, pid: number | null): void {
  run("UPDATE agents SET pid = ?, updated_at = datetime('now') WHERE id = ?", [pid, id]);
}

export function updateAgentAttached(id: string, attached: boolean): void {
  run(
    "UPDATE agents SET is_attached = ?, last_attached_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    [attached ? 1 : 0, id]
  );
}

export function updateAgentExitCode(id: string, code: number): void {
  run("UPDATE agents SET last_exit_code = ?, updated_at = datetime('now') WHERE id = ?", [code, id]);
}

export function incrementRestartCount(id: string): void {
  run("UPDATE agents SET restart_count = restart_count + 1, updated_at = datetime('now') WHERE id = ?", [id]);
}

export function updateAgentLastOutput(id: string): void {
  run("UPDATE agents SET last_output_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [id]);
}

export function updateAgentResumeSessionId(id: string, sessionId: string): void {
  run("UPDATE agents SET resume_session_id = ?, updated_at = datetime('now') WHERE id = ?", [sessionId, id]);
}

export function addEvent(agentId: string, eventType: string, payload?: string): void {
  run('INSERT INTO events (agent_id, event_type, payload) VALUES (?, ?, ?)', [agentId, eventType, payload || null]);
}

// File activity operations
function rowToFileActivity(row: any): FileActivity {
  return {
    id: row.id,
    agentId: row.agent_id,
    filePath: row.file_path,
    operation: row.operation as FileOperation,
    timestamp: row.timestamp,
  };
}

export function addFileActivity(agentId: string, filePath: string, operation: FileOperation): FileActivity | null {
  // Dedup: skip if same (agent, file, operation) within last 5 seconds
  const recent = queryOne(
    `SELECT id FROM file_activities
     WHERE agent_id = ? AND file_path = ? AND operation = ?
     AND timestamp > datetime('now', '-5 seconds')`,
    [agentId, filePath, operation]
  );
  if (recent) return null;

  run(
    'INSERT INTO file_activities (agent_id, file_path, operation) VALUES (?, ?, ?)',
    [agentId, filePath, operation]
  );

  const row = queryOne(
    'SELECT * FROM file_activities WHERE agent_id = ? AND file_path = ? ORDER BY id DESC LIMIT 1',
    [agentId, filePath]
  );
  return row ? rowToFileActivity(row) : null;
}

export function getFileActivities(agentId: string, operation?: FileOperation): FileActivity[] {
  if (operation) {
    return queryAll(
      'SELECT * FROM file_activities WHERE agent_id = ? AND operation = ? ORDER BY timestamp DESC',
      [agentId, operation]
    ).map(rowToFileActivity);
  }
  return queryAll(
    'SELECT * FROM file_activities WHERE agent_id = ? ORDER BY timestamp DESC',
    [agentId]
  ).map(rowToFileActivity);
}

export function deleteAgent(id: string): void {
  run('DELETE FROM file_activities WHERE agent_id = ?', [id]);
  run('DELETE FROM events WHERE agent_id = ?', [id]);
  run('DELETE FROM agents WHERE id = ?', [id]);
}

export function checkAgentMdExists(workingDirectory: string, pathType: string): { found: boolean; fileName: string | null } {
  const candidates = ['agent.md', 'AGENT.md'];

  if (pathType === 'wsl') {
    const { execFileSync } = require('child_process');
    for (const name of candidates) {
      try {
        execFileSync('wsl.exe', ['bash', '-lc', `test -f '${workingDirectory}/${name}' && echo found`], {
          encoding: 'utf-8',
          timeout: 3000,
        });
        return { found: true, fileName: name };
      } catch {
        // not found
      }
    }
  } else {
    const path = require('path');
    const fs = require('fs');
    for (const name of candidates) {
      const fullPath = path.join(workingDirectory, name);
      if (fs.existsSync(fullPath)) {
        return { found: true, fileName: name };
      }
    }
  }
  return { found: false, fileName: null };
}

export function getWorkspaceAgentSummary(): { workspaceId: string; activeCount: number; workingCount: number }[] {
  return queryAll(`
    SELECT workspace_id,
      COUNT(*) as active_count,
      SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END) as working_count
    FROM agents
    WHERE status NOT IN ('done', 'crashed')
    GROUP BY workspace_id
  `).map(row => ({
    workspaceId: row.workspace_id,
    activeCount: row.active_count,
    workingCount: row.working_count,
  }));
}
