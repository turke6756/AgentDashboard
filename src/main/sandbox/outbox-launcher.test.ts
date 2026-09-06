import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import {
  NON_WINDOWS_OUTBOX_SKIP_MARKER,
  OUTBOX_AUDIT_MARKER,
  prepareRestrictedOutboxLaunch,
} from './outbox-launcher';

const SPEC_ENV = 'LARES_RESTRICTED_OUTBOX_SPEC_B64';

function explicitSidGrantCount(directory: string, sid: string): number {
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const script = [
    `$acl = Get-Acl -LiteralPath ${JSON.stringify(directory)}`,
    `$count = @($acl.Access | Where-Object { $_.IdentityReference.Value -eq ${JSON.stringify(sid)} -and -not $_.IsInherited }).Count`,
    `[Console]::Out.Write($count)`,
  ].join('; ');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `ACL inspection failed: ${result.stderr}`);
  return Number(result.stdout.trim());
}

function setSidModifyRule(directory: string, sid: string, add: boolean): void {
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const operation = add ? '$acl.AddAccessRule($rule)' : '[void]$acl.RemoveAccessRuleSpecific($rule)';
  const script = [
    `$directory = [IO.DirectoryInfo]::new(${JSON.stringify(directory)})`,
    `$acl = $directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)`,
    `$sid = [Security.Principal.SecurityIdentifier]::new(${JSON.stringify(sid)})`,
    `$rights = [Security.AccessControl.FileSystemRights]::Modify -bor [Security.AccessControl.FileSystemRights]::Synchronize`,
    `$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit`,
    `$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)`,
    operation,
    `$directory.SetAccessControl($acl)`,
  ].join('; ');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${sid} ACL ${add ? 'setup' : 'cleanup'} failed: ${result.stderr}`);
}

function setEveryoneModifyRule(directory: string, add: boolean): void {
  setSidModifyRule(directory, 'S-1-1-0', add);
}

test('non-Windows callers get a loud skip marker', () => {
  assert.throws(
    () => prepareRestrictedOutboxLaunch({ command: 'x', args: [], cwd: '.', outbox: '.' }, { platform: 'linux' }),
    new RegExp(NON_WINDOWS_OUTBOX_SKIP_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
});

test('token-establishment failure fails closed before returning a launch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-outbox-fail-'));
  const outbox = path.join(root, 'outbox');
  try {
    assert.throws(
      () => prepareRestrictedOutboxLaunch(
        { command: process.execPath, args: [], cwd: root, outbox },
        { platform: 'win32', runPreflight: () => { throw new Error('synthetic probe failure'); } },
      ),
      /FAIL_CLOSED.*restricted token could not be established.*synthetic probe failure/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('grant roots are canonicalized and case-insensitively deduplicated before preflight', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-grant-roots-'));
  const inbox = path.join(root, 'inbox');
  const home = path.join(root, 'home');
  let observedGrantRoots: string[] = [];
  try {
    fs.mkdirSync(inbox);
    fs.mkdirSync(home);
    const prepared = prepareRestrictedOutboxLaunch({
      command: process.execPath,
      args: [],
      cwd: root,
      grantRoots: [inbox, path.join(inbox, '.'), home],
      auditRoots: [root],
    }, {
      platform: 'win32',
      runPreflight: (_command, args, env) => {
        const spec = JSON.parse(Buffer.from(env[SPEC_ENV]!, 'base64').toString('utf8')) as { grantRoots: string[] };
        observedGrantRoots = spec.grantRoots;
        fs.rmSync(args[args.indexOf('-File') + 1], { force: true });
      },
    });
    assert.deepEqual(observedGrantRoots, [fs.realpathSync.native(inbox), fs.realpathSync.native(home)],
      'REACHABILITY:restricted-launch-multiroot must send one canonical entry per grant root');
    fs.rmSync(prepared.args[prepared.args.indexOf('-File') + 1], { force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shipping Claude launch shape grants the inbox and redirected per-agent home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-shipping-grants-'));
  const inbox = path.join(root, 'inbox');
  const home = path.join(root, 'agent-home');
  let observedGrantRoots: string[] = [];
  try {
    const prepared = prepareRestrictedOutboxLaunch({
      command: process.execPath,
      args: [],
      cwd: root,
      outbox: inbox,
      auditRoots: [root],
      env: { CLAUDE_CONFIG_DIR: home },
    }, {
      platform: 'win32',
      runPreflight: (_command, args, env) => {
        const spec = JSON.parse(Buffer.from(env[SPEC_ENV]!, 'base64').toString('utf8')) as { grantRoots: string[] };
        observedGrantRoots = spec.grantRoots;
        fs.rmSync(args[args.indexOf('-File') + 1], { force: true });
      },
    });
    assert.deepEqual(observedGrantRoots, [fs.realpathSync.native(inbox), fs.realpathSync.native(home)],
      'REACHABILITY:restricted-launch-multiroot production shape must carry inbox plus agent home');
    fs.rmSync(prepared.args[prepared.args.indexOf('-File') + 1], { force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generated launcher excludes Everyone from restricting SIDs but retains the independent default DACL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-restricting-sids-'));
  const inbox = path.join(root, 'inbox');
  let bootstrapSource = '';
  try {
    const prepared = prepareRestrictedOutboxLaunch({
      command: process.execPath,
      args: [],
      cwd: root,
      grantRoots: [inbox],
      auditRoots: [root],
    }, {
      platform: 'win32',
      runPreflight: (_command, args) => {
        const bootstrapPath = args[args.indexOf('-File') + 1];
        bootstrapSource = fs.readFileSync(bootstrapPath, 'utf8');
        fs.rmSync(bootstrapPath, { force: true });
      },
    });
    const restrictingGroupBlock = bootstrapSource.match(
      /var groups = new \[\] \{([\s\S]*?)\n\s*\};\n\s*if \(!CreateRestrictedToken/,
    )?.[1];
    assert.ok(restrictingGroupBlock, 'real generated bootstrap must contain the CreateRestrictedToken group artifact');
    assert.match(restrictingGroupBlock, /Sid = sid, Attributes = 0/);
    assert.match(restrictingGroupBlock, /Sid = logonSid, Attributes = 0/);
    assert.doesNotMatch(restrictingGroupBlock, /everyoneSid/,
      'Everyone must not reach the restricting SID list');
    assert.match(bootstrapSource,
      /SetCapabilityDefaultDacl\(restricted, new \[\] \{ logonSid, everyoneSid, sid \}\);/,
      'the separately probed default DACL must retain its launch-compatible SID list');
    fs.rmSync(prepared.args[prepared.args.indexOf('-File') + 1], { force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('grant roots reject nested reparse points before any ACL mutation', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows junctions are unavailable on this platform');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-grant-reparse-'));
  const grantRoot = path.join(root, 'home');
  const target = path.join(root, 'target');
  fs.mkdirSync(grantRoot);
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(grantRoot, 'junction'), 'junction');
  let preflightRan = false;
  try {
    assert.throws(() => prepareRestrictedOutboxLaunch({
      command: process.execPath,
      args: [],
      cwd: root,
      grantRoots: [grantRoot],
      auditRoots: [root],
    }, {
      platform: 'win32',
      runPreflight: () => { preflightRan = true; },
    }), /contains a reparse point/);
    assert.equal(preflightRan, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale restricted-launch bootstrap files are removed before setup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-stale-launch-'));
  const stale = path.join(root, '.lares-outbox-launch-S-1-5-21-1-2-3-4.ps1');
  fs.writeFileSync(stale, 'stale');
  try {
    assert.throws(() => prepareRestrictedOutboxLaunch({
      command: process.execPath,
      args: [],
      cwd: root,
      grantRoots: [path.join(root, 'inbox')],
    }, {
      platform: 'win32',
      runPreflight: () => { throw new Error('stop after stale cleanup'); },
    }), /stop after stale cleanup/);
    assert.equal(fs.existsSync(stale), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function resolveRelativeModule(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function reachableSourceModules(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const source = fs.readFileSync(resolved, 'utf8');
    const imports = source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g);
    for (const match of imports) {
      const child = resolveRelativeModule(resolved, match[1]);
      if (child) visit(child);
    }
  };
  visit(entry);
  return seen;
}

test('no live launch path resolves the restricted outbox launcher', () => {
  const supervisor = path.join(process.cwd(), 'src', 'main', 'supervisor', 'index.ts');
  const reachable = reachableSourceModules(supervisor);
  assert.equal(
    [...reachable].some((file) => path.basename(file) === 'outbox-launcher.ts'),
    false,
    'REACHABILITY:restricted-launch-unreferenced: live Windows, WSL, resume/revive, and fork graph must not reach outbox-launcher',
  );
  for (const file of reachable) {
    assert.doesNotMatch(
      fs.readFileSync(file, 'utf8'),
      /(?:import|export)\s+[^;\n]*\bprepareRestrictedOutboxLaunch\b/,
      `REACHABILITY:restricted-launch-unreferenced: ${file} must not resolve restricted launch symbol`,
    );
  }
});

test('main runner registers this suite ahead of the known fail-fast boundary', () => {
  const runnerSource = fs.readFileSync(path.join(process.cwd(), 'scripts', 'run-main-tests.mjs'), 'utf8');
  const thisSuite = runnerSource.indexOf("'dist/main/main/sandbox/outbox-launcher.test.js'");
  const failFastBoundary = runnerSource.indexOf("'dist/main/main/commit-engine/finalization-service.test.js'");
  assert.ok(thisSuite >= 0, 'outbox-launcher.test.ts must not remain a dead suite');
  assert.ok(thisSuite < failFastBoundary, 'outbox-launcher.test.ts must run ahead of finalization-service fail-fast');
});

test('partial multi-root setup removes every installed ACE', { timeout: 60_000 }, (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows ACLs are unavailable on this platform');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-partial-grant-'));
  const inbox = path.join(root, 'inbox');
  const home = path.join(root, 'home');
  const sidPart = 0x01010101;
  const sid = `S-1-5-21-${sidPart}-${sidPart}-${sidPart}-${sidPart}`;
  try {
    assert.throws(() => prepareRestrictedOutboxLaunch({
      command: process.execPath,
      args: [],
      cwd: root,
      grantRoots: [inbox, home],
      auditRoots: [root],
    }, {
      randomBytes: () => Buffer.alloc(16, 1),
      failAfterGrantCount: 1,
    }), /FAIL_CLOSED.*restricted token could not be established/);
    const inboxResidualGrants = explicitSidGrantCount(inbox, sid);
    const homeResidualGrants = explicitSidGrantCount(home, sid);
    t.diagnostic(`partial-failure residual grants: inbox=${inboxResidualGrants} home=${homeResidualGrants}`);
    assert.equal(inboxResidualGrants, 0,
      'partial failure must leave NO residual grant on the first root');
    assert.equal(homeResidualGrants, 0,
      'partial failure must leave NO residual grant on any later root');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Everyone-writable audit finding is reported but does not block launch', { timeout: 60_000 }, (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows junctions and ACLs are unavailable on this platform');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-audit-reparse-'));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-audit-external-'));
  const inbox = path.join(root, 'inbox');
  const junction = path.join(root, 'external-junction');
  fs.symlinkSync(external, junction, 'junction');
  setEveryoneModifyRule(external, true);
  try {
    const prepared = prepareRestrictedOutboxLaunch({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: root,
      grantRoots: [inbox],
      auditRoots: [root],
    });
    const result = spawnSync(prepared.command, prepared.args, {
      cwd: root,
      env: { ...process.env, ...prepared.env },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 45_000,
    });
    assert.equal(result.status, 0, `Everyone-only finding is no longer a restricting-SID bypass; stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.doesNotMatch(result.stderr, /FAIL_CLOSED/);
    const auditJson = result.stderr.match(/\[lares-outbox-audit\] (\{[^\r\n]+\})/)?.[1];
    assert.ok(auditJson, `audit marker missing: ${result.stderr}`);
    const audit = JSON.parse(auditJson) as { worldWritable: string[] };
    assert.ok(audit.worldWritable.some((item) => item.toLocaleLowerCase('en-US')
      === fs.realpathSync.native(external).toLocaleLowerCase('en-US')),
    'non-fatal Everyone telemetry must report the canonical target, not only the lexical junction path');
    assert.match(result.stderr, /"logonSidWritable":\[\]/);
  } finally {
    fs.unlinkSync(junction);
    setEveryoneModifyRule(external, false);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('logon-SID-writable directory outside grants fails closed', { timeout: 60_000 }, (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows logon SIDs and ACLs are unavailable on this platform');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-audit-logon-'));
  const inbox = path.join(root, 'inbox');
  const dangerous = path.join(root, 'logon-writable');
  fs.mkdirSync(dangerous);
  let logonSid = '';
  try {
    const discovery = prepareRestrictedOutboxLaunch({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: root,
      grantRoots: [inbox],
      auditRoots: [root],
    });
    const discoveryResult = spawnSync(discovery.command, discovery.args, {
      cwd: root,
      env: { ...process.env, ...discovery.env },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 45_000,
    });
    assert.equal(discoveryResult.status, 0, `logon SID discovery launch failed: ${discoveryResult.stderr}`);
    const auditJson = discoveryResult.stderr.match(/\[lares-outbox-audit\] (\{[^\r\n]+\})/)?.[1];
    assert.ok(auditJson, `audit marker missing from discovery launch: ${discoveryResult.stderr}`);
    logonSid = (JSON.parse(auditJson) as { logonSid: string }).logonSid;
    assert.match(logonSid, /^S-1-5-5-\d+-\d+$/);
    setSidModifyRule(dangerous, logonSid, true);

    // The child is a no-op that succeeds if reached; only the ACL audit should
    // turn this fixture into exit 126.
    const prepared = prepareRestrictedOutboxLaunch({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: root,
      grantRoots: [inbox],
      auditRoots: [root],
    });
    const result = spawnSync(prepared.command, prepared.args, {
      cwd: root,
      env: { ...process.env, ...prepared.env },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 45_000,
    });
    assert.equal(result.status, 126, `logon-SID bypass must fail closed; stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /FAIL_CLOSED.*logon-SID-writable directories outside the canonical grant roots/);
    assert.match(result.stderr.toLocaleLowerCase('en-US'), new RegExp(
      fs.realpathSync.native(dangerous).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').toLocaleLowerCase('en-US'),
    ));
  } finally {
    if (logonSid) setSidModifyRule(dangerous, logonSid, false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real Windows Node token preserves grants and drops Everyone writes', { timeout: 60_000 }, (t) => {
  if (process.platform !== 'win32') {
    t.diagnostic(`${NON_WINDOWS_OUTBOX_SKIP_MARKER} real restricted-token integration test`);
    t.skip('Windows restricted tokens are unavailable on this platform');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-outbox-real-'));
  const worldOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-outbox-world-'));
  const inbox = path.join(root, 'inbox');
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const inboxFile = path.join(inbox, 'inbox.txt');
  const homeFile = path.join(home, 'home.txt');
  const outsideFile = path.join(outside, 'outside.txt');
  const worldFile = path.join(worldOutside, 'world.txt');
  setEveryoneModifyRule(worldOutside, true);
  const childScript = [
    `const fs = require('fs')`,
    `let inbox = false, home = false, outsideDenied = false, worldDenied = false`,
    `try { fs.writeFileSync(${JSON.stringify(inboxFile)}, 'inbox-ok'); inbox = true } catch {}`,
    `try { fs.writeFileSync(${JSON.stringify(homeFile)}, 'home-ok'); home = true } catch {}`,
    `try { fs.writeFileSync(${JSON.stringify(outsideFile)}, 'outside-bad') } catch { outsideDenied = true }`,
    `try { fs.writeFileSync(${JSON.stringify(worldFile)}, 'world-bad') } catch { worldDenied = true }`,
    `console.log(JSON.stringify({ inbox, home, outsideDenied, worldDenied }))`,
    `process.exit(inbox && home && outsideDenied && worldDenied ? 0 : 9)`,
  ].join(';');

  try {
    const prepared = prepareRestrictedOutboxLaunch({
      command: process.execPath,
      args: ['-e', childScript],
      cwd: root,
      grantRoots: [inbox, home, path.join(inbox, '.')],
      auditRoots: [root],
    }, { randomBytes: () => Buffer.alloc(16, 2) });
    const result = spawnSync(prepared.command, prepared.args, {
      cwd: root,
      env: { ...process.env, ...prepared.env },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 45_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    t.diagnostic(`restricted child result: ${result.stdout.trim()}`);
    assert.match(result.stdout, /"inbox":true/);
    assert.match(result.stdout, /"home":true/);
    assert.match(result.stdout, /"outsideDenied":true/);
    assert.match(result.stdout, /"worldDenied":true/);
    assert.match(result.stderr, new RegExp(OUTBOX_AUDIT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(result.stderr, /"worldWritable":\[\]/);
    assert.equal(fs.readFileSync(inboxFile, 'utf8'), 'inbox-ok');
    assert.equal(fs.readFileSync(homeFile, 'utf8'), 'home-ok');
    assert.equal(fs.existsSync(outsideFile), false);
    assert.equal(fs.existsSync(worldFile), false);
    const sidPart = 0x02020202;
    const sid = `S-1-5-21-${sidPart}-${sidPart}-${sidPart}-${sidPart}`;
    assert.equal(explicitSidGrantCount(inbox, sid), 0, 'successful launch must clean the inbox grant');
    assert.equal(explicitSidGrantCount(home, sid), 0, 'successful launch must clean the home grant');
  } finally {
    setEveryoneModifyRule(worldOutside, false);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(worldOutside, { recursive: true, force: true });
  }
});
