import { ChildProcess } from 'child_process';
import crypto from 'crypto';
import { wslSpawn, wslExec } from './wsl-bridge';

export interface JupyterServerInfo {
  baseUrl: string;
  token: string;
  ready: boolean;
}

const VENV_PATH = '/home/turke/GIS_Analysis/NEON_GIS_CrestedButte_Analysis/.venv';

let proc: ChildProcess | null = null;
let info: JupyterServerInfo | null = null;
let pending: Promise<JupyterServerInfo> | null = null;

// Match only non-zero ports. Jupyter 2.17+ with `--port=0` logs the literal
// `0` in the startup URL even though the server binds to an OS-assigned port,
// so we pin to a fixed safe port with retries instead.
const URL_REGEX = /https?:\/\/(?:127\.0\.0\.1|localhost):([1-9]\d*)\/(?:\?token=([a-f0-9]+))?/i;

// Chromium blocks many low ports (ERR_UNSAFE_PORT). 18888 is well clear of the blocklist.
const BASE_PORT = 18888;

function buildCommand(token: string): string {
  // CSP override lets the Electron renderer (different origin) embed /lab in an iframe.
  const tornadoSettings = `{"headers": {"Content-Security-Policy": "frame-ancestors *"}}`;
  const args = [
    '--no-browser',
    `--ServerApp.port=${BASE_PORT}`,
    '--ServerApp.port_retries=50',
    // IdentityProvider.token is the new canonical path in Jupyter 2.x;
    // ServerApp.token is deprecated and — critically — no longer consulted
    // by the WebSocket auth handler, which caused 403s on kernel channel
    // upgrades from the iframe.
    `--IdentityProvider.token=${token}`,
    '--ServerApp.root_dir=/',
    `--ServerApp.allow_origin='*'`,
    '--ServerApp.allow_origin_pat=.*',
    '--ServerApp.disable_check_xsrf=True',
    `--ServerApp.tornado_settings='${tornadoSettings}'`,
    // Loads ~/.jupyter/custom/custom.css into the Lab UI. We use it to
    // strip JupyterLab chrome down to just the notebook surface.
    '--LabApp.custom_css=True',
  ].join(' ');
  return `. ${VENV_PATH}/bin/activate && exec jupyter lab ${args}`;
}

// JupyterLab's default autosave is 120s, which left executed cells' outputs
// off-disk for up to 2 minutes — agents reading the .ipynb saw stale content
// until the user hit Ctrl+S. Drop to 10s. Written as a settings override into
// the venv's lab settings directory (canonical location per JupyterLab docs).
async function ensureAutosaveOverride(): Promise<void> {
  const overridesDir = `${VENV_PATH}/share/jupyter/lab/settings`;
  const overridesPath = `${overridesDir}/overrides.json`;
  const overrides = {
    '@jupyterlab/docmanager-extension:plugin': {
      autosaveInterval: 10,
    },
  };
  const json = JSON.stringify(overrides).replace(/'/g, `'\\''`);
  await wslExec(`mkdir -p '${overridesDir}' && printf '%s' '${json}' > '${overridesPath}'`);
}

// Phase 2 Step A — strip JupyterLab chrome down to just the notebook surface.
// Loaded by --LabApp.custom_css=True from ~/.jupyter/custom/custom.css.
// Selectors target Lab 4.x; layered defensively so a renamed class on either
// side still leaves the rest working. Iterate by editing this string.
const CUSTOM_CSS = `
/* AgentDashboard: hide JupyterLab chrome and reclaim its layout space.
   Two-part trick — display:none for the chrome, then !important positioning
   on the surviving panels to override Lumino's JS-set inline styles. */

/* === Hide chrome === */

/* Top menubar (File / Edit / View / Run / Kernel / etc.) and surrounding panel. */
#jp-top-panel,
#jp-menu-panel,
#jp-MainMenu,
.lm-MenuBar,
.jp-MainMenu { display: none !important; }

/* Left and right sidebars (file browser, running kernels, property inspector). */
#jp-left-stack,
#jp-right-stack,
#jp-left-sidebar,
#jp-right-sidebar,
.jp-SideBar { display: none !important; }

/* Bottom status bar and its log/kernel indicator widgets. */
#jp-main-statusbar,
.jp-StatusBar { display: none !important; }

/* Document tab bar inside the dock panel (shows the open notebook's name). */
.lm-DockPanel-tabBar,
.jp-Activity .lm-TabBar { display: none !important; }

/* Branding and ambient header chrome. */
#jp-MainLogo,
.jp-NotebookCheckpoint,
.jp-NotebookKernelLogo,
.jp-NotebookTrustedStatus { display: none !important; }

/* === Reclaim layout space ===
   Lumino's BoxLayout sets explicit inline top/left/width/height on these so
   they clear the chrome we just hid. !important wins over inline styles for
   property declarations, which is the only way to re-flow without Lumino's
   own API. Cover every panel that sits between #main and the notebook. */

#main,
#jp-main-content-panel,
#jp-main-split-panel,
#jp-main-vsplit-panel,
#jp-main-dock-panel {
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100% !important;
  height: 100% !important;
}

/* The widget inside the dock panel that holds the notebook itself. */
.lm-DockPanel-widget,
.jp-NotebookPanel {
  top: 0 !important;
  left: 0 !important;
  width: 100% !important;
  height: 100% !important;
}
`;

async function ensureCustomCssOverride(): Promise<void> {
  // JupyterLab 4 reads custom CSS from <jupyter_config_dir>/custom/custom.css
  // when --LabApp.custom_css=True is passed. ~ expands because wslExec runs
  // through `bash -lc`. Cached on first request, so the file must exist
  // before the lab process boots.
  const escaped = CUSTOM_CSS.replace(/'/g, `'\\''`);
  await wslExec(`mkdir -p ~/.jupyter/custom && printf '%s' '${escaped}' > ~/.jupyter/custom/custom.css`);
}

async function spawnServer(): Promise<JupyterServerInfo> {
  await ensureAutosaveOverride();
  await ensureCustomCssOverride();
  // Empty token disables Jupyter's auth challenge. Safe here because the
  // server binds to 127.0.0.1 only, and auth via cookies is unreliable from
  // a `null`-origin (file://) iframe anyway — SameSite=Lax defaults strip
  // them on the WebSocket upgrade, causing kernel connections to 403.
  const token = '';
  const child = wslSpawn(buildCommand(token));
  proc = child;

  return new Promise((resolve, reject) => {
    let resolved = false;
    const chunks: string[] = [];

    const onOutput = (data: Buffer) => {
      const text = data.toString('utf-8');
      chunks.push(text);
      process.stdout.write(`[jupyter-server] ${text}`);
      if (resolved) return;
      const match = text.match(URL_REGEX) || chunks.join('').match(URL_REGEX);
      if (match) {
        const port = match[1];
        info = {
          baseUrl: `http://127.0.0.1:${port}/`,
          token,
          ready: true,
        };
        resolved = true;
        resolve(info);
      }
    };

    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    child.on('exit', (code, signal) => {
      console.log(`[jupyter-server] exited code=${code} signal=${signal}`);
      proc = null;
      info = null;
      if (!resolved) {
        resolved = true;
        reject(new Error(`jupyter-server exited before emitting URL (code=${code}). Output:\n${chunks.join('')}`));
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`jupyter-server did not emit URL within 30s. Output:\n${chunks.join('')}`));
      }
    }, 30000);
  });
}

export async function ensureJupyterServer(): Promise<JupyterServerInfo> {
  if (info?.ready) return info;
  if (pending) return pending;
  pending = spawnServer().finally(() => { pending = null; });
  return pending;
}

export function getJupyterServerInfo(): JupyterServerInfo | null {
  return info;
}

export async function shutdownJupyterServer(): Promise<void> {
  if (!proc) return;
  const p = proc;
  proc = null;
  info = null;
  try {
    p.kill('SIGTERM');
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 3000);
  } catch (err) {
    console.error('[jupyter-server] error during shutdown:', err);
  }
}

export async function listKernelspecs(): Promise<unknown> {
  const server = await ensureJupyterServer();
  const res = await fetch(`${server.baseUrl}api/kernelspecs?token=${server.token}`);
  if (!res.ok) throw new Error(`kernelspecs failed: ${res.status} ${res.statusText}`);
  return res.json();
}
