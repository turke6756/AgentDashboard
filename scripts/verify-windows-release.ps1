<#
  verify-windows-release.ps1 - canonical post-dist Windows release gate.

  This verifies the unpacked build; it does not certify NSIS installation.
#>

[CmdletBinding()]
param(
  [ValidateSet('', 'NativeExit', 'ThrownError', 'NullExit')]
  [string]$TestGateFailure = '',
  [string]$UnpackedRoot = '',
  [switch]$ScaffoldOnly
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$release = Join-Path $Root 'release'
$unpacked = $(if ($UnpackedRoot) { $UnpackedRoot } else { Join-Path $release 'win-unpacked' })
$exe = Join-Path $unpacked 'Lares.exe'
$installer = Join-Path $release "Lares-Setup-$version-x64.exe"
$checksum = "$installer.sha256"
$payloadDir = Join-Path $unpacked 'resources\mingit'
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result([string]$name, [bool]$passed, [string]$detail) {
  $script:results.Add([pscustomobject]@{
    Check = $name
    Result = $(if ($passed) { 'PASS' } else { 'FAIL' })
    Detail = $detail
  })
}

function Invoke-Gate([string]$name, [string]$display, [scriptblock]$action) {
  Write-Host "`n== $name =="
  try {
    $global:LASTEXITCODE = $null
    & $action
    $code = $global:LASTEXITCODE
    if ($null -eq $code) {
      Add-Result $name $false "$display (native exit code unavailable)"
    } else {
      Add-Result $name ($code -eq 0) "$display (exit $code)"
    }
  } catch {
    Add-Result $name $false "$display ($($_.Exception.Message))"
  }
}

if ($TestGateFailure) {
  switch ($TestGateFailure) {
    'NativeExit' { Invoke-Gate 'self-test native failure' 'cmd exit 7' { & $env:ComSpec /c 'exit 7' } }
    'ThrownError' { Invoke-Gate 'self-test thrown failure' 'throw sentinel' { throw 'gate-throw-sentinel' } }
    'NullExit' { Invoke-Gate 'self-test null exit' 'no native exit code' { $global:LASTEXITCODE = $null } }
  }
  $results | Format-Table -AutoSize
  if (@($results | Where-Object { $_.Result -eq 'FAIL' }).Count -gt 0) { exit 1 }
  exit 0
}

Write-Host "== verify:windows-release ==  version=$version  root=$Root"

if (-not $ScaffoldOnly) {
  Invoke-Gate 'native ABI' 'npm run verify:native -- --strict --package <win-unpacked>' {
    Push-Location $Root
    try { & npm run verify:native -- --strict --package $unpacked }
    finally { Pop-Location }
  }

  Invoke-Gate 'Windows package' 'powershell -File scripts/verify-windows-package.ps1 -Strict' {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\verify-windows-package.ps1') -Strict
  }
}

$workspace = Join-Path $env:TEMP ("lares-release-WP-B-" + [Guid]::NewGuid().ToString('N'))
$appData = Join-Path $workspace 'appdata'
$priorAppData = $env:APPDATA
try {
  New-Item -ItemType Directory -Path $workspace | Out-Null
  New-Item -ItemType Directory -Path $appData | Out-Null
  $marker = @{
    schemaVersion = 1
    creator = 'verify-windows-release.ps1'
    workPackage = 'WP-B'
    disposition = 'disposable'
    creationId = [Guid]::NewGuid().ToString('N')
  } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText((Join-Path $workspace '.lares-scratch.json'), "$marker`r`n", (New-Object System.Text.UTF8Encoding($false)))

  $driver = Join-Path $workspace 'scaffold-release-workspace.cjs'
  $driverBody = @'
'use strict';
const [supervisorPath, databasePath, workspace] = process.argv.slice(2);
const fs = require('fs');
const path = require('path');
const Module = require('module');
const appData = path.join(workspace, 'appdata');
const asarMarker = `${path.sep}app.asar${path.sep}`;
const appRoot = supervisorPath.slice(0, supervisorPath.indexOf(asarMarker) + asarMarker.length - 1);
const packageVersion = require(path.join(appRoot, 'package.json')).version;
const electronStubId = path.join(__dirname, 'electron-stub.cjs');
require.cache[electronStubId] = {
  id: electronStubId,
  filename: electronStubId,
  loaded: true,
  exports: {
    app: {
      isPackaged: true,
      getPath(name) { return name === 'userData' ? appData : workspace; },
      getAppPath() { return appRoot; },
      getVersion() { return packageVersion; },
    },
    Notification: class Notification { show() {} },
  },
};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request === 'electron') return electronStubId;
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
const db = require(databasePath);
try {
  db.initDatabase();
  db.createWorkspace({ title: 'Lares release verification', path: workspace, pathType: 'windows' });
  const { AgentSupervisor } = require(supervisorPath);
  const supervisor = new AgentSupervisor();
  supervisor.ensureWorkspaceScripts(workspace, 'windows');
  supervisor.ensureWorkerScaffold(workspace, 'codex', 'windows');
  const statusHook = path.join(workspace, '.lares', 'scripts', 'dashboard-status.mjs');
  if (!fs.existsSync(statusHook)) throw new Error(`scaffold status hook missing: ${statusHook}`);
  console.log(`SCAFFOLD_STATUS_HOOK=${statusHook}`);
} finally {
  db.closeDatabase();
}
process.exit(0);
'@
  [System.IO.File]::WriteAllText($driver, $driverBody, (New-Object System.Text.UTF8Encoding($false)))
  $supervisorModule = Join-Path $unpacked 'resources\app.asar\dist\main\main\supervisor\index.js'
  $databaseModule = Join-Path $unpacked 'resources\app.asar\dist\main\main\database.js'

  Invoke-Gate 'workspace scaffold' 'packaged AgentSupervisor.ensureWorkspaceScripts + ensureWorkerScaffold' {
    $env:APPDATA = $appData
    $env:ELECTRON_RUN_AS_NODE = '1'
    try {
      $driverArgs = @($driver, $supervisorModule, $databaseModule, $workspace) |
        ForEach-Object { '"{0}"' -f $_ }
      $driverProcess = Start-Process -FilePath $exe -ArgumentList $driverArgs -Wait -PassThru -NoNewWindow
      $global:LASTEXITCODE = $driverProcess.ExitCode
    }
    finally { Remove-Item -LiteralPath 'Env:ELECTRON_RUN_AS_NODE' -ErrorAction SilentlyContinue }
  }

  if (-not $ScaffoldOnly) {
    Invoke-Gate 'bundled Node' 'powershell -File scripts/verify-bundled-node.ps1 -Strict -Workspace <temp>' {
      & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\verify-bundled-node.ps1') -Strict -Workspace $workspace
    }

    Invoke-Gate 'bundled Git' 'powershell -File scripts/verify-bundled-git.ps1 -PayloadDir release\win-unpacked\resources\mingit' {
      & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\verify-bundled-git.ps1') -PayloadDir $payloadDir
    }

    Invoke-Gate 'packaged analytics' 'node scripts/analytics-packaged-smoke.mjs <exe> --workspace <temp> --allow-cold --appdata <temp>' {
      & node (Join-Path $Root 'scripts\analytics-packaged-smoke.mjs') $exe --workspace $workspace --allow-cold --appdata $appData
    }

    Write-Host "`n== installer checksum =="
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or (Get-Item -LiteralPath $installer).Length -le 0) {
      Add-Result 'installer SHA-256' $false "installer missing or empty: $installer"
    } else {
      try {
        $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
        [System.IO.File]::WriteAllText($checksum, "$hash  $(Split-Path -Leaf $installer)`r`n", (New-Object System.Text.ASCIIEncoding))
        $checksumOk = (Test-Path -LiteralPath $checksum -PathType Leaf) -and (Get-Item -LiteralPath $checksum).Length -gt 0
        Add-Result 'installer SHA-256' $checksumOk "$checksum"
      } catch {
        Add-Result 'installer SHA-256' $false $_.Exception.Message
      }
    }
  }
} finally {
  if ($null -eq $priorAppData) { Remove-Item -LiteralPath 'Env:APPDATA' -ErrorAction SilentlyContinue }
  else { $env:APPDATA = $priorAppData }
  if (Test-Path -LiteralPath $workspace) {
    Remove-Item -LiteralPath $workspace -Recurse -Force
  }
}

if (-not $ScaffoldOnly -and -not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  Add-Result 'installer exists' $false $installer
}
if (-not $ScaffoldOnly -and -not (Test-Path -LiteralPath $checksum -PathType Leaf)) {
  Add-Result 'checksum exists' $false $checksum
}

Write-Host "`n== Windows release verification summary =="
$results | Format-Table -AutoSize
$failed = @($results | Where-Object { $_.Result -eq 'FAIL' })
if ($failed.Count -gt 0) {
  Write-Host "verify:windows-release - FAILED ($($failed.Count))" -ForegroundColor Red
  exit 1
}
Write-Host 'verify:windows-release - PASS' -ForegroundColor Green
exit 0
