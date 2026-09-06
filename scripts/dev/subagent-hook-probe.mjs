#!/usr/bin/env node

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'Stop',
];

const SCENARIOS = [
  {
    id: 'A',
    label: 'one foreground child',
    prompt: [
      'Run exactly one Agent tool call in the foreground (do not set run_in_background).',
      'Use subagent_type general-purpose. Tell the child to return exactly FOREGROUND_CHILD_DONE without using tools.',
      'After the child result arrives, answer exactly PARENT_A_FINAL FOREGROUND_CHILD_DONE.',
    ].join(' '),
  },
  {
    id: 'B',
    label: 'one background Explore child',
    prompt: [
      'Launch exactly one Agent tool call with subagent_type Explore and run_in_background true.',
      'Tell the child to use Bash to run powershell -NoProfile -Command "Start-Sleep -Seconds 3", then return exactly BACKGROUND_CHILD_DONE.',
      'You must wait for and consume the background result before answering.',
      'After consuming it, answer exactly PARENT_B_FINAL BACKGROUND_CHILD_DONE.',
    ].join(' '),
  },
  {
    id: 'C',
    label: 'two overlapping background children, reverse completion order',
    prompt: [
      'Launch exactly two Agent tool calls in one parallel tool-use message, both with run_in_background true and subagent_type Explore.',
      'The first-started child is SLOW: tell it to use Bash to run powershell -NoProfile -Command "Start-Sleep -Seconds 8", then return exactly SLOW_CHILD_DONE.',
      'The second-started child is FAST: tell it to use Bash to run powershell -NoProfile -Command "Start-Sleep -Seconds 2", then return exactly FAST_CHILD_DONE.',
      'You must wait for and consume both background results before answering.',
      'After consuming both, answer exactly PARENT_C_FINAL FAST_CHILD_DONE SLOW_CHILD_DONE.',
    ].join(' '),
  },
];

function fail(message) {
  process.stderr.write(`subagent-hook-probe: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = { mode: 'run', scenario: 'all', outputDir: null, credentialFile: null };
  if (argv[0] === '--record') {
    if (argv.length !== 3) fail('--record requires <jsonl-path> <sequence-path>');
    return { mode: 'record', logPath: resolve(argv[1]), sequencePath: resolve(argv[2]) };
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output-dir') parsed.outputDir = argv[++i];
    else if (arg === '--scenario') parsed.scenario = String(argv[++i] ?? '').toUpperCase();
    else if (arg === '--credential-file') parsed.credentialFile = argv[++i];
    else if (arg === '--help' || arg === '-h') parsed.mode = 'help';
    else fail(`unknown argument: ${arg}`);
  }
  return parsed;
}

function acquireLock(lockPath) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // Atomics.wait provides a synchronous pause without launching another process.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw new Error(`timed out acquiring sequence lock: ${lockPath}`);
}

function recordHook(logPath, sequencePath) {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { stdin += chunk; });
  process.stdin.on('end', () => {
    let rawStdin;
    try {
      rawStdin = JSON.parse(stdin);
    } catch {
      rawStdin = { parse_error: true, raw_text: stdin };
    }

    mkdirSync(dirname(logPath), { recursive: true });
    const lockPath = `${sequencePath}.lock`;
    acquireLock(lockPath);
    try {
      const previous = existsSync(sequencePath)
        ? Number.parseInt(readFileSync(sequencePath, 'utf8'), 10)
        : 0;
      const sequence = Number.isFinite(previous) ? previous + 1 : 1;
      writeFileSync(sequencePath, `${sequence}\n`, 'utf8');
      appendFileSync(logPath, `${JSON.stringify({
        raw_stdin: rawStdin,
        argv: process.argv,
        claude_hook_event_name: process.env.CLAUDE_HOOK_EVENT_NAME ?? null,
        host_timestamp_ms: Date.now(),
        sequence,
      })}\n`, 'utf8');
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  });
}

function quoteCommandArg(value) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function hookSettings(command) {
  const commandHook = () => [{ hooks: [{ type: 'command', command }] }];
  return {
    hooks: {
      SessionStart: commandHook(),
      UserPromptSubmit: commandHook(),
      PreToolUse: [{ matcher: 'Agent', hooks: [{ type: 'command', command }] }],
      SubagentStart: commandHook(),
      SubagentStop: commandHook(),
      Notification: commandHook(),
      Stop: commandHook(),
    },
  };
}

function assertSafeOutputDir(outputDir) {
  const normalized = resolve(outputDir).replaceAll('\\', '/').toLowerCase();
  const forbidden = ['/\.lares/workers/', '/\.lares/supervisor/', '/\.claude/', '/\.codex/'];
  if (!isAbsolute(resolve(outputDir)) || forbidden.some((part) => normalized.includes(part))) {
    fail(`output directory is not an isolated scratch path: ${outputDir}`);
  }
  if (!normalized.startsWith(resolve(tmpdir(), 'claude').replaceAll('\\', '/').toLowerCase() + '/')) {
    fail(`output directory must be beneath the Claude session scratchpad ${resolve(tmpdir(), 'claude')}`);
  }
  if (existsSync(outputDir)) fail(`output directory already exists: ${outputDir}`);
}

function runClaude({ args, cwd, env, stdoutPath, stderrPath }) {
  return new Promise((resolveRun, rejectRun) => {
    const stdoutFd = openSync(stdoutPath, 'wx');
    const stderrFd = openSync(stderrPath, 'wx');
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', stdoutFd, stderrFd], windowsHide: true });
    child.on('error', (error) => {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      rejectRun(error);
    });
    child.on('close', (code, signal) => {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      if (code === 0) resolveRun();
      else rejectRun(new Error(`claude exited with code ${code}, signal ${signal ?? 'none'}; see ${stderrPath}`));
    });
  });
}

async function runProbe(parsed) {
  const scriptPath = resolve(process.argv[1]);
  const outputDir = resolve(parsed.outputDir ?? join(tmpdir(), 'claude', `lares-wp1-${Date.now()}-${randomUUID()}`));
  assertSafeOutputDir(outputDir);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, '.lares-scratch.json'), `${JSON.stringify({
    schema_version: 1,
    purpose: 'plan_11bfa6ab WP-1 Claude subagent hook probe',
    created_at: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');

  const selected = parsed.scenario === 'ALL'
    ? SCENARIOS
    : SCENARIOS.filter((scenario) => scenario.id === parsed.scenario);
  if (selected.length === 0) fail('--scenario must be A, B, C, or all');

  let oauthToken = null;
  if (parsed.credentialFile) {
    const credentialFile = resolve(parsed.credentialFile);
    if (!existsSync(credentialFile)) fail(`credential file does not exist: ${credentialFile}`);
    const credentialObject = JSON.parse(readFileSync(credentialFile, 'utf8'));
    oauthToken = credentialObject?.claudeAiOauth?.accessToken ?? null;
    if (typeof oauthToken !== 'string' || oauthToken.length === 0) {
      fail('credential file has no claudeAiOauth.accessToken');
    }
  }

  const logPath = join(outputDir, 'hooks.jsonl');
  const sequencePath = join(outputDir, 'sequence.txt');
  const hookCommand = [process.execPath, scriptPath, '--record', logPath, sequencePath]
    .map(quoteCommandArg)
    .join(' ');
  const manifest = {
    schema_version: 1,
    claude_version: null,
    started_at: new Date().toISOString(),
    output_dir: outputDir,
    hook_log: logPath,
    registered_hooks: HOOK_EVENTS,
    scenarios: [],
  };

  for (const scenario of selected) {
    const scenarioDir = join(outputDir, `scenario-${scenario.id.toLowerCase()}`);
    const isolatedHome = join(scenarioDir, 'home');
    const configDir = join(isolatedHome, 'claude-config');
    mkdirSync(configDir, { recursive: true });
    const settingsPath = join(scenarioDir, 'settings.json');
    writeFileSync(settingsPath, `${JSON.stringify(hookSettings(hookCommand), null, 2)}\n`, 'utf8');
    const stdoutPath = join(scenarioDir, 'parent.stream.jsonl');
    const stderrPath = join(scenarioDir, 'parent.stderr.log');
    const sessionId = randomUUID();
    const env = {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
    };
    const args = [
      '-p', scenario.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-hook-events',
      '--settings', settingsPath,
      '--setting-sources', '',
      '--strict-mcp-config',
      '--no-chrome',
      '--disable-slash-commands',
      '--dangerously-skip-permissions',
      '--allowed-tools', 'Agent,Bash',
      '--session-id', sessionId,
    ];
    manifest.scenarios.push({
      id: scenario.id,
      label: scenario.label,
      requested_session_id: sessionId,
      isolated_home: isolatedHome,
      claude_config_dir: configDir,
      settings_path: settingsPath,
      parent_stream_path: stdoutPath,
      parent_stderr_path: stderrPath,
      prompt: scenario.prompt,
      status: 'running',
    });
    writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await runClaude({ args, cwd: scenarioDir, env, stdoutPath, stderrPath });
    manifest.scenarios.at(-1).status = 'complete';
    manifest.scenarios.at(-1).completed_at = new Date().toISOString();
    writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  manifest.completed_at = new Date().toISOString();
  writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`${outputDir}\n`);
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.mode === 'record') recordHook(parsed.logPath, parsed.sequencePath);
else if (parsed.mode === 'help') {
  process.stdout.write('Usage: node scripts/dev/subagent-hook-probe.mjs [--scenario A|B|C|all] [--output-dir <absolute scratch path>] [--credential-file <read-only source>]\n');
} else {
  await runProbe(parsed).catch((error) => fail(error.stack ?? String(error)));
}
