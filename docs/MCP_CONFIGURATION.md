# MCP Configuration Plan

## Problem

Every agent launched into a supervised workspace currently inherits the full `agent-dashboard` MCP server (~27 tools, ~2,900 tokens of schema overhead), regardless of whether it needs any of those tools. This happens because `ensureMcpConfig` writes `.mcp.json` to the workspace root once (during supervisor/persona launch), and Claude Code auto-discovers that file for every subsequent agent launched in the workspace.

Goals:

1. **Ephemeral agents get nothing by default.** No MCP unless explicitly requested.
2. **Opt-in per launch.** The launch dialog lets the user pick which tool groups a new agent needs.
3. **Persistent preferences.** Personas and templates remember their MCP selection; workspace-level defaults can pre-check the dialog for a heavy-notebook user.
4. **Clean path for future servers.** Adding Playwright (or any other MCP) should just be another checkbox, not a refactor.

## Current behavior (the leak)

`src/main/supervisor/index.ts:541`

```ts
if (resolvedInput.isSupervisor || resolvedInput.persona) {
  this.ensureMcpConfig(workDir, pathType);      // ← writes to workspace root
  if (agentCwd !== workDir) {
    this.ensureMcpConfig(agentCwd, pathType);   // ← also writes to persona subdir
  }
}
```

- The workspace-root `.mcp.json` persists on disk forever.
- Every future agent has `cwd = workDir` (line 499) unless it's a persona — so auto-discovery picks up the file every time.
- Plain ephemeral agents end up with full supervisor MCP despite no explicit request.

## Tool groups

The current 27 tools in `scripts/mcp-supervisor.js` split naturally into four logical groups:

| Group | Tools | Notes |
|---|---|---|
| **agent-control** | `list_agents`, `read_agent_log`, `send_message_to_agent`, `get_context_stats`, `stop_agent`, `launch_agent`, `create_persona`, `list_templates`, `fork_agent` (9) | Supervisor-flavored |
| **teams** | `create_team`, `disband_team`, `add_team_member`, `remove_team_member`, `add_channel`, `remove_channel`, `get_team`, `list_teams`, `resurrect_team` (9) | Team orchestration |
| **notebooks** | `execute_cell`, `execute_range`, `interrupt_kernel`, `restart_kernel`, `get_kernel_state` (5) | Live kernel control |
| **groupthink** | `start_groupthink`, `get_groupthink_status`, `advance_groupthink_round`, `complete_groupthink` (4) | **Deprecate** — Teams replaced it |

The `scripts/mcp-team.js` server (injected automatically for team members) currently duplicates the notebook tools. Remove the duplication — notebook tools live only in the `notebooks` group.

## Target architecture

### Gating mechanism

Use Claude Code's `--mcp-config <path>` CLI flag on agent launch. This bypasses `.mcp.json` auto-discovery entirely, giving per-agent control with zero chance of workspace-root leakage.

- Each agent launch writes a small temp config file with only the servers it needs.
- No more writes to `workDir/.mcp.json`. Any existing leaked file becomes a no-op.
- Team membership continues to inject the team MCP automatically; that's orthogonal.

### Three layers of selection (highest priority first)

1. **Launch dialog checkboxes** (per-agent) — user picks at launch time.
2. **Persona / Template defaults** — pre-check the dialog based on saved config.
3. **Workspace defaults** — pre-check the dialog for ephemeral agents when no persona/template is selected.

### Script split (Option B)

Replace `scripts/mcp-supervisor.js` with per-group scripts:

- `scripts/mcp-agent-control.js`
- `scripts/mcp-teams.js`
- `scripts/mcp-notebooks.js`

Each agent's generated `.mcp.json` (passed via `--mcp-config`) references only the groups they selected. Playwright later becomes `scripts/mcp-playwright.js` or an external package — just another checkbox.

### Resolved defaults

- **Supervisor** → all groups forced on, not user-selectable.
- **Team members** → team MCP auto-injected by membership (unchanged); other groups follow the checkbox system.
- **Ephemeral agents** → nothing by default, unless workspace prefs say otherwise.
- **GroupThink** → tools deleted; group does not exist.

## Data model changes

### `LaunchAgentInput` (`src/shared/types.ts:88`)

```ts
interface LaunchAgentInput {
  // ...existing fields
  mcpGroups?: string[];  // e.g. ['notebooks', 'agent-control']
}
```

### `AgentTemplate` (`src/shared/types.ts:110`)

```ts
interface AgentTemplate {
  // ...existing fields
  mcpGroups: string[];
}
```

### `AgentPersona` + new `persona.json`

Add a `persona.json` alongside `CLAUDE.md` in each `.claude/agents/{name}/` directory:

```json
{
  "mcpGroups": ["notebooks", "agent-control"]
}
```

`scanPersonas` reads it and returns `mcpGroups` on the `AgentPersona` type. Missing file → empty array.

### `Workspace`

```ts
interface Workspace {
  // ...existing
  defaultMcpGroups: string[];  // e.g. ['notebooks']
}
```

Edited in workspace settings UI (not the launch dialog — keeps the dialog focused).

## UI changes

`src/renderer/components/agent/AgentLaunchDialog.tsx`:

- Add an "MCP Access" section with checkboxes for each group.
- Initial state resolves in order: template groups → persona groups → workspace defaults → empty.
- Supervisor-flagged launches disable the checkboxes (all forced on, display-only).
- "Save as template" and "Create new persona" capture the current checkbox state.

A new workspace settings surface exposes `defaultMcpGroups` (location: wherever workspace config currently edits — sidebar popover or modal).

## Phases

### Phase 1 — Stop the leak (no UI)

1. Switch agent launch to use `--mcp-config <temp-file>` instead of relying on `.mcp.json` auto-discovery.
2. Remove the workspace-root write from `ensureMcpConfig`; keep the persona-subdir write only if useful for anything else (likely delete).
3. Supervisor and persona agents get all groups (maintains current behavior); ephemeral agents get nothing.
4. Verify with a fresh ephemeral agent launch — no MCP tools should appear.

### Phase 2 — Split the scripts

1. Create `scripts/mcp-agent-control.js`, `scripts/mcp-teams.js`, `scripts/mcp-notebooks.js`.
2. Delete `scripts/mcp-supervisor.js` once all callers are migrated.
3. Remove duplicated notebook tools from `scripts/mcp-team.js`.
4. Delete the GroupThink tools and any unused call sites.
5. Update the `.mcp.json` writer to compose server entries from the selected groups.

### Phase 3 — Persistence and UI

1. Add `mcpGroups` to `LaunchAgentInput`, `AgentTemplate`, `Workspace`.
2. Add `persona.json` support in `persona-scanner.ts` (`scanPersonas`, `scaffoldPersona`).
3. Wire `AgentLaunchDialog` checkboxes with layered defaults.
4. Add workspace settings UI for `defaultMcpGroups`.

### Phase 4 — Playwright

1. New `scripts/mcp-playwright.js` (or external package) wired to a `WebContentsView`-backed CDP endpoint.
2. Add a `playwright` checkbox to the launch dialog.
3. Optional: create a "browser" persona with `mcpGroups: ['playwright']` saved in its `persona.json`.

## Open questions

- **Existing workspace-root `.mcp.json` files** — one-time cleanup on next supervisor launch, or leave them as harmless (they'll be ignored once `--mcp-config` is the only path). Lean: leave.
- **Global (not just workspace) user preference** — defer. Workspace-level covers the stated use case.
- **Migration for existing templates/personas** — they have no `mcpGroups` field yet; treat missing as empty array. Supervisor and known-persona edge cases stay covered by the "supervisor forces all on" rule.
