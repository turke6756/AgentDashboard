# Persistent Agent Personas

Any subdirectory under `.claude/agents/` that contains a `CLAUDE.md` is a **persistent agent persona**. When an agent launches with a persona, its working directory is set to that subdirectory so Claude Code discovers the `CLAUDE.md` natively as system instructions. The persona's memory, skills, and identity persist across sessions.

## Directory Structure

```
<workspace>/
  .claude/
    agents/
      supervisor/          # built-in, auto-created on supervisor launch
        CLAUDE.md
        memory/MEMORY.md
        skills/
        scripts/
      researcher/          # user-created persona
        CLAUDE.md
        memory/MEMORY.md
      code-reviewer/       # another persona
        CLAUDE.md
        memory/MEMORY.md
```

Each persona directory must contain at minimum a `CLAUDE.md` file. The scanner ignores directories without one.

## How It Works

1. **Scanning**: `persona-scanner.ts` scans `.claude/agents/*/CLAUDE.md` on both Windows (via `fs`) and WSL (via `wsl.exe bash`). The supervisor directory is detected and filtered from the launch dialog since it auto-launches separately.

2. **Launching**: When an agent is launched with a persona, the supervisor sets `agentCwd` to `.claude/agents/{persona-name}/` instead of the workspace root. Claude Code then picks up `CLAUDE.md` as its system instructions automatically.

3. **MCP Config**: `.mcp.json` is written to both the workspace root and the persona subdirectory so the agent has access to dashboard MCP tools regardless of its cwd.

4. **Workspace Recovery**: `getEffectiveWorkspaceRoot()` uses a regex to strip any `.claude/agents/{name}` suffix from an agent's working directory, so operations that need the workspace root (event bridge, context stats, etc.) work correctly for any persona agent, not just the supervisor.

## Creating Personas

### From the UI

1. Open the **Launch Agent** dialog
2. In the **Persona / Template** dropdown, click **+ Create new persona...**
3. Enter a name (lowercase letters, numbers, hyphens, underscores only)
4. The directory is scaffolded with a minimal `CLAUDE.md` and `memory/MEMORY.md`
5. The new persona is auto-selected in the dropdown

### From the Supervisor (MCP)

```
list_templates  -- returns both personas (type: "persona") and DB templates (type: "template")
launch_agent    -- pass persona: "researcher" to launch with that persona's identity
```

### Manually

Create the directory and `CLAUDE.md` yourself:

```bash
mkdir -p .claude/agents/my-agent/memory
echo "# My Agent\n\nYou are a specialist in ..." > .claude/agents/my-agent/CLAUDE.md
echo "# Memory Index" > .claude/agents/my-agent/memory/MEMORY.md
```

## API

### IPC (renderer)

```ts
window.api.personas.list(workspacePath, pathType)   // => AgentPersona[]
window.api.personas.create(workspacePath, pathType, name) // => AgentPersona
```

### HTTP API (MCP / external)

```
GET  /api/personas?workspaceId=...       -- list personas for a workspace
POST /api/personas  { workspaceId, name } -- scaffold a new persona
POST /api/agents    { ..., persona: "researcher" } -- launch with persona
```

## AgentPersona Type

```ts
interface AgentPersona {
  name: string;          // subdirectory name, e.g. "researcher"
  directory: string;     // full path to the persona directory
  hasMemory: boolean;    // whether memory/MEMORY.md exists
  isSupervisor: boolean; // true if name === "supervisor"
}
```

## Key Files

| File | Role |
|------|------|
| `src/main/persona-scanner.ts` | `scanPersonas()` and `scaffoldPersona()` |
| `src/shared/types.ts` | `AgentPersona` type, `persona` field on `LaunchAgentInput` |
| `src/main/supervisor/index.ts` | `getEffectiveWorkspaceRoot()` regex, `agentCwd` logic |
| `src/main/ipc-handlers.ts` | `persona:list`, `persona:create` IPC handlers |
| `src/preload/index.ts` | Preload bridge for personas |
| `src/main/api-server.ts` | HTTP routes for personas |
| `src/renderer/components/agent/AgentLaunchDialog.tsx` | Combined persona+template dropdown UI |
| `scripts/mcp-supervisor.js` | `launch_agent` persona param, `list_templates` merging |

## Relationship to Supervisor

The supervisor is the original persona (`supervisor/`). It is scaffolded automatically on first supervisor launch with a full set of files (CLAUDE.md, memory, skills, scripts). User-created personas are lighter-weight -- just CLAUDE.md and memory. The supervisor is always filtered out of the launch dialog dropdown since it has its own dedicated launch flow.
