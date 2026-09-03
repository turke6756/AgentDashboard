# Develop Lares without restarting the running instance

Keep the stable Lares window running from `dist/` while testing current source in a separately built dev copy. The dev copy uses `dist-dev/`, its own Electron profile and database, and separate API, WebSocket, and Jupyter ports.

## One-time smoke workspace setup

Create a directory outside this checkout, for example `C:\Users\turke\Projects\lares-dev-smoke`. In the dev window, add that directory as the test workspace. A dev instance refuses this Lares checkout (or one of its parent directories) as a workspace so its agents cannot modify the source tree under test.

The optional manual coexistence check must be started from a terminal or agent environment belonging to the running stable copy, because it uses that copy's API port and token:

```powershell
node scripts/dev-instance-smoke.mjs
```

The smoke builds into `dist-dev/`, launches a dev copy, checks process, profile, database, ports, discovery, single-instance locking, and stable Codex artifact isolation, then leaves the dev copy running. It is intentionally not part of the main test runner. Close the dev window normally when finished; Lares removes `%APPDATA%\lares-app-dev\dev-instance.json` during shutdown.

## Daily loop

From the Lares checkout, while stable Lares continues to run:

```powershell
npm run build:dev
npm run dev:instance
```

After another source edit, close only the dev window, run `npm run build:dev` again, and relaunch it with `npm run dev:instance`. Never use `npm run build`, `npm run start`, or `npm run restart` for this loop: those commands use the stable `dist/` tree.

The default dev endpoints are API `24679`, WebSocket `4546`, and Jupyter base `18939`. The API and WebSocket listeners increment on collision. The VS Code extension does not participate in dev-instance discovery; when testing it against the dev WebSocket, configure port `4546` (or the bound port reported in the dev log).

## Verify through the stable copy

The running dev copy publishes `%APPDATA%\lares-app-dev\dev-instance.json`. Agent tools in the stable copy can use it to complete an end-to-end loop:

1. Call `list_workspaces` with `instance: "dev"` and select the smoke workspace ID.
2. Call `launch_agent` with `instance: "dev"`, that explicit `workspace_id`, and the desired prompt.
3. Drive it with `send_message_to_agent` or `send_keys_to_agent`, always with `instance: "dev"`.
4. Poll `read_agent_chat` with `instance: "dev"` until the result is ready, then call `stop_agent` with `instance: "dev"`.

Dev-side dashboard events are not relayed to the stable supervisor, so polling `read_agent_chat` is required. The blocking send handshake confirms delivery but does not relay later idle or crash events.

## Promote a verified change

Once the dev copy has proved the change and you choose a maintenance window, close the dev copy and promote the current source to stable once:

```powershell
npm run restart
```

This is the point at which stable `dist/` is rebuilt and the stable process is restarted.

## Optional worktree

A separate Git worktree can run the same `build:dev` and `dev:instance` commands when source isolation is useful. It needs its own dependency installation and native-module rebuild, and verified changes must be merged back. A worktree is optional; `dist-dev/` already keeps the normal same-checkout loop from overwriting stable `dist/`.
