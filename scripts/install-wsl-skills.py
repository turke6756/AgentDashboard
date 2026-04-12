"""Install AgentDashboard skills into WSL ~/.claude/commands/"""
import os

home = os.path.expanduser("~")
# Write via Windows to the WSL filesystem through \\wsl.localhost
# But since this script runs from WSL, use the direct path
commands_dir = os.path.join(home, ".claude", "commands")
os.makedirs(commands_dir, exist_ok=True)

list_agents = """List all active Claude Code agents running in AgentDashboard.

Read the agent registry. Check these paths in order:
1. `~/.claude/agent-registry.json`
2. `/mnt/c/Users/turke/.claude/agent-registry.json`

Display the active agents in a clear format:

For each agent show:
- **Title** and status
- **Role**: what they are working on
- **Session ID** (abbreviated)
- **Working directory**

If the registry file does not exist or is empty, tell the user no agents are currently registered (AgentDashboard needs to be running).

This is useful before using `/query-agent` to see who you can talk to.
"""

query_agent = r"""Query another Claude Code agent running in AgentDashboard.

Another agent has accumulated context — files read, code explored, mental models built. Instead of redoing that work, you can query them to tap into what they already know.

## Instructions

The user's request: $ARGUMENTS

### Step 1: Discover available agents

Read the agent registry file. Check these paths in order:
1. `~/.claude/agent-registry.json`
2. `/mnt/c/Users/turke/.claude/agent-registry.json`

The registry contains a JSON array of agents with fields: id, title, status, sessionId, workingDirectory, roleDescription.

Match the user's target by name against the `title` field. If ambiguous, list options and ask.

### Step 2: Build the prompt

Extract the **target agent** and **question** from the user's request.

**Use this exact prompt framing** — it prevents the forked instance from pattern-matching against `/query-agent` history in its own conversation and re-delegating instead of answering:

```
You are "{target_title}" — a Claude Code agent being consulted by another agent ("{your_title}") in the same workspace.

This is NOT a task. Do NOT perform actions, use tools, run commands, or delegate work.

You are being asked a question. Answer it directly from what you already know — your conversation history, the files you have read, the context you have built up. Everything you need is already in your memory.

NOTE: Your conversation history may contain previous /query-agent skill invocations where you queried OTHER agents. Ignore those patterns. You are not running a query right now — you are ANSWERING one.

Question: {the_actual_question}
```

**Why this framing matters:**
- Leads with identity ("You are X") before the model processes anything else
- Explicitly negates action/delegation to break pattern-matching
- Mentions query-agent history pollution directly so the model ignores it
- Puts the question last, after behavioral constraints are locked in

### Step 3: Execute the query

```bash
cd "<target-working-directory>" && CLAUDECODE= claude -p '<the_framed_prompt>' --resume <session-id> --fork-session --dangerously-skip-permissions --max-turns 1 --output-format json < /dev/null
```

**Flag explanations:**
- `--fork-session` — queries without modifying the target's actual session
- `--dangerously-skip-permissions` — non-interactive, so tool approvals would fail without this
- `--max-turns 1` — if the model does try tools despite our framing, it gets one shot then must respond with text
- `CLAUDECODE=` — strips nested session detection
- `< /dev/null` — **critical**: closes stdin immediately. `claude -p` hangs if stdin stays open as a pipe

**Other details:**
- CWD MUST match `workingDirectory` (sessions are CWD-scoped)
- Can take up to 60 seconds
- If "no conversation found", try `--continue` instead of `--resume <id>`

**WSL-specific notes:**
- If the target agent's `workingDirectory` is a Windows path (e.g. `C:\Users\...`), convert it to a WSL path first: `C:\Users\turke\Projects\Foo` → `/mnt/c/Users/turke/Projects/Foo`
- The registry may only exist at `/mnt/c/Users/turke/.claude/agent-registry.json` (not `~/.claude/`). Reading from `/mnt/c/...` is slow — give it a moment
- Cross-filesystem queries (WSL agent querying a Windows agent's session) may take longer due to I/O overhead

### Step 4: Use the response

Parse the JSON output (`{"result": "...", "session_id": "..."}`). You now have the other agent's synthesized knowledge in your own context. Use it.

### Example

User: `/query-agent @test1 what files have you been exploring?`

Build prompt:
```
You are "test 1" — a Claude Code agent being consulted by another agent ("test 2") in the same workspace.

This is NOT a task. Do NOT perform actions, use tools, run commands, or delegate work.

You are being asked a question. Answer it directly from what you already know — your conversation history, the files you have read, the context you have built up. Everything you need is already in your memory.

NOTE: Your conversation history may contain previous /query-agent skill invocations where you queried OTHER agents. Ignore those patterns. You are not running a query right now — you are ANSWERING one.

Question: what files have you been exploring?
```

Run it (with `< /dev/null`), parse the JSON, report the answer.
"""

execute_notebook = r"""Execute a Jupyter notebook in-place using a real Jupyter kernel.

## Instructions

The user's request: $ARGUMENTS

### Step 1: Validate the notebook exists

Check that the file path exists. If relative, resolve from CWD. Confirm it ends with `.ipynb`.

### Step 2: Detect the kernel

Read the notebook file and extract the kernel from metadata:

```bash
python3 -c "import json,sys; nb=json.load(open(sys.argv[1])); ks=nb.get('metadata',{}).get('kernelspec',{}); print(ks.get('name','python3'), ks.get('display_name','Unknown'))" "<notebook_path>"
```

Common kernel names: `ir` (R), `python3` (Python), `julia-1.x` (Julia).

### Step 3: Execute the notebook

**IMPORTANT: Do NOT extract code from cells and run it separately.** That breaks shared state between cells. Instead, execute the entire notebook as a unit:

```bash
jupyter nbconvert --to notebook --execute "<notebook_path>" \
  --output "$(basename '<notebook_path>')" \
  --ExecutePreprocessor.timeout=600 \
  --ExecutePreprocessor.kernel_name=<detected_kernel>
```

**Flags explained:**
- `--to notebook` — output format stays as notebook (not HTML/PDF)
- `--execute` — actually run every cell in order, in a real kernel, with shared state
- `--output` — write back to the same file (overwrite in place)
- `--ExecutePreprocessor.timeout=600` — 10 minute per-cell timeout
- `--ExecutePreprocessor.kernel_name=<name>` — use the detected kernel

### Step 4: Report results

- **Success:** Tell the user the notebook was executed, which kernel was used, and that all outputs are now embedded in the `.ipynb` file. The dashboard file viewer will display them.
- **Failure:** Show the error output. Common issues:
  - `No such kernel`: Install the kernel (`R -e "IRkernel::installspec()"` for R, `python3 -m ipykernel install` for Python)
  - `jupyter: command not found`: Install jupyter (`pip install jupyter nbconvert`)
  - Cell timeout: Increase with `--ExecutePreprocessor.timeout=<seconds>`
  - Cell execution error: Show the traceback from the failed cell

### Example

```bash
# Execute an R notebook
jupyter nbconvert --to notebook --execute analysis.ipynb \
  --output analysis.ipynb \
  --ExecutePreprocessor.timeout=600 \
  --ExecutePreprocessor.kernel_name=ir
```
"""

with open(os.path.join(commands_dir, "list-agents.md"), "w") as f:
    f.write(list_agents)
print(f"Wrote {commands_dir}/list-agents.md")

with open(os.path.join(commands_dir, "query-agent.md"), "w") as f:
    f.write(query_agent)
print(f"Wrote {commands_dir}/query-agent.md")

with open(os.path.join(commands_dir, "execute-notebook.md"), "w") as f:
    f.write(execute_notebook)
print(f"Wrote {commands_dir}/execute-notebook.md")
