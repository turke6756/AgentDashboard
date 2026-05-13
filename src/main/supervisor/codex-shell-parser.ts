import path from 'path';
import type { FileOperation } from '../../shared/types';

export interface ParsedShellActivity {
  filePath: string;
  operation: FileOperation;
}

/**
 * Conservative best-effort parser for the `command` string codex sends through
 * its `shell_command` tool. We only emit activity for high-confidence patterns
 * — when in doubt, return nothing. Misses are silent and acceptable; bad data
 * pollutes the UI.
 *
 * `workdir` is the cwd the shell will run in (codex's `arguments.workdir`).
 * Relative paths are resolved against it.
 *
 * Recognized read patterns:
 *   - `cat <path>`, `head [-n N] <path>`, `tail [-n N] <path>`, `nl <path>`, `wc <path>`
 *   - `sed -n '<range>' <path>` (only with `-n`; without `-n`, sed can write)
 *   - `Get-Content [-LiteralPath] <path>`
 *   - `type <path>` (only when arg looks like a path, to avoid the unix `type` builtin)
 *   - `Select-String -LiteralPath <path>`
 *   - `rg <pattern> <file>` (only when the second arg looks like a filename)
 *
 * Recognized write/create patterns:
 *   - `Set-Content [-LiteralPath] <path>` → write
 *   - `Add-Content [-LiteralPath] <path>` → write (append)
 *   - `Out-File [-LiteralPath] <path>` → create
 *   - `New-Item -Path <path>` → create
 *   - shell redirect `> <path>` → create
 *   - shell redirect `>> <path>` → write
 *
 * Skipped (intentionally): `ls`, `find`, `Get-ChildItem`, `dir`, bare `rg <pattern>`,
 * `chmod`, `mv`, `cp`, command substitution `$(...)`, pipelines past the first
 * command, `xargs`, `for`/`foreach` loops.
 */
export function parseShellCommand(command: string, workdir: string): ParsedShellActivity[] {
  if (!command || typeof command !== 'string') return [];
  if (hasComplexShellConstruct(command)) return [];
  const scanCommand = command.split('|', 1)[0] || command;
  const out: ParsedShellActivity[] = [];

  // Shell redirects — `>>` (append) before `>` (overwrite). The `(?<!>)` lookbehind
  // prevents `>>` from matching twice.
  let m: RegExpExecArray | null;
  const appendRe = /(?<![>])>>\s*(['"]?)([^\s'"|;>]+)\1/g;
  while ((m = appendRe.exec(scanCommand)) !== null) pushPath(out, m[2], workdir, 'write');
  const overwriteRe = /(?<![>])>(?!>)\s*(['"]?)([^\s'"|;>]+)\1/g;
  while ((m = overwriteRe.exec(scanCommand)) !== null) pushPath(out, m[2], workdir, 'create');

  // PowerShell content cmdlets — single regex captures quoted-OR-bare path.
  collectPowerShellCmdlet(out, scanCommand, workdir, 'Get-Content', 'read', {
    pathFlags: ['Path', 'LiteralPath'],
    valueFlags: ['TotalCount', 'Tail', 'ReadCount', 'Encoding', 'Delimiter', 'Filter', 'Include', 'Exclude', 'Stream', 'Credential'],
    switchFlags: ['Raw', 'Wait', 'Force'],
    allowPositionalPath: true,
  });
  collectPowerShellCmdlet(out, scanCommand, workdir, 'Select-String', 'read', {
    pathFlags: ['Path', 'LiteralPath'],
    valueFlags: ['Pattern', 'Encoding', 'Context', 'Include', 'Exclude', 'Culture'],
    switchFlags: ['CaseSensitive', 'SimpleMatch', 'Quiet', 'List', 'NotMatch', 'AllMatches', 'Raw', 'NoEmphasis'],
    allowPositionalPath: false,
  });
  collectPowerShellCmdlet(out, scanCommand, workdir, 'Set-Content', 'write', {
    pathFlags: ['Path', 'LiteralPath'],
    valueFlags: ['Value', 'Encoding', 'Filter', 'Include', 'Exclude', 'Stream', 'Credential'],
    switchFlags: ['NoNewline', 'Force', 'Append'],
    allowPositionalPath: true,
  });
  collectPowerShellCmdlet(out, scanCommand, workdir, 'Add-Content', 'write', {
    pathFlags: ['Path', 'LiteralPath'],
    valueFlags: ['Value', 'Encoding', 'Filter', 'Include', 'Exclude', 'Stream', 'Credential'],
    switchFlags: ['NoNewline', 'Force'],
    allowPositionalPath: true,
  });
  collectPowerShellCmdlet(out, scanCommand, workdir, 'Out-File', 'create', {
    pathFlags: ['FilePath', 'LiteralPath', 'Path'],
    valueFlags: ['InputObject', 'Encoding', 'Width'],
    switchFlags: ['Append', 'NoClobber', 'NoNewline', 'Force'],
    allowPositionalPath: true,
  });
  collectPowerShellCmdlet(out, scanCommand, workdir, 'New-Item', 'create', {
    pathFlags: ['Path', 'LiteralPath'],
    valueFlags: ['Name', 'ItemType', 'Value'],
    switchFlags: ['Force'],
    allowPositionalPath: true,
  });

  // Unix read commands. Allow `-n 50`-style flag/value pairs between command and path.
  collectUnixRead(out, scanCommand, workdir, /\b(?:cat|head|tail|nl|wc)\b/g);
  // sed -n '<range>' <file>
  const sedRe = /\bsed\s+-n\s+(?:'[^']*'|"[^"]*")\s+(?:'([^']+)'|"([^"]+)"|(\S+))/g;
  while ((m = sedRe.exec(scanCommand)) !== null) {
    const p = m[1] || m[2] || m[3];
    if (p) pushPath(out, p, workdir, 'read');
  }
  // `type foo.md` — Windows/PowerShell. Require pathy-looking arg to avoid unix `type` builtin.
  collectIfPathy(out, scanCommand, workdir, /\btype\s+(?:'([^']+)'|"([^"]+)"|(\S+))/gi, 'read');
  // `rg <pattern> <file>` — pattern is the first non-flag token; require file arg to look pathy.
  const rgRe = /\brg\b(?:\s+-[^\s]+(?:\s+\S+)?)*\s+\S+\s+(?:'([^']+)'|"([^"]+)"|(\S+))/g;
  while ((m = rgRe.exec(scanCommand)) !== null) {
    const p = m[1] || m[2] || m[3];
    if (p && looksLikePath(p)) pushPath(out, p, workdir, 'read');
  }

  return dedup(out);
}

/** Parse codex's `apply_patch` input (a patch envelope with `*** Update File:` headers). */
export function parseApplyPatch(patchText: string, workdir: string): ParsedShellActivity[] {
  if (!patchText || typeof patchText !== 'string') return [];
  const out: ParsedShellActivity[] = [];
  let m: RegExpExecArray | null;

  const updateRe = /^\*\*\*\s+Update File:\s+(.+?)\s*$/gm;
  while ((m = updateRe.exec(patchText)) !== null) pushPath(out, m[1], workdir, 'write');

  const addRe = /^\*\*\*\s+Add File:\s+(.+?)\s*$/gm;
  while ((m = addRe.exec(patchText)) !== null) pushPath(out, m[1], workdir, 'create');

  return dedup(out);
}

/**
 * Parse codex's tool-result `output` text and decide if the underlying command
 * succeeded. Codex prefixes `function_call_output.output` with
 * `"Exit code: <N>\nWall time: …\n"`. Treat absence of the prefix as success.
 */
export function shellResultIndicatesSuccess(output: string): boolean {
  if (!output) return true;
  const m = /^Exit code:\s*(-?\d+)/m.exec(output);
  if (!m) return true;
  return m[1] === '0';
}

// ── Helpers ──────────────────────────────────────────────────────────

interface PowerShellCmdletOptions {
  pathFlags: string[];
  valueFlags: string[];
  switchFlags: string[];
  allowPositionalPath: boolean;
}

function collectPowerShellCmdlet(
  out: ParsedShellActivity[],
  command: string,
  workdir: string,
  cmdlet: string,
  op: FileOperation,
  options: PowerShellCmdletOptions
): void {
  const headerRe = new RegExp(`\\b${escapeRegExp(cmdlet)}\\b`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(command)) !== null) {
    const after = command.slice(headerRe.lastIndex);
    const tokens = tokenizePowerShellArgs(after);
    const p = extractPowerShellPath(tokens, options);
    if (!p) continue;
    pushPath(out, p, workdir, op);
  }
}

function extractPowerShellPath(tokens: string[], options: PowerShellCmdletOptions): string | null {
  const pathFlags = new Set(options.pathFlags.map((f) => f.toLowerCase()));
  const valueFlags = new Set(options.valueFlags.map((f) => f.toLowerCase()));
  const switchFlags = new Set(options.switchFlags.map((f) => f.toLowerCase()));

  for (let i = 0; i < tokens.length; i++) {
    const name = flagName(tokens[i]);
    if (!name || !pathFlags.has(name)) continue;
    const value = tokens[i + 1];
    if (value && !flagName(value)) return value;
    return null;
  }

  if (!options.allowPositionalPath) return null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const name = flagName(token);
    if (!name) return token;
    if (pathFlags.has(name)) return null;
    if (valueFlags.has(name)) {
      i += 1;
      continue;
    }
    if (switchFlags.has(name)) continue;
    return null;
  }

  return null;
}

function tokenizePowerShellArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '>' || ch === '\n' || ch === '\r') break;
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

function flagName(token: string | undefined): string | null {
  if (!token || !token.startsWith('-') || token === '-') return null;
  return token.replace(/^-+/, '').toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a unix-y read command (`cat`/`head`/`tail`/...). Allow short flags with
 * optional values (e.g. `-n 50`) between the command and the path.
 */
function collectUnixRead(out: ParsedShellActivity[], command: string, workdir: string, headerRe: RegExp): void {
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(command)) !== null) {
    const after = command.slice(headerRe.lastIndex);
    // Strip leading flag/value pairs: `-n 50 ` or `-foo `
    const stripped = after.replace(/^(\s+-[A-Za-z]+\b(?:\s+\d+)?)+/, '');
    const pathMatch = /^\s*(?:'([^']+)'|"([^"]+)"|([^\s|;>]+))/.exec(stripped);
    if (!pathMatch) continue;
    const p = pathMatch[1] || pathMatch[2] || pathMatch[3];
    if (!p) continue;
    if (p.startsWith('-')) continue;
    pushPath(out, p, workdir, 'read');
  }
}

function collectIfPathy(
  out: ParsedShellActivity[],
  command: string,
  workdir: string,
  re: RegExp,
  op: FileOperation
): void {
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const p = m[1] || m[2] || m[3];
    if (!p) continue;
    if (!looksLikePath(p)) continue;
    pushPath(out, p, workdir, op);
  }
}

function hasComplexShellConstruct(command: string): boolean {
  return /\$\(|`/.test(command) || /\b(?:for|foreach|while|xargs)\b/i.test(command);
}

function looksLikePath(s: string): boolean {
  return s.includes('.') || s.includes('/') || s.includes('\\');
}

function pushPath(out: ParsedShellActivity[], rawPath: string, workdir: string, op: FileOperation): void {
  if (!rawPath || rawPath.startsWith('-')) return;
  const resolved = resolveAgainstWorkdir(rawPath, workdir);
  if (!resolved) return;
  out.push({ filePath: resolved, operation: op });
}

function resolveAgainstWorkdir(raw: string, workdir: string): string | null {
  // Unix absolute path FIRST — node's path.isAbsolute returns true for `/etc/hosts`
  // even on Windows, and we don't want to backslash-normalize unix paths.
  if (raw.startsWith('/')) return raw;
  // Windows absolute (drive-letter or UNC).
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) return normalizeWinPath(raw);
  if (!workdir) return null;
  if (workdir.startsWith('/')) {
    return `${workdir.replace(/\/+$/, '')}/${raw.replace(/\\/g, '/')}`;
  }
  return normalizeWinPath(path.join(workdir, raw));
}

function normalizeWinPath(p: string): string {
  return p.replace(/\//g, '\\');
}

function dedup(items: ParsedShellActivity[]): ParsedShellActivity[] {
  const seen = new Set<string>();
  const out: ParsedShellActivity[] = [];
  for (const it of items) {
    const key = `${it.operation}:${it.filePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}
