# ⚠️ WARNING: Ghost Vite Dev Servers During Testing

When developing or debugging the Electron dashboard (specifically the React frontend), you may encounter an issue where **your frontend changes do not appear to take effect when the app is launched**, even after rebuilding the project or restarting Electron.

## The Cause

Electron's `src/main/index.ts` is programmed to look for a running Vite development server on `http://localhost:5173` (or `5174`, `5175`). If it detects a server on those ports, it will load the frontend UI from that server instead of loading your freshly compiled files from the local `/dist` directory.

If an older Vite process (`npm run dev:renderer`) crashes, becomes disconnected from the terminal, or is left running in the background (a "ghost process"), **Electron will silently connect to this stale background server**. 

This will result in you constantly modifying, compiling, and testing code, while the app continues to display the original, broken, un-updated UI from the ghost server.

## How to Check for and Fix This

If your UI changes are mysteriously not appearing in the Electron app:

1. **Close the Electron application.**
2. **Find any rogue Node/Vite processes listening on port 5173.** You can do this on Windows via PowerShell:
   ```powershell
   netstat -ano | findstr :5173
   ```
   Or inside WSL:
   ```bash
   lsof -i :5173
   # or
   ps aux | grep vite
   ```
3. **Kill the ghost processes.** 
   ```bash
   kill -9 <PID>
   ```
4. **Rebuild the frontend.**
   ```bash
   npx vite build
   ```
5. **Relaunch Electron.**
   ```bash
   npx electron .
   ```

By clearing out the rogue development server, Electron will fall back to using your newly compiled `/dist/renderer/index.html`, and your updates will finally take effect.
