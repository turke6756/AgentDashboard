# Notebook Agent Workflow Note

Date: 2026-04-29

## Problem

Notebook work needs specialized context and MCP tools, but most worker agents should stay lean. Giving every agent notebook tools and notebook-specific instructions bloats context and makes simple agents less focused.

At the same time, users should not have to know implementation details like which MCP server or skill is required before asking an agent to run or debug a notebook.

## Preferred Shape

Use the supervisor as a router/planner and workers as capability-scoped specialists.

Expected workflow:

1. User tells the supervisor: "Run/debug/work on this notebook."
2. Supervisor launches or routes to a Notebook Worker configured with:
   - notebook MCP tools
   - notebook-debug-loop skill
   - notebook path and task brief
   - minimal extra context
3. Supervisor tells the user: "I created a notebook agent for this. Work with them here."
4. User talks directly to the notebook agent.
5. Supervisor receives only lifecycle-level updates: done, blocked, failed, needs decision. It does not receive every interaction or every cell execution.

This keeps notebook capability available without forcing every agent to carry notebook-specific context.

## Product Model

The dashboard should support capability bundles or templates, for example:

- `lean-code`
- `notebook`
- `geo`
- `research`
- `supervisor`

Capabilities are attached to agents by role, not globally.

The supervisor can select the right bundle when delegating work. Power users can still launch a specialist directly.

## UI Direction

Consider representing supervisor-created agents as a task group or delegation tree:

- Supervisor card owns the mission.
- Child cards represent workers it created.
- Workers remain directly openable and fully interactable.
- Supervisor is not pinged for every child-agent message.
- Supervisor gets compressed status events only.

This gives users a clear "start with the supervisor" path without hiding the specialist agents.

## Notebook-Specific Behavior

Future expected notebook workflow:

1. User asks supervisor to run or fix a notebook.
2. Supervisor launches a Notebook Worker with notebook MCP enabled and notebook skill loaded.
3. Notebook Worker uses `execute_notebook` for full validation.
4. On failure, worker reads `failed_cell_id` and `outputs_summary`.
5. Worker edits the broken cell and reruns the relevant cell/range.
6. `nbconvert` is fallback only when dashboard notebook MCP tools are unavailable or the user explicitly requests a fresh-kernel headless run.

## Open Design Question

The dashboard could add a lightweight intervention layer later:

- Detect when a generic agent reads/edits/runs `.ipynb`.
- Send a one-time advisory message suggesting the notebook skill or notebook MCP workflow.

This should be conservative and non-blocking. Full pre-action interception is likely too brittle unless the dashboard mediates the relevant tool path directly.
