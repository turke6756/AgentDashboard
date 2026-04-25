// jupyter-kernel-client.ts
//
// Phase 1 of the notebook prototype: real cell execution against the live
// jupyter-server the iframe is already using. NEVER spawns a parallel server
// or parallel session — the whole point is that user and agent share one
// kernel per notebook.
//
// Architecture: a singleton ServiceManager bound to ensureJupyterServer().
// Every call goes refreshRunning → findByPath → connectTo (or startNew if
// the iframe hasn't opened that notebook yet). Cells are addressed by their
// nbformat 4.5 `id` (UUID), not by index, so agent inserts don't shift
// addresses across tool calls.
//
// The output shape returned to MCP is intentionally compact — text truncated
// to ~5KB per output, images replaced by `{ mime, byteLength }` stubs — so
// the LLM doesn't blow its context on a single matplotlib figure.

import type { ServiceManager as IServiceManager, Session, KernelMessage } from '@jupyterlab/services';
import WebSocket from 'ws';
import { ensureJupyterServer } from './jupyter-server';

const TEXT_TRUNCATE = 5_000;

// `@jupyterlab/services` is plain CJS in v7.x, so a normal import works under
// our `module: commonjs` tsconfig. ServerConnection.makeSettings is the only
// non-type symbol we need at runtime — bring it through a require so the
// imports above stay type-only and don't drag a default-export shape we'd
// otherwise have to fight.
const services = require('@jupyterlab/services');
const { ServerConnection, ServiceManager } = services;

let manager: IServiceManager.IManager | null = null;
let initPromise: Promise<IServiceManager.IManager> | null = null;

async function ensureManager(): Promise<IServiceManager.IManager> {
  if (manager) return manager;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const server = await ensureJupyterServer();
    const baseUrl = server.baseUrl.endsWith('/') ? server.baseUrl : `${server.baseUrl}/`;
    const settings = ServerConnection.makeSettings({
      baseUrl,
      wsUrl: baseUrl.replace(/^http/, 'ws'),
      token: server.token,
      appendToken: true,
      // @jupyterlab/services claims to auto-detect WebSocket but doesn't reliably
      // pick up `ws` in Node — pass it explicitly. (Same gotcha as the smoke test.)
      WebSocket,
    });
    const m = new ServiceManager({ serverSettings: settings }) as IServiceManager.IManager;
    await m.ready;
    manager = m;
    return m;
  })();
  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

export function disposeKernelClient(): void {
  if (manager) {
    try { manager.dispose(); } catch { /* ignore */ }
    manager = null;
  }
}

// Resolve the iframe's session for `path`, or start one if the iframe hasn't
// touched this notebook yet. Per de-risk research: never uniquify the path —
// jupyter-server dedupes POST /api/sessions by path so this is the *only* way
// to share a kernel with the iframe.
async function attachSession(notebookPath: string, kernelName?: string): Promise<Session.ISessionConnection> {
  const m = await ensureManager();
  await m.sessions.refreshRunning();
  const existing = await m.sessions.findByPath(notebookPath);
  if (existing) return m.sessions.connectTo({ model: existing });

  // Pick a kernel: caller override > nbformat metadata > python3 fallback.
  let kernel = kernelName;
  if (!kernel) {
    try {
      const file: any = await m.contents.get(notebookPath, { content: true });
      kernel = file?.content?.metadata?.kernelspec?.name;
    } catch { /* fall through to default */ }
  }
  return m.sessions.startNew({
    path: notebookPath,
    type: 'notebook',
    name: notebookPath,
    kernel: { name: kernel || 'python3' },
  });
}

interface ExecuteOptions {
  timeoutSec?: number;
}

interface CompactOutput {
  type: string;
  // For stream and error: text payload (truncated).
  text?: string;
  // For execute_result/display_data: which mime types were present + sizes.
  data?: Array<{ mime: string; bytes: number; preview?: string }>;
  // For error outputs.
  ename?: string;
  evalue?: string;
}

export interface ExecuteCellResult {
  status: 'ok' | 'error' | 'aborted' | 'timeout';
  cell_id: string;
  execution_count: number | null;
  outputs_summary: CompactOutput[];
  error?: { ename: string; evalue: string; traceback?: string[] };
}

function truncate(s: string, max = TEXT_TRUNCATE): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

function summarizeData(data: Record<string, unknown>): CompactOutput['data'] {
  const out: NonNullable<CompactOutput['data']> = [];
  for (const [mime, payload] of Object.entries(data ?? {})) {
    if (typeof payload === 'string') {
      // text/plain, text/html, image/png (base64), etc.
      const isText = mime.startsWith('text/') || mime === 'application/json';
      out.push({
        mime,
        bytes: payload.length,
        preview: isText ? truncate(payload, 500) : undefined,
      });
    } else {
      // application/json non-string payloads, etc.
      const json = JSON.stringify(payload);
      out.push({ mime, bytes: json.length, preview: truncate(json, 500) });
    }
  }
  return out;
}

function mergeStreamOutputs(outputs: any[]): any[] {
  const merged: any[] = [];
  for (const out of outputs) {
    const last = merged[merged.length - 1];
    if (last && last.output_type === 'stream' && out.output_type === 'stream' && last.name === out.name) {
      last.text += out.text;
    } else {
      merged.push({ ...out });
    }
  }
  return merged;
}

function compactOutput(o: any): CompactOutput {
  switch (o.output_type) {
    case 'stream':
      return { type: 'stream', text: truncate(String(o.text ?? '')) };
    case 'error':
      return {
        type: 'error',
        ename: o.ename,
        evalue: o.evalue,
        text: Array.isArray(o.traceback) ? truncate(o.traceback.join('\n')) : undefined,
      };
    case 'execute_result':
    case 'display_data':
      return { type: o.output_type, data: summarizeData(o.data ?? {}) };
    default:
      return { type: o.output_type ?? 'unknown' };
  }
}

async function runCellOnce(
  session: Session.ISessionConnection,
  code: string,
  timeoutSec: number,
): Promise<{ status: ExecuteCellResult['status']; outputs: any[]; executionCount: number | null; error?: ExecuteCellResult['error'] }> {
  const kernel = session.kernel;
  if (!kernel) throw new Error('Session has no kernel');

  const outputs: any[] = [];
  let executionCount: number | null = null;
  let errorPayload: ExecuteCellResult['error'] | undefined;

  const future = kernel.requestExecute({
    code,
    allow_stdin: false,    // input() would otherwise hang the kernel forever
    store_history: true,   // keep In[n] counters honest for real notebook cells
  });

  future.onIOPub = (msg: KernelMessage.IIOPubMessage) => {
    const t = msg.header.msg_type;
    const c = msg.content as any;
    switch (t) {
      case 'stream':
        outputs.push({ output_type: 'stream', name: c.name, text: c.text });
        break;
      case 'display_data':
        outputs.push({ output_type: 'display_data', data: c.data, metadata: c.metadata ?? {} });
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
        errorPayload = { ename: c.ename, evalue: c.evalue, traceback: c.traceback };
        outputs.push({
          output_type: 'error',
          ename: c.ename,
          evalue: c.evalue,
          traceback: c.traceback,
        });
        break;
      case 'clear_output':
        outputs.length = 0;
        break;
      case 'execute_input':
        if (executionCount == null) executionCount = c.execution_count;
        break;
      // status / update_display_data: tracked by future.done / out of scope
    }
  };

  // future.done resolves after BOTH shell execute_reply AND iopub status:idle.
  // Race it against the timeout.
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutSec * 1000);
  });
  const winner = await Promise.race([
    future.done.then((r) => ({ reply: r })),
    timeoutPromise,
  ]);
  if (timer) clearTimeout(timer);

  if ('timedOut' in winner) {
    // Best-effort interrupt so a runaway cell doesn't hold the kernel busy.
    try { await kernel.interrupt(); } catch { /* ignore */ }
    return { status: 'timeout', outputs, executionCount };
  }

  const replyContent = (winner.reply as any)?.content;
  const status = (replyContent?.status as ExecuteCellResult['status']) ?? 'ok';
  return { status, outputs, executionCount, error: errorPayload };
}

export async function executeCell(
  notebookPath: string,
  cellId: string,
  opts: ExecuteOptions = {},
): Promise<ExecuteCellResult> {
  const timeoutSec = opts.timeoutSec ?? 60;
  const m = await ensureManager();

  // Read fresh nbformat to find the cell + capture surrounding doc state.
  const file: any = await m.contents.get(notebookPath, { content: true });
  const nb = file.content;
  if (!nb?.cells) throw new Error(`Not a notebook: ${notebookPath}`);

  const idx = nb.cells.findIndex((c: any) => c.id === cellId);
  if (idx < 0) {
    throw new Error(`Cell id '${cellId}' not found in ${notebookPath}. Re-list cells — id may have changed if the file was rewritten.`);
  }
  const cell = nb.cells[idx];
  if (cell.cell_type !== 'code') {
    throw new Error(`Cell '${cellId}' is '${cell.cell_type}', not 'code'. Only code cells can be executed.`);
  }
  const code = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');

  const session = await attachSession(notebookPath);
  let result;
  try {
    result = await runCellOnce(session, code, timeoutSec);
  } finally {
    // Client-side dispose only — session.shutdown() would kill the iframe's kernel.
    session.dispose();
  }

  // Persist outputs through the contents API. With jupyter-collaboration
  // installed (Phase 0), this routes through the ydoc and the iframe sees
  // the update without a "file changed on disk" dialog.
  nb.cells[idx].outputs = mergeStreamOutputs(result.outputs);
  nb.cells[idx].execution_count = result.executionCount;
  await m.contents.save(notebookPath, { type: 'notebook', format: 'json', content: nb });

  return {
    status: result.status,
    cell_id: cellId,
    execution_count: result.executionCount,
    outputs_summary: nb.cells[idx].outputs.map(compactOutput),
    error: result.error,
  };
}

export interface ExecuteRangeResult {
  status: 'ok' | 'error' | 'aborted' | 'timeout';
  cells: ExecuteCellResult[];
  stopped_at?: string;
}

export async function executeRange(
  notebookPath: string,
  fromCellId: string,
  toCellId: string,
  opts: ExecuteOptions = {},
): Promise<ExecuteRangeResult> {
  const m = await ensureManager();
  const file: any = await m.contents.get(notebookPath, { content: true });
  const nb = file.content;
  if (!nb?.cells) throw new Error(`Not a notebook: ${notebookPath}`);

  const fromIdx = nb.cells.findIndex((c: any) => c.id === fromCellId);
  const toIdx = nb.cells.findIndex((c: any) => c.id === toCellId);
  if (fromIdx < 0) throw new Error(`from_cell_id '${fromCellId}' not found`);
  if (toIdx < 0) throw new Error(`to_cell_id '${toCellId}' not found`);
  if (toIdx < fromIdx) throw new Error(`to_cell_id appears before from_cell_id in the notebook`);

  const targets: string[] = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    if (nb.cells[i].cell_type === 'code') targets.push(nb.cells[i].id);
  }

  const results: ExecuteCellResult[] = [];
  for (const cellId of targets) {
    const r = await executeCell(notebookPath, cellId, opts);
    results.push(r);
    if (r.status !== 'ok') {
      return { status: r.status, cells: results, stopped_at: cellId };
    }
  }
  return { status: 'ok', cells: results };
}

export interface ExecuteNotebookResult {
  status: 'ok' | 'interrupted' | 'failed';
  last_executed_cell_id: string | null;
  failed_cell_id?: string;
  error?: string;
  outputs_summary: Array<{
    cell_id: string;
    status: ExecuteCellResult['status'];
    execution_count: number | null;
    outputs: CompactOutput[];
  }>;
}

export async function executeNotebook(
  notebookPath: string,
  opts: ExecuteOptions = {},
): Promise<ExecuteNotebookResult> {
  const m = await ensureManager();
  const file: any = await m.contents.get(notebookPath, { content: true });
  const nb = file.content;
  if (!nb?.cells) throw new Error(`Not a notebook: ${notebookPath}`);

  const codeCells = (nb.cells as any[])
    .filter((cell) => cell.cell_type === 'code' && typeof cell.id === 'string')
    .map((cell) => cell.id as string);

  const outputsSummary: ExecuteNotebookResult['outputs_summary'] = [];
  let lastExecutedCellId: string | null = null;

  for (const cellId of codeCells) {
    const result = await executeCell(notebookPath, cellId, opts);
    lastExecutedCellId = cellId;
    outputsSummary.push({
      cell_id: cellId,
      status: result.status,
      execution_count: result.execution_count,
      outputs: result.outputs_summary,
    });

    if (result.status !== 'ok') {
      return {
        status: result.status === 'aborted' ? 'interrupted' : 'failed',
        last_executed_cell_id: lastExecutedCellId,
        failed_cell_id: cellId,
        error: result.error
          ? `${result.error.ename}: ${result.error.evalue}`
          : `Execution stopped with status ${result.status}`,
        outputs_summary: outputsSummary,
      };
    }
  }

  return {
    status: 'ok',
    last_executed_cell_id: lastExecutedCellId,
    outputs_summary: outputsSummary,
  };
}

export async function interruptKernel(notebookPath: string): Promise<{ ok: true }> {
  const session = await attachSession(notebookPath);
  try {
    if (!session.kernel) throw new Error('Session has no kernel to interrupt');
    await session.kernel.interrupt();
  } finally {
    session.dispose();
  }
  return { ok: true };
}

export async function restartKernel(notebookPath: string): Promise<{ ok: true; kernel_id: string }> {
  const session = await attachSession(notebookPath);
  try {
    if (!session.kernel) throw new Error('Session has no kernel to restart');
    await session.kernel.restart();
    return { ok: true, kernel_id: session.kernel.id };
  } finally {
    session.dispose();
  }
}

export interface KernelStateResult {
  attached: boolean;
  kernel_id: string | null;
  kernel_name: string | null;
  status: string | null;          // 'idle' | 'busy' | 'starting' | 'dead' | …
  execution_state: string | null; // alias of status — present in iopub messages
  last_execution_count: number | null;
}

export async function getKernelState(notebookPath: string): Promise<KernelStateResult> {
  const m = await ensureManager();
  await m.sessions.refreshRunning();
  const model = await m.sessions.findByPath(notebookPath);
  if (!model) {
    return {
      attached: false,
      kernel_id: null,
      kernel_name: null,
      status: null,
      execution_state: null,
      last_execution_count: null,
    };
  }

  const session = m.sessions.connectTo({ model });
  let lastExecCount: number | null = null;
  try {
    const file: any = await m.contents.get(notebookPath, { content: true });
    const counts = (file.content?.cells ?? [])
      .map((c: any) => (typeof c.execution_count === 'number' ? c.execution_count : null))
      .filter((n: number | null) => n != null) as number[];
    lastExecCount = counts.length ? Math.max(...counts) : null;
  } catch { /* ignore */ }

  const k = session.kernel;
  const result: KernelStateResult = {
    attached: true,
    kernel_id: k?.id ?? null,
    kernel_name: k?.name ?? null,
    status: k?.status ?? null,
    execution_state: k?.status ?? null,
    last_execution_count: lastExecCount,
  };
  session.dispose();
  return result;
}
