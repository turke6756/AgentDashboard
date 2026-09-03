#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const npmCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm'
const npmArgs = (args) => process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...args] : args
const stablePort = Number(process.env.AGENT_DASHBOARD_API_PORT || process.env.DASHBOARD_PORT || 24678)
const stableToken = process.env.AGENT_DASHBOARD_API_TOKEN
const appData = process.env.APPDATA || join(homedir(), '.config')
const discoveryFile = join(appData, 'lares-app-dev', 'dev-instance.json')
const stableUserData = join(appData, 'lares-app')
const stableDb = join(appData, 'AgentDashboard', 'dashboard.db')
const devDb = join(appData, 'AgentDashboard-dev', 'dashboard.db')
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
const stableArtifacts = [
  join(codexHome, 'dashboard-worker.config.toml'),
  join(codexHome, 'dashboard-status.mjs'),
  join(codexHome, 'guard-git-discard.mjs'),
]
const logFile = join(tmpdir(), `lares-dev-instance-smoke-${process.pid}.log`)
const results = []

function record(name, passed, detail) {
  results.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'} | ${name} | ${detail}`)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function apiRequest(port, token) {
  const response = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  await response.json()
}

function tcpConnects(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (value) => {
      socket.destroy()
      resolvePromise(value)
    }
    socket.setTimeout(1_000, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function poll(description, probe, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

function printTable() {
  console.log('\nResult | Check | Detail')
  console.log('---|---|---')
  for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} | ${result.name} | ${result.detail}`)
  const passed = results.filter((result) => result.passed).length
  console.log(`\nSummary: ${passed}/${results.length} checks passed; ${results.length - passed} failed.`)
}

async function main() {
  console.log(`Stable API port: ${stablePort}`)
  console.log(`Discovery file: ${discoveryFile}`)
  console.log(`Detached dev log: ${logFile}`)
  if (!Number.isInteger(stablePort) || stablePort < 1 || stablePort > 65535 || !stableToken) {
    throw new Error('run this from a stable Lares agent environment with DASHBOARD_PORT and AGENT_DASHBOARD_API_TOKEN')
  }
  await apiRequest(stablePort, stableToken)
  record('stable process and API alive', true, `authenticated API answered on 127.0.0.1:${stablePort}`)

  if (existsSync(discoveryFile)) throw new Error(`a dev discovery file already exists; close it first: ${discoveryFile}`)
  record('discovery absent before launch', true, 'previous clean dev quit left no discovery file')

  const missingArtifacts = stableArtifacts.filter((file) => !existsSync(file))
  if (missingArtifacts.length) throw new Error(`stable Codex artifact missing: ${missingArtifacts.join(', ')}`)
  const beforeHashes = new Map(stableArtifacts.map((file) => [file, sha256(file)]))
  record('stable Codex artifacts captured', true, stableArtifacts.map((file) => `${file}=${beforeHashes.get(file)}`).join('; '))

  console.log('\nRunning npm run build:dev ...')
  const build = spawnSync(npmCommand, npmArgs(['run', 'build:dev']), { cwd: repoRoot, env: process.env, encoding: 'utf8' })
  if (build.stdout) process.stdout.write(build.stdout)
  if (build.stderr) process.stderr.write(build.stderr)
  if (build.error || build.status !== 0) throw new Error(`npm run build:dev failed (${build.error?.message || `exit ${build.status}`})`)
  record('isolated dev build', true, 'npm run build:dev exited 0; output directory dist-dev/')

  const logFd = openSync(logFile, 'a')
  const child = spawn(npmCommand, npmArgs(['run', 'dev:instance']), {
    cwd: repoRoot, env: process.env, detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
  })
  child.unref()
  closeSync(logFd)

  const discovery = await poll('dev discovery file', () => {
    if (!existsSync(discoveryFile) || statSync(discoveryFile).size === 0) return null
    const parsed = JSON.parse(readFileSync(discoveryFile, 'utf8'))
    return parsed?.port && parsed?.token && parsed?.pid ? parsed : null
  })
  record('dev process alive', processAlive(discovery.pid), `pid=${discovery.pid}`)
  record('discovery present while dev runs', true, `${discoveryFile}; port=${discovery.port}`)
  await poll('authenticated dev API', async () => { await apiRequest(discovery.port, discovery.token); return true })
  record('dev API reachable with dev token', true, `authenticated API answered on ${discovery.host}:${discovery.port}`)

  const expectedDevUserData = resolve(appData, 'lares-app-dev')
  record('distinct userData', resolve(discovery.userData) === expectedDevUserData && resolve(discovery.userData) !== resolve(stableUserData), `stable=${stableUserData}; dev=${discovery.userData}`)
  record('distinct DB files', resolve(stableDb) !== resolve(devDb) && existsSync(stableDb) && existsSync(devDb), `stable=${stableDb}; dev=${devDb}`)

  const wsPort = Number(process.env.LARES_DEV_WS_PORT || 4546)
  record('dev WebSocket port', await tcpConnects(wsPort), `listener reachable on 127.0.0.1:${wsPort}`)
  const jupyterPort = Number(process.env.LARES_DEV_JUPYTER_PORT || 18939)
  record('dev Jupyter port', jupyterPort !== 18888 && jupyterPort >= 1 && jupyterPort <= 65535, `configured base=${jupyterPort}; stable base=18888 (Jupyter starts on demand)`)

  const second = spawnSync(npmCommand, npmArgs(['run', 'dev:instance']), { cwd: repoRoot, env: process.env, encoding: 'utf8', timeout: 20_000, windowsHide: true })
  const secondOutput = `${second.stdout || ''}${second.stderr || ''}`
  if (second.stdout) process.stdout.write(second.stdout)
  if (second.stderr) process.stderr.write(second.stderr)
  const refusalLogged = /Another instance is already running/i.test(secondOutput)
  record('second dev launch refused', !second.error && second.status === 0 && refusalLogged, `exit=${second.status}; lock refusal logged=${refusalLogged}`)

  const changedArtifacts = stableArtifacts.filter((file) => !existsSync(file) || sha256(file) !== beforeHashes.get(file))
  record('stable Codex artifacts byte-unchanged', changedArtifacts.length === 0, changedArtifacts.length ? changedArtifacts.join(', ') : 'all three SHA-256 hashes unchanged')
  record('both copies coexist', await tcpConnects(stablePort) && processAlive(discovery.pid), `stable API port=${stablePort}; dev pid=${discovery.pid}, API port=${discovery.port}`)
  console.log(`\nDev instance intentionally left running: pid=${discovery.pid}, API port=${discovery.port}`)
  console.log(`Its discovery file is removed by Lares when that dev instance quits: ${discoveryFile}`)
  printTable()
  if (results.some((result) => !result.passed)) process.exitCode = 1
}

main().catch((error) => {
  record('smoke completed', false, error instanceof Error ? error.message : String(error))
  printTable()
  process.exitCode = 1
})
