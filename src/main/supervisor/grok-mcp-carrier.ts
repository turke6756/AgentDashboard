import fs from 'node:fs';
import path from 'node:path';

export interface GrokMcpCarrierOptions {
  runtimePath: string;
  sidecarPath: string;
  toolsets: string;
}

export interface GrokMcpDispositionFacts {
  expectedCarrierText: string;
  actualCarrierText: string | null;
  runtimeExists: boolean;
  sidecarExists: boolean;
  tokenWillBeInjected: boolean;
  canonicalWorkerCwd: boolean;
  trustEligible: boolean;
}

export interface GrokMcpDisposition {
  status: 'available' | 'degraded';
  reason: string | null;
}

/** Escape a value for a TOML basic string without relying on a parser package. */
export function tomlEscapeBasicString(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f"\\]/g, (character) => {
    switch (character) {
      case '\b': return '\\b';
      case '\t': return '\\t';
      case '\n': return '\\n';
      case '\f': return '\\f';
      case '\r': return '\\r';
      case '"': return '\\"';
      case '\\': return '\\\\';
      default: return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  });
}

export function buildGrokMcpCarrierToml(options: GrokMcpCarrierOptions): string {
  const runtimePath = tomlEscapeBasicString(options.runtimePath.replace(/\\/g, '/'));
  const sidecarPath = tomlEscapeBasicString(options.sidecarPath.replace(/\\/g, '/'));
  const toolsets = tomlEscapeBasicString(options.toolsets);
  return [
    '[mcp_servers.agent-dashboard]',
    `command = "${runtimePath}"`,
    `args = ["${sidecarPath}"]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 6000',
    `env = { ELECTRON_RUN_AS_NODE = "1", AGENT_DASHBOARD_API_TOKEN = "\${AGENT_DASHBOARD_API_TOKEN}", AGENT_DASHBOARD_API_PORT = "\${AGENT_DASHBOARD_API_PORT}", AGENT_DASHBOARD_API_HOST = "\${AGENT_DASHBOARD_API_HOST}", AGENT_DASHBOARD_SELF_ID = "\${AGENT_DASHBOARD_SELF_ID}", AGENT_DASHBOARD_WORKSPACE_ID = "\${AGENT_DASHBOARD_WORKSPACE_ID}", DASHBOARD_MCP_TOOLSETS = "${toolsets}" }`,
    '',
  ].join('\n');
}

export function assessGrokMcpDisposition(facts: GrokMcpDispositionFacts): GrokMcpDisposition {
  if (facts.actualCarrierText === null) {
    return { status: 'degraded', reason: 'Dashboard MCP carrier is absent from the Grok worker cwd.' };
  }
  if (facts.actualCarrierText !== facts.expectedCarrierText) {
    return { status: 'degraded', reason: 'Dashboard MCP carrier does not match the expected Grok worker scaffold.' };
  }
  if (!facts.runtimeExists) {
    return { status: 'degraded', reason: 'Dashboard MCP runtime path does not exist for this Grok launch.' };
  }
  if (!facts.sidecarExists) {
    return { status: 'degraded', reason: 'Dashboard MCP sidecar path does not exist for this Grok launch.' };
  }
  if (!facts.canonicalWorkerCwd) {
    return { status: 'degraded', reason: 'Grok worker cwd is not the canonical workspace worker lane.' };
  }
  if (!facts.trustEligible) {
    return { status: 'degraded', reason: 'Grok worker cwd is not trusted for project MCP discovery.' };
  }
  if (!facts.tokenWillBeInjected) {
    return { status: 'degraded', reason: 'Grok launch environment lacks the per-agent dashboard capability token.' };
  }
  return { status: 'available', reason: null };
}

function grokGitRootOrSelf(dir: string): string {
  let best: string | null = null;
  let current = dir;
  for (;;) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) best = current;
    } catch { /* unreadable ancestor is not a trust root */ }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return best ?? dir;
}

function grokTrustPathKey(dir: string): string | null {
  if (!dir || !path.isAbsolute(dir)) return null;
  const root = grokGitRootOrSelf(dir);
  let key: string;
  try { key = fs.realpathSync.native(root); } catch { key = root; }
  if (path.dirname(key) === key) return null;
  const home = (process.env.USERPROFILE || process.env.HOME || '').replace(/[\\/]+$/, '');
  const normalized = key.replace(/[\\/]+$/, '') || key;
  if (home && normalized.toLowerCase() === home.toLowerCase()) return null;
  return key;
}

function unescapeTomlBasicString(value: string): string {
  return value.replace(/\\([\\"])/g, '$1');
}

/** Read Grok's effective trust record without modifying the provider home. */
export function isGrokCwdTrusted(cwd: string): boolean {
  if (process.platform !== 'win32') return false;
  const key = grokTrustPathKey(cwd);
  if (!key) return false;
  const grokHome = process.env.GROK_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.grok');
  const trustPath = path.join(grokHome, 'trusted_folders.toml');
  let source: string;
  try { source = fs.readFileSync(trustPath, 'utf8'); } catch { return false; }
  const lines = source.split(/\r?\n/);
  const header = /^\s*\[\s*folders\s*\.\s*"((?:[^"\\]|\\.)*)"\s*\]\s*$/;
  for (let i = 0; i < lines.length; i += 1) {
    const match = header.exec(lines[i]);
    if (!match || unescapeTomlBasicString(match[1]) !== key) continue;
    for (let j = i + 1; j < lines.length && !/^\s*\[/.test(lines[j]); j += 1) {
      if (/^\s*trusted\s*=\s*true\b/.test(lines[j])) return true;
      if (/^\s*trusted\s*=\s*false\b/.test(lines[j])) return false;
    }
    return false;
  }
  return false;
}
