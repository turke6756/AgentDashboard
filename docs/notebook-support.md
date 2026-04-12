# Jupyter Notebook Support

Notebook viewing and execution support for AgentDashboard.

## Features

### Notebook Viewer

The file viewer now renders `.ipynb` files natively. Open any notebook in the file tree and it displays:

- **Kernel badge** — Shows kernel name (e.g. "R (IRkernel)", "Python 3") and cell count
- **Markdown cells** — Full GitHub Flavored Markdown with syntax-highlighted code blocks
- **Code cells** — Syntax-highlighted source with execution count gutter (`[1]`, `[2]`, etc.)
- **Cell outputs** — All standard Jupyter output types:
  - `text/plain` — Preformatted text
  - `text/html` — Sanitized HTML (common for R/Python table outputs and widgets)
  - `image/png`, `image/jpeg` — Inline base64 images (plots, charts)
  - `image/svg+xml` — Sanitized SVG graphics
  - `application/json` — Formatted JSON
  - `stream` — stdout/stderr with distinct styling
  - `error` — Tracebacks with ANSI codes stripped
- **Theme-aware** — Adapts to light/dark dashboard theme
- **Large notebook support** — 5MB file size limit (vs 1MB for other files) to accommodate embedded images

### Notebook Execution

Agents can execute notebooks properly via `jupyter nbconvert --execute`, which runs all cells in a real Jupyter kernel with shared state between cells.

#### MCP Tool: `execute_notebook`

Available to the supervisor agent. Parameters:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `notebook_path` | Yes | Absolute path to the `.ipynb` file |
| `kernel_name` | No | Kernel name (e.g. `ir`, `python3`). Defaults to notebook metadata |
| `timeout` | No | Per-cell timeout in seconds (default 600) |

#### WSL Skill: `/execute-notebook`

Available to WSL agents via `/execute-notebook <path>`. The skill:

1. Validates the notebook exists
2. Detects the kernel from notebook metadata
3. Executes via `jupyter nbconvert --execute` with proper flags
4. Reports results (success + kernel used, or failure + traceback)

#### HTTP API

```
POST /api/notebooks/execute
Content-Type: application/json

{
  "notebookPath": "/home/user/analysis.ipynb",
  "kernelName": "ir",
  "timeout": 600
}
```

Response:
```json
{
  "ok": true,
  "notebookPath": "/home/user/analysis.ipynb",
  "kernel": "ir",
  "duration": 12345
}
```

## Prerequisites

The machine running notebooks needs:

- **Jupyter**: `pip install jupyter nbconvert`
- **R kernel**: `R -e "IRkernel::installspec()"` (after installing the `IRkernel` R package)
- **Python kernel**: `python3 -m ipykernel install --user` (usually pre-installed)

## Files Changed

| File | Change |
|------|--------|
| `src/renderer/components/fileviewer/NotebookRenderer.tsx` | New — notebook cell renderer |
| `src/renderer/components/fileviewer/fileTypeUtils.ts` | Added `notebook` file type and `.ipynb` detection |
| `src/renderer/components/fileviewer/FileContentRenderer.tsx` | Wired notebook dispatch |
| `src/main/file-reader.ts` | 5MB size limit for `.ipynb` files |
| `src/main/notebook-executor.ts` | New — spawns `jupyter nbconvert --execute` |
| `src/main/api-server.ts` | Added `POST /api/notebooks/execute` endpoint |
| `scripts/mcp-supervisor.js` | Added `execute_notebook` MCP tool |
| `scripts/install-wsl-skills.py` | Added `/execute-notebook` WSL skill |

## Why nbconvert instead of extracting code

Agents that scrape code from notebook cells and run it in a bare subprocess break because:

1. **No shared state** — Cell 3 depends on variables from cell 2
2. **No document update** — The `.ipynb` file never gets execution outputs written back
3. **Rich outputs lost** — Plots, HTML tables, and widgets don't survive the round-trip

`jupyter nbconvert --execute` runs the notebook as a unit in a real kernel, preserving all of this.
