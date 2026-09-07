#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'

function usage(message) {
  if (message) console.error(message)
  console.error('Usage: node scripts/repair-codex-sid.mjs --agent-id <id> [--dry-run] [--db <dashboard.db>] [--window-minutes <1..60>]')
  process.exitCode = 2
}

function parseArgs(argv) {
  const out = { dryRun: false, windowMinutes: 15, dbPath: null, agentId: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--agent-id') out.agentId = argv[++i] ?? null
    else if (arg === '--db') out.dbPath = argv[++i] ?? null
    else if (arg === '--window-minutes') out.windowMinutes = Number(argv[++i])
    else return null
  }
  if (!out.agentId || !Number.isInteger(out.windowMinutes) || out.windowMinutes < 1 || out.windowMinutes > 60) return null
  out.dbPath ??= path.join(process.env.APPDATA ?? '', 'AgentDashboard', 'dashboard.db')
  return out
}

function walkJsonl(root) {
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const dir = pending.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) pending.push(full)
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  return files
}

function textOfUserItem(item) {
  if (item?.type !== 'response_item' || item.payload?.role !== 'user' || !Array.isArray(item.payload.content)) return null
  return item.payload.content.map((part) => part?.text ?? part?.input_text ?? '').join('')
}

function inspectRollout(file, expectedCwd, fromMs, untilMs, kickoffPrefix, notePrefix) {
  let lines
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/) } catch { return null }
  let meta = null
  let kickoffMatched = false
  for (const line of lines) {
    if (!line) continue
    let item
    try { item = JSON.parse(line) } catch { continue }
    if (!meta && item.type === 'session_meta') meta = item.payload ?? null
    const userText = textOfUserItem(item)
    if (userText?.startsWith(kickoffPrefix) && userText.includes(notePrefix)) kickoffMatched = true
    if (meta && kickoffMatched) break
  }
  const createdMs = Date.parse(meta?.timestamp ?? '')
  const sessionId = typeof meta?.id === 'string' ? meta.id : meta?.session_id
  if (!sessionId || !Number.isFinite(createdMs)) return null
  if (path.resolve(String(meta.cwd ?? '')).toLowerCase() !== path.resolve(expectedCwd).toLowerCase()) return null
  if (createdMs < fromMs || createdMs > untilMs || !kickoffMatched) return null
  return { sessionId, createdAt: new Date(createdMs).toISOString(), file }
}

const options = parseArgs(process.argv.slice(2))
if (!options) {
  usage()
} else {
  const db = new DatabaseSync(options.dbPath, { readOnly: options.dryRun })
  const agent = db.prepare(`SELECT id, provider, working_directory, resume_session_id, continuation_generation
    FROM agents WHERE id = ?`).get(options.agentId)
  const attempt = db.prepare(`SELECT id, generation, closed_at FROM continuation_handoff_attempts
    WHERE dashboard_agent_id = ? AND status = 'relaunched' ORDER BY started_at DESC LIMIT 1`).get(options.agentId)
  const brick = attempt ? db.prepare(`SELECT note FROM continuation_bricks
    WHERE handoff_attempt_id = ? ORDER BY written_at DESC LIMIT 1`).get(attempt.id) : null

  if (!agent || agent.provider !== 'codex' || !attempt || !brick?.note || !attempt.closed_at) {
    console.error(JSON.stringify({ ok: false, reason: 'agent/attempt/brick not repairable', agentId: options.agentId }, null, 2))
    process.exitCode = 1
  } else {
    const fromMs = Date.parse(`${attempt.closed_at.replace(' ', 'T')}Z`)
    const untilMs = fromMs + options.windowMinutes * 60_000
    const kickoffPrefix = `You are CONTINUATION #${attempt.generation}`
    const notePrefix = String(brick.note).replace(/\r\n/g, '\n').slice(0, 160)
    const owned = new Set(db.prepare(`SELECT resume_session_id AS sid FROM agents
      WHERE id <> ? AND resume_session_id IS NOT NULL
      UNION SELECT session_id AS sid FROM agent_sessions WHERE dashboard_agent_id <> ?`).all(agent.id, agent.id).map((row) => row.sid))
    const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions')
    const candidates = walkJsonl(sessionsRoot)
      .map((file) => inspectRollout(file, agent.working_directory, fromMs, untilMs, kickoffPrefix, notePrefix))
      .filter(Boolean)
      .filter((candidate) => !owned.has(candidate.sessionId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    const report = {
      ok: candidates.length === 1,
      dryRun: options.dryRun,
      agentId: agent.id,
      currentSessionId: agent.resume_session_id,
      attemptId: attempt.id,
      generation: attempt.generation,
      window: { from: new Date(fromMs).toISOString(), until: new Date(untilMs).toISOString() },
      kickoffPrefix,
      notePrefix,
      candidates,
    }

    if (candidates.length !== 1) {
      report.reason = `refusing repair: expected exactly one unowned candidate, found ${candidates.length}`
      console.error(JSON.stringify(report, null, 2))
      process.exitCode = 1
    } else if (options.dryRun) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      const candidate = candidates[0]
      db.exec('BEGIN IMMEDIATE')
      try {
        const collision = db.prepare(`SELECT dashboard_agent_id FROM agent_sessions
          WHERE session_id = ? AND dashboard_agent_id <> ?`).get(candidate.sessionId, agent.id)
        if (collision) throw new Error(`candidate became owned by ${collision.dashboard_agent_id}`)
        const existingReal = db.prepare(`SELECT id FROM agent_sessions
          WHERE dashboard_agent_id = ? AND session_id = ?`).get(agent.id, candidate.sessionId)
        if (existingReal) {
          db.prepare(`UPDATE agent_sessions SET generation = ?, working_directory = ?, provider = 'codex', ended_at = NULL
            WHERE id = ?`).run(attempt.generation, agent.working_directory, existingReal.id)
          if (agent.resume_session_id && agent.resume_session_id !== candidate.sessionId) {
            db.prepare(`UPDATE agent_sessions SET ended_at = COALESCE(ended_at, datetime('now'))
              WHERE dashboard_agent_id = ? AND session_id = ?`).run(agent.id, agent.resume_session_id)
          }
        } else {
          const corrected = agent.resume_session_id ? db.prepare(`UPDATE agent_sessions
            SET session_id = ?, generation = ?, working_directory = ?, provider = 'codex', ended_at = NULL
            WHERE dashboard_agent_id = ? AND session_id = ?`).run(
              candidate.sessionId, attempt.generation, agent.working_directory, agent.id, agent.resume_session_id,
            ) : { changes: 0 }
          if (corrected.changes === 0) {
            db.prepare(`INSERT INTO agent_sessions
              (dashboard_agent_id, generation, session_id, working_directory, provider, started_at)
              VALUES (?, ?, ?, ?, 'codex', datetime('now'))`).run(
              agent.id, attempt.generation, candidate.sessionId, agent.working_directory,
            )
          }
        }
        db.prepare(`UPDATE agents SET resume_session_id = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(candidate.sessionId, agent.id)
        db.exec('COMMIT')
        console.log(JSON.stringify({ ...report, repairedSessionId: candidate.sessionId }, null, 2))
      } catch (error) {
        db.exec('ROLLBACK')
        console.error(JSON.stringify({ ...report, ok: false, reason: String(error) }, null, 2))
        process.exitCode = 1
      }
    }
  }
}
