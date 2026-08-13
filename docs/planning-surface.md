# The planning surface

Where work goes from an idea to landed code, and how Lares keeps a trustworthy
record of that journey. This document states the **vision**, then maps **where the
current implementation lives** so a newcomer — human or agent — can find the real
code instead of guessing.

Companion reading: [architecture.md](architecture.md) for the whole app,
[vision.md](vision.md) for why Lares exists,
[ownership-and-subscription.md](ownership-and-subscription.md) for who owns a plan.

---

## 1. The vision

### The problem it solves

An agent can write a convincing account of what it did. That account is not
evidence. When several agents work a shared tree across days, the honest questions
get hard fast: *what was actually decided, what actually shipped, who actually
touched this file, and is the plan I'm reading still true?*

The planning surface exists so those questions have answers that **do not depend on
anyone's narration** — including the supervisor's.

### Three commitments

**1. Artifacts on disk are the source of truth.** A plan is a folder you can read,
diff, and commit. Not a database row, not a chat log. If the app vanished, the
planning record would survive in the repo. The database projects and indexes that
folder; it never becomes the original.

**2. Provenance is witnessed, never narrated.** The server records which files and
sections an agent actually read and edited, derived from its tool calls. That trail
is what gating decisions rest on. An agent's summary is a *claim*; the trail is
*evidence*. Where capture is incomplete, the surface must say so out loud rather
than let an empty record read as "nothing happened."

**3. One owner, explicit handoffs.** Every plan has exactly one responsible
supervisor at a time, recorded as an `assigned` event. Ownership transfers by
appending a new event, not by whoever shows up. Read-only orientation is always
allowed; mutation is not.

### The intended arc of a piece of work

```
idea → proposal → plan folder → work packages → dispatch → gate → commit → ARC
```

- **Proposal** — a self-contained idea awaiting human review. A flat markdown file
  with a portable `artifact_id`. A bare proposal is a legitimate terminal artifact;
  not every idea needs a folder.
- **Promotion** — a human decision, not an automatic one. Promotion turns a
  proposal into a plan folder with a stable identity.
- **Work packages** — the dispatchable unit. A package names its change, its
  acceptance criteria, and its files. Acceptance criteria are the load-bearing
  part: they are what a gate checks, and a weak criterion is how defects ship green.
- **Gating** — the supervisor verifies returned work against the criteria and the
  witnessed trail, then commits. Workers do not commit in a shared tree.
- **ARC.md** — the plan's living summary, maintained by the responsible supervisor.
  It **cites** durable records (commits, turn stamps, intent links); it never
  substitutes prose for a stamp.

### What the surface is deliberately *not*

- It is not a task tracker. Status lives in the artifacts and the ledger.
- It is not a place agents invent structure. Plans are minted from a template;
  agents fill sections in.
- It does not trust web-derived or agent-authored content as instructions.
  Research lands in an untrusted inbox and is framed before use.

---

## 2. Where the artifacts live

| Artifact | Location | Notes |
|---|---|---|
| Proposals | `.lares/proposals/*.md` | Flat files. Supporting docs in `supporting/`. |
| Plan folders | `.lares/plans/<date>-<slug>-<hex>/` | One folder per plan. |
| Plan contents | `plan.json`, `plan.md`, `ARC.md` | Plus `deliberations/`, `research/`, `supplements/`. |
| Work packages | `supplements/<date>-work-packages.md` | Frontmatter `kind: work-packages`. |
| Research | `.lares/research/inbox/` | **Untrusted tier.** `cleared/` is reviewed. |
| Legacy plans | `plans/*.html` at workspace root | Distinct, older, HTML-based. |

**Two identities, and they are not interchangeable.** A plan has a portable
artifact id (`plan_<hex>`, in `plan.json` and `ARC.md`) *and* a database uuid. The
MCP plan tools take the **database uuid**; passing the artifact id yields "Plan not
found" or the misleading "Planning intent is not active in the requested plan."
This trips nearly everyone once. `get_my_context` returns the uuid under `plans`.

---

## 3. Where the implementation lives

### Main process — `src/main/plans/` (36 modules, 83 files with tests)

Grouped by what they do:

**Identity and lifecycle**
- `plan-identity.ts` (+ `src/shared/plan-identity.ts`) — the *only* source of plan
  identity. A previous dual-identity bug was closed by deleting the alternatives;
  prohibition text in `src/shared/constants.ts` is the guardrail, not dead code.
- `plan-lifecycle.ts`, `promoted-lifecycle.ts`, `plan-archive.ts`

**Promotion path**
- `promotion-preflight.ts`, `promotion-dispatch.ts`, `promotion-claim-scan.ts`,
  `promotion-reconciler.ts`, `legacy-promotion-drain.ts`,
  `plan-source-proposal-reconciler.ts`

**Folder ↔ database reconciliation**
- `plan-folder-watcher.ts`, `plan-folder-reconciler.ts`, `plan-manifest.ts`,
  `plans-watcher.ts` (one level up)

**Packages and evidence**
- `plan-work-package-ingest.ts` — parses the work-packages supplement
- `package-ledger.ts`, `package-gates.ts`, `package-deployments.ts`
- `plan-intent-ledger.ts`, `stamped-evidence-projection.ts`, `blame-to-intent.ts`
- `reachability-prover.ts`, `reachability-targets.ts`

**Projections (what the UI reads)**
- `plan-progress-projection.ts`, `plan-ledger-projection.ts`,
  `plan-review-projection.ts`, `plan-human-overview.ts`, `plan-gallery.ts`,
  `mission-board.ts`, `mission-board-evidence.ts`

**Documents, comments, IPC**
- `plan-documents.ts`, `plan-comments.ts`, `plan-ipc.ts`, `planning-reader.ts`
- `arc-bounds-validate.ts` — validates ARC.md size/shape

**Adjacent**
- `src/main/git-checkpoints/planning-worktree-service.ts`,
  `planning-worktree-reconciler.ts`, `plan-baseline-refs.ts`
- `src/main/orchestration/groupthink-plan-rail.ts`

### Renderer — `src/renderer/components/plan/`

- **Panes:** `PlansPane.tsx`, `PlansMenu.tsx`, `PlanSurfaceContainer.tsx`,
  `PlanSurfaceView.tsx`, `PlanReviewView.tsx`
- **Cards and lists:** `PlanCard.tsx`, `PromotedPlansList.tsx`,
  `ProposalCardGallery.tsx`, `WorkPackageCard.tsx`
- **Promotion:** `PromoteToPlanPanel.tsx`
- **Reading:** `ProposalReader.tsx`, `ProposalReaderPane.tsx`,
  `EmbeddedMarkdownDocument.tsx`, `PlanDocumentTabs.tsx`
- **Progress:** `MissionBoard.tsx`, `PlanPackageChecklist.tsx`,
  `IntentLifecycleStrip.tsx`, `PlanOverviewBar.tsx`

### Shared
`src/shared/plan-identity.ts`, `src/shared/planning-artifact-ids.ts`

### The agent-facing rail

**MCP tools that exist:** `create_plan`, `read_plan_progress`,
`record_planning_event`, `focus_plan`, `unfocus_plan`, plus `plan_id` /
`section_anchor` parameters on `launch_agent` and `run_orchestration`.

> ⚠ **`read_plan_projection`, `read_plan_section`, and `list_plan_sections` do not
> exist.** They were removed. The supervisor `CLAUDE.md` still instructs agents to
> use all three, and several internal docs cite them. Verified absent against
> `scripts/mcp-*.js` on 2026-08-13. Treat any instruction to call them as stale.

**Skills** are the agent's entry point, not raw paths: `proposal-to-plan`
(capture / scope / promote / deliberate / integrate / package / complete / orient),
`write-proposal`, `read-planning-surface`, `run-orchestration`.

---

## 4. Hard-won truths

Things that cost someone real time to learn.

- **`sec_exectr` (Execution Trail) is system-owned.** Never dispatch a writer to it
  and never hand-edit it. An agent pointed there is excluded from write
  attribution, so its turn silently degrades to intent-only.
- **Of four plan-ownership DB fields, one works.** `supervisor_focus` is real
  subscription. `proposals` is empty. `supervisor_active_plan` has never held a
  row. `responsible_supervisor_id` is a **comment-reply authorization gate**, not
  ownership — do not repurpose or retire it. Details in
  [ownership-and-subscription.md](ownership-and-subscription.md).
- **Never group or key work on `supervisor_focus`.** It is `ON DELETE CASCADE` on
  both sides and records *attention*, not responsibility.
- **The ARC bounds validator uses a live plan's `ARC.md` as its passing fixture.**
  Editing that file can fail the validator.
- **Retiring a work-packages supplement is a specific procedure.** Two live
  supplements with `kind: work-packages` make ingestion report `source-ambiguous`
  and progress tools report stale counts.
- **A green test suite is not a working feature.** This surface and the Save Card
  have together shipped four "dead bridges" — code that passed its own tests while
  being unreachable from production. Acceptance criteria must assert on the
  *production entry point* or on *rendered output*, never on a helper's return
  value or on source text.

---

## 5. Reading path

To understand the current implementation, in order:

1. [architecture.md § Planning surface](architecture.md) — one paragraph of context
2. This document, §2 — the artifacts on disk
3. An actual plan folder under `.lares/plans/` — read its `plan.json`, `ARC.md`,
   and a work-packages supplement; the shape teaches faster than prose
4. `src/main/plans/plan-work-package-ingest.ts` — how a supplement becomes rows
5. `src/main/plans/plan-folder-watcher.ts` — how disk reaches the database
6. `src/renderer/components/plan/PlansPane.tsx` — how it reaches the human
7. [ownership-and-subscription.md](ownership-and-subscription.md) — before touching
   ownership, subscription, or comment authorization

---

## 6. Known gaps

Honest open items as of 2026-08-13:

- **Stale agent instructions.** The supervisor `CLAUDE.md` documents three MCP
  tools that no longer exist (§3).
- **`docs/internal/`** holds substantial design history
  (`PLAN_SURFACE_PROVENANCE_REVISION.md`, `PLAN_SUBSCRIPTION_MIGRATION.md`,
  `V2_MASTER_PLAN.md`, `EMBEDDED_BROWSER_AND_PLANNING_SURFACE_PLAN.md`) that is
  **untracked** — it is not in git, so it is not shared and not versioned.
- **An independent audit scored the planning surface 42/68 (61.8%)**, but scored it
  *without reading the specimen plan folder*. That caveat must travel with the
  number.
- **The `ran` rung of intent lifecycle is unavailable** until the ledger ships; the
  `orient` flow reports it as unavailable rather than faking it.
