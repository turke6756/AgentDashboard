---
name: notebook-debug-loop
description: Repair, validate, or debug Jupyter notebooks in AgentDashboard using the dashboard MCP notebook tools. Use when working on .ipynb files, when a user asks an agent or supervisor to run/fix a notebook, or when notebook execution must stay synchronized with the dashboard UI, live kernel, and saved outputs.
---

# Notebook Debug Loop

Use the dashboard MCP notebook tools as the execution path of record. Do not default to `jupyter nbconvert`, direct shell execution, or a separate ad hoc kernel unless the dashboard MCP tools are unavailable or the user explicitly requests a headless fresh-kernel run.

## Role Check

Respect your active role constraints.

- If you are allowed to edit the notebook, run the loop directly.
- If you are a supervisor that must not edit files directly, brief a worker with this skill's workflow, then monitor its MCP execution results.
- If the user asked you specifically to fix the notebook yourself, use the normal file-editing tools for source changes and the dashboard MCP tools for execution.

## Path And Cell Rules

Use a server-relative `notebook_path`. The Jupyter server root is `/`, so strip the leading slash.

Examples:

```text
/home/user/project/analysis.ipynb -> home/user/project/analysis.ipynb
C:\Users\user\project\analysis.ipynb -> mnt/c/Users/user/project/analysis.ipynb
```

Address notebook cells by nbformat 4.5 `id`, never by index. Indexes change when cells are inserted, deleted, or moved.

To find a cell id, inspect the `.ipynb` JSON or use the notebook state already available in context. Preserve unrelated cells and metadata when editing.

## Main Loop

1. Check kernel state if the notebook may not already be attached:

   ```text
   get_kernel_state(notebook_path)
   ```

2. Run the notebook through the dashboard:

   ```text
   execute_notebook(notebook_path, timeout?)
   ```

3. If `status` is `ok`, stop. Summarize what passed and mention any meaningful outputs.

4. If `status` is `failed`, read:

   - `failed_cell_id`
   - `error`
   - `outputs_summary`
   - `last_executed_cell_id`

5. Inspect only the failing cell and the minimal upstream context needed to understand it. Prefer targeted notebook JSON reads over loading the whole notebook into context when the file is large.

6. Edit the smallest necessary part of the failing cell. Keep the notebook's intent intact. Do not rewrite unrelated cells while chasing one execution failure.

7. Rerun the smallest useful scope:

   ```text
   execute_cell(notebook_path, failed_cell_id, timeout?)
   ```

   Use this for isolated syntax, import, variable, plotting, or formatting fixes.

   ```text
   execute_range(notebook_path, from_cell_id, to_cell_id, timeout?)
   ```

   Use this when the failing cell depends on state from nearby cells or when a fix changes downstream state. Usually start from `failed_cell_id` and run to the end of the notebook.

8. Repeat until the notebook passes or a stopping condition is reached.

## Stopping Conditions

Stop and report clearly when:

- The same error appears twice after a reasonable fix attempt.
- The next fix requires changing the notebook's analytical intent, data source, credentials, environment, or user-facing result.
- The kernel is busy with user work and interrupting would be disruptive.
- Required data or packages are unavailable and cannot be installed safely.
- Execution exceeds the expected runtime twice. Increase `timeout` only when long runtime is expected.

Use `interrupt_kernel(notebook_path)` only when the user asked to stop execution or when a runaway cell is clearly blocking the requested work. Use `restart_kernel(notebook_path)` when stale state is likely, and state that restart clears in-memory variables.

## Output Interpretation

Treat `outputs_summary` as the first diagnostic surface. It is compact by design:

- Text is truncated, so inspect the notebook output or rerun a focused cell when the missing tail matters.
- Images are summarized by mime type and byte count, so validate visual correctness in the dashboard when the chart itself matters.
- A failed first cell usually points to environment/setup; a later failed cell often needs upstream state inspection.

## Preferred Fix Pattern

Use this pattern for most notebook repairs:

```text
execute_notebook(path)
if failed:
  inspect failed_cell_id and outputs_summary
  edit failed cell by nbformat id
  execute_cell(path, failed_cell_id)
  if isolated cell passes:
    execute_range(path, failed_cell_id, last cell id)
  finish with execute_notebook(path)
```

The final validation should be `execute_notebook` unless the user explicitly wants only a focused cell fix.

## Fallbacks

If dashboard MCP notebook tools are unavailable:

1. Say that the live dashboard execution path is unavailable.
2. Use `nbconvert` or shell execution only as a fallback.
3. Make clear that fallback execution may not update the live dashboard UI or persisted notebook outputs in the same way.

If cell editing by a notebook-aware tool is unavailable, edit the `.ipynb` JSON carefully by cell `id`. Preserve valid JSON, execution metadata, and unrelated outputs unless the user asked to clear or regenerate them.
