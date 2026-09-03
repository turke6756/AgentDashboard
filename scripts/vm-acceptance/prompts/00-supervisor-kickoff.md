# VM install acceptance supervisor kickoff

You are the supervisor for one VM acceptance run. Use only your supervisor MCP
tools (`get_my_context`, `launch_agent`, `send_message_to_agent`,
`read_agent_chat`, `read_comments`, `browser_open_url`, `run_orchestration`,
`read_plan_progress`, and `list_plans`), your Bash tool, and the installed
`proposal-to-plan` skill. Do not assume worker tools are available to you.

Before starting, the human replaces `{{HARNESS_DIR_ABS}}` with the absolute path
of the copied `scripts/vm-acceptance` directory. Never print, serialize, or pass
`AGENT_DASHBOARD_API_TOKEN` as an argument; the monitor inherits it from your
environment.

Perform these steps in order. Do not continue past a wait condition early.

## 1. Establish identity, start the watcher, and wait

1. Call `get_my_context`. Treat its workspace path as authoritative.
2. Read `<workspace path>/MANIFEST.json` with Bash. Use the real fields
   `runId`, `repoRoot`, `proposalArtifactId`, `intentId`, `planArtifactId`,
   `seededBug`, `expectedRedExit`, and `expectedGreenExit`. Require
   `repoRoot` to equal the absolute workspace path.
3. Set absolute `repoRoot`, `harness`, and
   `runDir=${TEMP:-${TMP:-/tmp}}/lares-vm-acceptance/<runId>` values. Create
   `runDir`, then copy `<repoRoot>/MANIFEST.json` to
   `<runDir>/MANIFEST.json`; the monitor's exact CLI defaults to that copy.
4. From Bash, spawn exactly this background command (substitute absolute paths):

   ```bash
   node "<harness>/monitor.mjs" --watch --run-dir "<runDir>" > "<runDir>/monitor.stdout.log" 2> "<runDir>/monitor.stderr.log" &
   ```

5. Poll for up to 120 seconds until `<runDir>/READY` exists. Then read
   `<runDir>/control.json` and verify its `runId`, `workspaceId`,
   `manifestPath`, and `pid`; retain `browserFixtureUrl` for step 6.

Durable trace: the monitor writes `baseline.json` and atomically publishes
`control.json`, while its output remains in `monitor.stdout.log` and
`monitor.stderr.log`. Run-dir sentinel: the monitor writes `READY`; you only
wait for it and never write it yourself.

## 2. Author, promote, wait for ingestion, then ask for the comment

1. Instantiate the absolute
   `<repoRoot>/acceptance/fixtures/seed-proposal.md.tmpl`. Replace
   `{{RUN_ID}}`, `{{ARTIFACT_ID}}`, and `{{INTENT_ID}}` with the manifest's
   `runId`, `proposalArtifactId`, and `intentId`. Preserve the `PLAN-INTENT`
   block and both target `provider` and `model` fields. Add a
   `## Hardening scope` section whose verdict says this is a bounded acceptance
   run. Write it to the absolute path
   `<repoRoot>/.lares/proposals/<YYYY-MM-DD>-<runId>-seed.md`.
2. Wait until the proposal is present on disk and has been ingested. Do not
   promote a different artifact: its ID must be `proposalArtifactId` and its
   title must contain `runId`.
3. Load and follow the installed `proposal-to-plan` skill. Promote with its
   `scripts/plan-manifest.mjs scaffold` command, run with `node`, passing the
   absolute proposal path, absolute `<repoRoot>/.lares/plans` home, this
   supervisor's ID, and a request ID containing `runId`. The resulting plan ID
   must equal `planArtifactId`, and its title must contain `runId`. Never call
   `implement_plan` and never hand-write `plan.json`.
4. For at most 120 seconds, poll `list_plans` and `read_plan_progress`. Continue
   only after the plan folder exists, the plans row for `planArtifactId` is
   visible, and planning intent `intentId` from the plan's `PLAN-INTENT` block is
   ingested.
5. Write an empty `<runDir>/COMMENT_READY`, tell the human the promoted plan
   document and `runId`, and pause for the one required human action.

Durable trace: the run-stamped proposal exists both on disk and in `proposals`;
the promoted plan folder, its `plan.json`, and the `plans` row retain
`proposalArtifactId`, `planArtifactId`, `intentId`, and `runId`. Run-dir
sentinel: you write `COMMENT_READY` only after both plan and intent ingestion.

## 3. Read and acknowledge the human comment

Poll `read_comments` for a new selection comment whose body contains `runId`
and whose target is the promoted plan document. Record its exact comment ID.
Do not look for or call a reply tool: none exists. Write only that comment ID,
followed by a newline, to `<runDir>/COMMENT_ACK`.

Durable trace: the app owns the run-stamped `selection_comments` row targeting
the plan; `COMMENT_ACK` records the same ID for the monitor's non-gating parity
line. Run-dir sentinel: you write `COMMENT_ACK` containing the comment ID.

## 4. Run two distinct turns on one Claude worker

1. Read the absolute `<harness>/prompts/10-worker-fix-bug.md`, substitute every
   placeholder with absolute values from `MANIFEST.json.repoRoot`, `runId`, and
   `runDir`, and launch one named **Claude** worker with a title containing
   `runId`. Ensure this supervisor is its owner; the resulting agent must have
   `owner_agent_id` equal to your supervisor ID and `is_supervised = 1`.
2. Wait until the worker finishes and becomes idle. Use `read_agent_chat` to
   verify turn 1 completed, including the expected red and green exit codes.
3. Read the absolute `<harness>/prompts/11-worker-turn2.md`, substitute the same
   absolute values, and send it to that same worker with
   `send_message_to_agent`. Do not launch another worker.
4. Wait for the second distinct turn to finish and for the worker to become
   idle again. Verify it in `read_agent_chat`.

Durable trace: the named Claude agent is owned and supervised; two terminal turn
records/sessions and two idle events exist; turn 1 writes `turn1-red.txt` and
`turn1-green.txt`, edits `src/index.js`, and touches
`generated/<runId>.txt`; turn 2 updates `CHANGELOG.md`. Run-dir sentinel: this
step writes no exported sentinel; its run-dir evidence is the two exit-code
files.

## 5. Mark and open the browser fixture

Write an empty `<runDir>/BROWSER_OPENED`, then immediately call
`browser_open_url` with the exact `browserFixtureUrl` read from
`control.json`. Do not substitute another URL.

Durable trace: the loopback fixture server records the run-ID path, timestamp,
and Chrome/Electron User-Agent after the marker. Run-dir sentinel: you write
`BROWSER_OPENED` immediately before calling `browser_open_url`.

## 6. Complete GroupThink, finish the watcher, and report

1. Call `run_orchestration` with `plan_id = planArtifactId`,
   `planning_intent_id = intentId`, and
   `section_anchor = "vm-acceptance-smoke"`. Include `runId` in the driving
   prompt. Follow returned instructions and continue driving the orchestration
   until its status is `complete`; use `read_plan_progress` as needed.
2. Confirm a run-stamped output exists under the promoted plan folder's
   `deliberations/` directory.
3. Write an empty `<runDir>/DONE`. This ends polling; it does not assert success.
4. Wait for `<runDir>/report.json`, then read both `report.json` and
   `report.txt`. Report every failed or incomplete check to the human.

Durable trace: an `orchestrations` row joins `planArtifactId` and `intentId`,
reaches `complete`, and has a run-stamped deliberation output. The monitor then
writes `report.json` and `report.txt`. Run-dir sentinel: you write `DONE`, then
wait for monitor-owned `report.json`.
