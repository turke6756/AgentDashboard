import { app, BrowserWindow, dialog, protocol, net } from 'electron';
import path from 'path';
import { initDatabase } from './database';
import { AgentSupervisor } from './supervisor';
import { registerIpcHandlers } from './ipc-handlers';
import { WsServer } from './ws-server';
import { ApiServer } from './api-server';
import { pathToFileURL } from 'url';
import { wslToWindowsPath } from './path-utils';

// Prevent EPIPE crashes when stdout/stderr pipe is closed (e.g. parent shell exits)
process.stdout?.on?.('error', () => {});
process.stderr?.on?.('error', () => {});

let mainWindow: BrowserWindow | null = null;
let supervisor: AgentSupervisor | null = null;
let wsServer: WsServer | null = null;
let apiServer: ApiServer | null = null;

// Single-instance lock — prevent duplicate windows
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('Another instance is already running — exiting.');
  app.quit();
}
app.on('second-instance', () => {
  // Focus the existing window when a second instance tries to launch
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Register media protocol before app is ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } }
]);

function createWindow(): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'icon.ico')
    : path.join(__dirname, '..', '..', '..', 'assets', 'icon.ico');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    center: true,
    title: 'Agent Dashboard',
    icon: iconPath,
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true, // Keep enabled but use custom protocol
    },
  });

  // Try Vite dev server first (check multiple ports), fall back to built files
  const builtFile = path.join(__dirname, '..', '..', 'renderer', 'index.html');

  if (process.env.NODE_ENV === 'production' || app.isPackaged) {
    mainWindow.loadFile(builtFile);
  } else {
    // Check if a Vite dev server is running before trying to connect
    const http = require('http');
    const tryPort = (port: number): Promise<boolean> =>
      new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.setTimeout(500, () => { req.destroy(); resolve(false); });
      });

    (async () => {
      for (const port of [5173, 5174, 5175]) {
        if (await tryPort(port)) {
          console.log(`Dev server found on port ${port}`);
          mainWindow!.loadURL(`http://localhost:${port}`);
          return;
        }
      }
      console.log('No dev server found, loading built files');
      mainWindow!.loadFile(builtFile);
    })();
  }

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('Page failed to load:', code, desc);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Handle media:// protocol — URLs are media://file/<encodedPath>
  protocol.handle('media', async (request) => {
    const urlObj = new URL(request.url);
    // Path is /<encodedFilePath>, strip leading slash and decode
    const decodedUrl = decodeURIComponent(urlObj.pathname.slice(1));

    let filePath = decodedUrl;
    
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = wslToWindowsPath(filePath);
    }

    try {
      const response = await net.fetch(pathToFileURL(filePath).toString());
      const headers = new Headers(response.headers);
      
      // Explicitly set Content-Type based on extension if missing or generic
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.avif': 'image/avif',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.svg': 'image/svg+xml',
      };
      if (mimeMap[ext]) {
        headers.set('Content-Type', mimeMap[ext]);
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err) {
      console.error('Failed to fetch media:', err);
      return new Response('File not found', { status: 404 });
    }
  });

  try {
    console.log('Initializing database...');
    await initDatabase();
    console.log('Database initialized');

    supervisor = new AgentSupervisor();
    createWindow();
    registerIpcHandlers(supervisor, mainWindow!);
    supervisor.start();
    wsServer = new WsServer(supervisor);
    wsServer.start();
    apiServer = new ApiServer(supervisor);
    apiServer.start();
    supervisor.reconcile();
    console.log('App ready');
  } catch (err: any) {
    console.error('Startup error:', err);
    dialog.showErrorBox('Startup Error', err.message || String(err));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  apiServer?.stop();
  wsServer?.stop();
  supervisor?.stop();
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
