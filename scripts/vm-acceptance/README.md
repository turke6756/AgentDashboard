# VM install acceptance harness

This zero-dependency harness creates a deterministic repository, watches one
installed-app run, and correlates the result by `runId`. `monitor.mjs` owns
`baseline.json`, `control.json`, `READY`, `report.json`, and `report.txt`. It
also consumes supervisor-owned `COMMENT_READY`, `COMMENT_ACK`,
`BROWSER_OPENED`, and `DONE`; child output goes to `monitor.stdout.log` and
`monitor.stderr.log`.

## Mandatory launch order

1. On the VM, run `scripts/vm-acceptance/make-test-repo.mjs` to create the test
   workspace and its `MANIFEST.json`.
2. Open the generated repository as a Lares workspace.
3. Launch one supervisor and paste
   `scripts/vm-acceptance/prompts/00-supervisor-kickoff.md` after replacing the
   harness-directory placeholder.
4. The supervisor starts `scripts/vm-acceptance/monitor.mjs`, waits for `READY`,
   creates and promotes the proposal, and writes `COMMENT_READY`.
5. The human makes the one run-stamped selection comment on the promoted plan.
6. The supervisor writes `COMMENT_ACK`, launches a Claude worker with
   `scripts/vm-acceptance/prompts/10-worker-fix-bug.md`, then sends
   `scripts/vm-acceptance/prompts/11-worker-turn2.md` to the same idle worker.
7. The supervisor writes `BROWSER_OPENED`, opens the fixture, completes
   GroupThink, writes `DONE`, and waits for `report.json`.
8. Read `report.txt`, then complete the human checks in
   `docs/vm-acceptance.md`.

Do not reorder the monitor baseline, proposal mutation, comment, worker turns,
browser marker, orchestration, or final `DONE` boundary.

## Automatic check-to-trace map

| Check | Prompt step | Durable evidence |
|---|---|---|
| Check 1 (`proposal-creation`, Proposal creation) | Kickoff step 2 | Reserved `proposalArtifactId` and `runId` exist in the proposal file and post-baseline `proposals` row. |
| Check 2 (`plan-promotion`, Plan promotion) | Kickoff step 2 | `planArtifactId` exists in the plan folder, post-baseline `plans` row, and `/api/plans`; title contains `runId`. |
| Check 3 (`groupthink`, GroupThink) | Kickoff step 6 | An `orchestrations` row joins `planArtifactId` plus `intentId`, reaches `complete`, and a run-stamped file exists under `deliberations/`. |
| Check 4 (`activity-ingestion`, Activity ingestion) | Worker prompt 10 via kickoff step 4 | `/api/activity` contains the Claude worker's tracked `src/index.js` edit. |
| Check 5 (`built-in-browser`, Built-in browser) | Kickoff step 5 | A Chrome/Electron GET for `control.json.browserFixtureUrl` arrives after `BROWSER_OPENED`. |
| Check 6 (`worker-supervision`, Worker supervision) | Kickoff step 4, prompts 10 then 11 | Named Claude worker has `owner_agent_id` equal to the supervisor, `is_supervised = 1`, two terminal turns/sessions, and two idle transitions. |
| Check 7 (`comment-authorization`, Comment authorization) | Kickoff step 3 | A post-baseline run-stamped `selection_comments` row targets the promoted plan; `COMMENT_ACK` contains its ID for the non-gating parity line. |
| Check 8 (`checkpoint-scope`, Checkpoint scope) | Worker prompt 10 via kickoff step 4 | Healthy turn-1 capture and Git OID diff include `src/index.js` but exclude `generated/<runId>.txt`, `assets/big.bin`, and ignored prefixes/patterns. |

The monitor additionally reports non-gating known-gap and human lines. They do
not change the eight required check results.

## Files referenced by this guide

- `scripts/vm-acceptance/make-test-repo.mjs`
- `scripts/vm-acceptance/monitor.mjs`
- `scripts/vm-acceptance/prompts/00-supervisor-kickoff.md`
- `scripts/vm-acceptance/prompts/10-worker-fix-bug.md`
- `scripts/vm-acceptance/prompts/11-worker-turn2.md`
- `docs/vm-acceptance.md`
