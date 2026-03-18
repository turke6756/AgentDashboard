# Architectural Proposal: AgentDashboard VS Code Companion Extension

## Core Concept
The goal is to establish **AgentDashboard** as the omnipotent control plane for all Claude Code agents, while seamlessly injecting those agents into the user's natural coding environment (VS Code).

We will achieve this by building a **"Companion Extension"** for VS Code. 

Unlike a full rewrite of the dashboard into VS Code, this companion extension is incredibly "dumb." It has no UI, no database, and no supervisor logic. It exists purely to receive commands from the main AgentDashboard Electron app and manipulate the VS Code workspace (specifically, its terminal tabs).

## The Workflow

1. **The User Action:** The user is looking at the AgentDashboard (Electron app). They click a button on a workspace card: "Open in VS Code".
2. **The Launch:** The Electron app executes `code <workspace-path>`. VS Code launches and opens the directory.
3. **The Handshake:** When VS Code opens, the Companion Extension activates. It starts a local WebSocket client and connects to the AgentDashboard's background daemon (e.g., `ws://localhost:4545`).
4. **The Injection:** The AgentDashboard sees a VS Code instance connect for a specific workspace. It immediately sends a payload: 
   *"I am currently running 3 Claude agents in this directory. Here are their tmux session IDs. Open them."*
5. **The Result:** The Companion Extension receives the payload and programmatically opens 3 native VS Code Terminal tabs. Each tab is named after the agent (e.g., "🤖 Frontend Agent") and is attached directly to the live `tmux` session or `pty-host` running in the background.

## Why This Architecture is Brilliant

1. **Zero State Conflicts:** Because the agents are already running in persistent `tmux` sessions (WSL) or `pty-host` ring buffers (Windows), VS Code doesn't "own" them. It just *attaches* to them. If the user closes the VS Code terminal tab, the agent doesn't die. It keeps running perfectly in the Dashboard.
2. **Perfect Mirroring:** Because VS Code is attaching to a `tmux` session, whatever you type in the VS Code terminal instantly appears in the AgentDashboard's terminal view, and vice versa. It is a true live mirror.
3. **Minimal Effort:** We don't have to rebuild the Dashboard UI, the SQLite database, or the complex file-activity tracking inside VS Code. We just write ~200 lines of extension code to manage `vscode.window.createTerminal()`.

## Implementation Details

### 1. The AgentDashboard Payload
When the Electron app detects a VS Code companion connection, it sends an `inject_terminals` message:

```json
{
  "command": "inject_terminals",
  "workspaceId": "ws-1234",
  "agents": [
    {
      "id": "agent-a1b2",
      "name": "Frontend Builder",
      "platform": "wsl",
      "tmuxSession": "cad__front__a1b2"
    },
    {
      "id": "agent-c3d4",
      "name": "Backend Refactor",
      "platform": "windows",
      "pipePath": "\\\\.\\pipe\\cad-windows-pty-c3d4" 
    }
  ]
}
```

### 2. The Companion Extension Logic
The VS Code extension parses the payload and uses the native `createTerminal` API.

**For WSL Agents:**
```typescript
vscode.window.createTerminal({
  name: `🤖 ${agent.name}`,
  shellPath: "wsl.exe",
  shellArgs: ["bash", "-lc", `tmux attach -t '${agent.tmuxSession}'`]
});
```

**For Windows Agents:**
Windows `pty-host` instances don't have `tmux`. To achieve the same "attach" behavior, the AgentDashboard's WindowsRunner will need a minor upgrade to expose a Named Pipe (or local socket). The VS Code terminal can then use `netcat` or a simple Node script to pipe its stdin/stdout to that socket.

### 3. Graceful Disconnects
If the user closes the VS Code window, the WebSocket connection drops. The AgentDashboard notes that the IDE is closed, but the agents continue running uninterrupted in the background. When the user clicks "Open in VS Code" again, the cycle repeats, and the tabs instantly reappear with their full history intact.
