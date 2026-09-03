#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = 'dist-dev/main/main/bootstrap.js'
const clearedKeys = [
  'DASHBOARD_PORT',
  'DASHBOARD_HOST',
  'AGENT_DASHBOARD_API_PORT',
  'AGENT_DASHBOARD_API_TOKEN',
  'AGENT_DASHBOARD_SELF_ID',
  'AGENT_DASHBOARD_WORKSPACE_ID',
]

function normalizedPort(value, fallback) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return String(fallback)
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? String(port)
    : String(fallback)
}

export function buildDevLaunchSpec(env) {
  const launchEnv = { ...env }
  for (const key of clearedKeys) delete launchEnv[key]

  launchEnv.LARES_DEV_INSTANCE = '1'
  launchEnv.LARES_DEV_API_PORT = normalizedPort(env.LARES_DEV_API_PORT, 24679)
  launchEnv.LARES_DEV_WS_PORT = normalizedPort(env.LARES_DEV_WS_PORT, 4546)
  launchEnv.LARES_DEV_JUPYTER_PORT = normalizedPort(env.LARES_DEV_JUPYTER_PORT, 18939)

  return {
    command: join(
      repoRoot,
      'node_modules',
      'electron',
      'dist',
      process.platform === 'win32' ? 'electron.exe' : 'electron',
    ),
    args: [entry],
    cwd: repoRoot,
    env: launchEnv,
  }
}

function run() {
  const spec = buildDevLaunchSpec(process.env)
  if (!existsSync(resolve(spec.cwd, spec.args[0]))) {
    console.error('dev-instance: run npm run build:dev first')
    process.exitCode = 1
    return
  }

  console.log(
    'dev-instance:',
    `LARES_DEV_API_PORT=${spec.env.LARES_DEV_API_PORT}`,
    `LARES_DEV_WS_PORT=${spec.env.LARES_DEV_WS_PORT}`,
    `LARES_DEV_JUPYTER_PORT=${spec.env.LARES_DEV_JUPYTER_PORT}`,
  )
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: 'inherit',
  })
  child.once('error', (error) => {
    console.error(`dev-instance: failed to launch Electron: ${error.message}`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    if (signal) {
      console.error(`dev-instance: Electron exited from signal ${signal}`)
      process.exitCode = 1
    } else {
      process.exitCode = code ?? 1
    }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run()
