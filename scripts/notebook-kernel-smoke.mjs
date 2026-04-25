// notebook-kernel-smoke.mjs
//
// Throwaway Phase-1 de-risk script. Proves the four load-bearing claims
// before we commit to writing MCP tools:
//
//   1. We can attach to the kernel the iframe already owns (not spawn a parallel one).
//   2. kernel.requestExecute() → iopub collection → future.done works from Node.
//   3. iopub messages map cleanly into nbformat output entries.
//   4. contents.save() persists outputs to disk (and with jupyter-collaboration on,
//      the iframe auto-refreshes — no conflict dialog).
//
// Prerequisites:
//   - Dashboard is running; user has opened a .ipynb (spawns the server on :18888).
//   - pip install 'jupyter-collaboration==4.0.2' inside the WSL venv (Phase 0).
//
// Usage:
//   node scripts/notebook-kernel-smoke.mjs <notebook-path-relative-to-server-root> [cellIndex]
//
// Example (with jupyter-server root_dir=/):
//   node scripts/notebook-kernel-smoke.mjs home/turke/GIS_Analysis/NEON_GIS_CrestedButte_Analysis/test.ipynb 0
//
// The path must match what the iframe uses — see toServerPath() in
// src/renderer/components/fileviewer/InteractiveNotebookRenderer.tsx. Strip
// the leading slash; Windows paths become mnt/c/...

import { ServerConnection, ServiceManager } from '@jupyterlab/services';
import WebSocket from 'ws';

const BASE_URL = process.env.JUPYTER_BASE_URL ?? 'http://127.0.0.1:18888';
const TOKEN = process.env.JUPYTER_TOKEN ?? '';
const notebookPath = process.argv[2];
const cellIndex = Number(process.argv[3] ?? 0);

if (!notebookPath) {
  console.error('usage: node scripts/notebook-kernel-smoke.mjs <path> [cellIndex]');
  process.exit(2);
}

function log(phase, ...rest) {
  console.log(`[${phase}]`, ...rest);
}

function mergeStreamOutputs(outputs) {
  const merged = [];
  for (const out of outputs) {
    const last = merged[merged.length - 1];
    if (last && last.output_type === 'stream' && out.output_type === 'stream' && last.name === out.name) {
      last.text += out.text;
    } else {
      merged.push(out);
    }
  }
  return merged;
}

async function main() {
  // 1. ServerConnection — explicit `WebSocket` polyfill. @jupyterlab/services
  //    claims to auto-detect but doesn't reliably pick up `ws` in Node.
  const serverSettings = ServerConnection.makeSettings({
    baseUrl: BASE_URL,
    wsUrl: BASE_URL.replace(/^http/, 'ws'),
    token: TOKEN,
    appendToken: true,
    WebSocket,
    // If you see 403s on WS upgrade with empty token, drop the token field
    // entirely instead of passing '' — some jupyter-server 2.x versions
    // reject `Authorization: token ` with a trailing space.
  });

  const manager = new ServiceManager({ serverSettings });
  await manager.ready;
  log('server', 'ready at', BASE_URL);

  // 2. Validate path FIRST — prevents spawning zombie kernels on typos. Also
  //    caches the notebook content for later patching.
  let res;
  try {
    res = await manager.contents.get(notebookPath, { content: true });
  } catch (err) {
    throw new Error(
      `notebook not found at path '${notebookPath}'. Did you typo? Check the path the iframe is using in the dashboard logs.`
    );
  }
  const nb = res.content;
  if (!nb?.cells || nb.cells.length <= cellIndex) {
    throw new Error(`notebook has no cell at index ${cellIndex} (found ${nb?.cells?.length ?? 0} cells)`);
  }
  const cell = nb.cells[cellIndex];
  if (cell.cell_type !== 'code') {
    throw new Error(
      `cell ${cellIndex} is '${cell.cell_type}', not 'code'. Pick a code cell — markdown cells don't render outputs.`
    );
  }
  const code = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
  log('cell', `found code cell [${cellIndex}] (${code.length} chars)`);

  // 3. Session: refresh → findByPath → connectTo. REFUSE to spawn a new
  //    session if the path isn't already running — the whole point of this
  //    smoke test is to prove we can attach to the iframe's kernel. Silently
  //    creating a parallel kernel on failure would reinvent the forged-
  //    execution problem we're trying to eliminate.
  await manager.sessions.refreshRunning();
  const existing = await manager.sessions.findByPath(notebookPath);
  if (!existing) {
    throw new Error(
      `no running session found for '${notebookPath}'. Open the notebook in the dashboard first, then re-run. (Spawning a parallel session would defeat the purpose of this test.)`
    );
  }
  const session = manager.sessions.connectTo({ model: existing });
  const kernel = session.kernel;
  if (!kernel) throw new Error('session has no kernel');
  log('session', 'reused — kernel id:', kernel.id);

  // 4. Execute + collect iopub → nbformat outputs.
  //    allowStdin:false prevents input() from hanging the kernel.
  //    storeHistory:true keeps In[n] counters correct for real notebook cells.
  const outputs = [];
  let executionCount = null;

  const future = kernel.requestExecute({
    code,
    allowStdin: false,
    storeHistory: true,
  });

  future.onIOPub = (msg) => {
    const t = msg.header.msg_type;
    const c = msg.content;
    switch (t) {
      case 'stream':
        outputs.push({ output_type: 'stream', name: c.name, text: c.text });
        break;
      case 'display_data':
        outputs.push({
          output_type: 'display_data',
          data: c.data,
          metadata: c.metadata ?? {},
        });
        break;
      case 'execute_result':
        outputs.push({
          output_type: 'execute_result',
          execution_count: c.execution_count,
          data: c.data,
          metadata: c.metadata ?? {},
        });
        executionCount = c.execution_count;
        break;
      case 'error':
        outputs.push({
          output_type: 'error',
          ename: c.ename,
          evalue: c.evalue,
          traceback: c.traceback,
        });
        break;
      case 'clear_output':
        // wait=true defers clear until next output; for a smoke test we can
        // just drop everything and live with the small inaccuracy.
        outputs.length = 0;
        break;
      case 'execute_input':
        if (executionCount == null) executionCount = c.execution_count;
        break;
      case 'status':
      case 'update_display_data':
        // status transitions (busy/idle) are tracked by future.done;
        // update_display_data would require display_id tracking — out of scope here.
        break;
      default:
        log('iopub', 'unhandled msg_type:', t);
    }
  };

  // future.done resolves after BOTH the shell execute_reply AND iopub status:idle
  // with matching parent_header.msg_id. This is the one true "cell finished" signal.
  const reply = await future.done;
  const status = reply?.content?.status ?? 'unknown';
  log('exec', 'status:', status, '— execution_count:', executionCount, '— outputs:', outputs.length);

  // 5. Persist: patch nbformat in place, save via contents API.
  //    With jupyter-collaboration on, this routes through the Yjs doc, the
  //    server debounces to disk (~1s), and the iframe auto-refreshes from the
  //    ydoc. Without RTC, the iframe would pop a "file changed on disk" dialog
  //    on its next save — which is exactly why Phase 0 is installing RTC.
  nb.cells[cellIndex].outputs = mergeStreamOutputs(outputs);
  nb.cells[cellIndex].execution_count = executionCount;

  await manager.contents.save(notebookPath, {
    type: 'notebook',
    format: 'json',
    content: nb,
  });
  log('save', 'wrote', outputs.length, 'outputs to disk');

  // 6. Re-read to verify round-trip.
  const verify = await manager.contents.get(notebookPath, { content: true });
  const savedOutputs = verify.content.cells[cellIndex].outputs ?? [];
  log('verify', 'disk has', savedOutputs.length, 'outputs');

  // 7. Dispose client-side only — DO NOT call session.shutdown(), which would
  //    DELETE /api/sessions/<id> and kill the kernel the iframe is using.
  session.dispose();
  manager.dispose();
  log('done', 'bye');
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
