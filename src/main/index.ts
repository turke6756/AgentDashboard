import { app, BrowserWindow, dialog } from 'electron';
import path from 'path';
import { initDatabase } from './database';
import { AgentSupervisor } from './supervisor';
import { registerIpcHandlers } from './ipc-handlers';

// Prevent EPIPE crashes when stdout/stderr pipe is closed (e.g. parent shell exits)
process.stdout?.on?.('error', () => {});
process.stderr?.on?.('error', () => {});

let mainWindow: BrowserWindow | null = null;
let supervisor: AgentSupervisor | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    center: true,
    title: 'Agent Dashboard',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Try Vite dev server first (check multiple ports), fall back to built files
  const builtFile = path.join(__dirname, '..', '..', 'renderer', 'index.html');

  if (process.env.NODE_ENV === 'production' || app.isPackaged) {
    mainWindow.loadFile(builtFile);
  } else {
    // Vite may use 5173 or 5174+ if port is taken
    mainWindow.loadURL('http://localhost:5173').catch(() =>
      mainWindow!.loadURL('http://localhost:5174').catch(() =>
        mainWindow!.loadURL('http://localhost:5175').catch(() => {
          console.log('Dev server not available, loading built files');
          mainWindow!.loadFile(builtFile);
        })
      )
    );
  }

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('Page failed to load:', code, desc);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    console.log('Initializing database...');
    await initDatabase();
    console.log('Database initialized');

    supervisor = new AgentSupervisor();
    createWindow();
    registerIpcHandlers(supervisor, mainWindow!);
    supervisor.start();
    supervisor.reconcile();
    console.log('App ready');
  } catch (err: any) {
    console.error('Startup error:', err);
    dialog.showErrorBox('Startup Error', err.message || String(err));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  supervisor?.stop();
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
