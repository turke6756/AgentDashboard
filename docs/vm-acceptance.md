# VM install acceptance runbook

This runbook exercises a packaged Lares install on an interactive Windows VM.
Run it in order. A working installer from the sibling `prop_a7c31e5d` plan is a
hard prerequisite.

## 1. Prepare the VM

1. Install Lares. Expect Windows SmartScreen on a fresh build and dismiss it
   only after confirming the installer is the expected artifact.
2. Copy the repository's entire `scripts\vm-acceptance\` folder to the VM. The
   installer does not contain this harness.
3. Install Claude Code and Codex as native Windows applications; do not use npm
   on the VM. Log in to both before starting. Claude is required for the worker
   and Codex for the GroupThink reviewer.
4. Start Lares once. Expect and dismiss the provider-missing dialog as providers
   become available. Also complete Claude's trust-this-folder prompt and any
   Codex login prompt. The monitor does not authenticate providers.

In PowerShell, locate the installed application and bundled MinGit exactly as
follows:

```powershell
$laresExe = Join-Path $env:LOCALAPPDATA 'Programs\Lares\Lares.exe'
$installDir = Split-Path -Parent $laresExe
$gitExe = Join-Path $installDir 'resources\mingit\cmd\git.exe'
Test-Path -LiteralPath $laresExe
Test-Path -LiteralPath $gitExe
```

Both `Test-Path` commands must print `True`.

## 2. Generate the acceptance workspace

Choose absolute VM paths and a new run ID. Keep the run ID short and safe for a
filename.

```powershell
$harnessDir = 'C:\vm-tools\vm-acceptance'
$target = 'C:\vm-runs\lares-acceptance-run-20260903-01'
$runId = 'run-20260903-01'
$generator = Join-Path $harnessDir 'make-test-repo.mjs'
$env:ELECTRON_RUN_AS_NODE='1'
& $laresExe $generator $target --run-id $runId --git $gitExe
if ($LASTEXITCODE -ne 0) { throw "generator failed with exit $LASTEXITCODE" }
Remove-Item Env:\ELECTRON_RUN_AS_NODE
```

This is the required outside-app execution form: the PowerShell call operator
passes the script and arguments directly, with no nested quote strings.

## 3. Open Lares and launch the supervisor

Open the generated repository as a workspace:

```powershell
& $laresExe $target
```

Wait for the workspace to finish opening. Launch one supervisor in that
workspace. Open
`scripts\vm-acceptance\prompts\00-supervisor-kickoff.md` from the copied
harness, replace `{{HARNESS_DIR_ABS}}` with the value of `$harnessDir`, and paste
the whole prompt into the supervisor.

The supervisor starts the monitor as its child, so the per-agent API capability
token stays in inherited process memory and is never passed on the command line.
It waits for `READY` before changing the workspace.

## 4. Perform the one mid-run human action

Wait until the supervisor says it wrote `COMMENT_READY`. In the Lares planning
surface, open the promoted plan document named by the supervisor. Select text,
create a selection comment whose body contains the exact `$runId`, and send it
to the responsible supervisor. Do not comment on a source file. The supervisor
will read the comment and write `COMMENT_ACK` containing its comment ID.

No other human mutation is part of the automated drive.

## 5. Read the automatic result

After the supervisor writes `DONE`, it waits for `report.json`. Read the plain
report from PowerShell:

```powershell
$runDir = Join-Path (Join-Path $env:TEMP 'lares-vm-acceptance') $runId
Get-Content -LiteralPath (Join-Path $runDir 'report.txt')
```

### Checked automatically

The eight numbered lines cover proposal creation, plan promotion, completed
GroupThink with a deliberation artifact, tracked activity ingestion, a browser
fixture GET after `BROWSER_OPENED`, owned/supervised two-turn Claude work,
the run-stamped plan comment, and checkpoint path scope. Acceptance requires all
eight to say `PASS`; `FAIL` or `INCOMPLETE` is not a pass. `KNOWN GAP` and
`HUMAN` lines are observations, not automatic gates.

### You must look

The monitor proves records and files exist, but it cannot judge the UI. Inspect
and record each of these manually:

- Installer first-run behavior and desktop/start-menu shortcuts are correct.
- The loopback browser fixture visibly renders and displays the exact run ID.
- Activity-pane rows for the tracked and ignored-path edits are readable.
- The file tree expands with the ignored clutter; ignored folders are currently
  expected to remain visible.
- The missing `*.zip` gitignore suggestion appears in the UI.
- Worker terminal status transitions and the responsible-supervisor badge look
  correct.
- The selection comment's placement and attribution look correct; reply
  behavior remains human-judged even though this run only acknowledges by ID.
- The checkpoint diff is usable and shows the tracked edit without ignored
  clutter.
- The GroupThink output is coherent and useful.
- The app remains responsive, does not crash, and shows no unexpected
  permission dialogs or provider-login prompts.

## Caveats

- Reinstalling Lares does not clear `%APPDATA%\AgentDashboard\dashboard.db`.
  State survives reinstall; the monitor isolates this run with baseline deltas
  and the run ID.
- An interactive desktop session is required. This is not a headless test.
- First open may be slow while Lares encounters roughly 5,000 fixture files.
- Host-side monitoring is optional and is not the default. It requires a
  deliberate, ephemeral credential transfer; keep the normal monitor inside the
  supervisor process tree.
