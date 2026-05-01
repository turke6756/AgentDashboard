// One-shot diagnostic: read dashboard.db and print resume_session_id for each agent.
// Mirrors src/main/database.ts loading approach (sql.js, file buffer).
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

(async () => {
  const SQL = await initSqlJs();
  const dbPath = path.join(process.env.APPDATA || '', 'AgentDashboard', 'dashboard.db');
  if (!fs.existsSync(dbPath)) {
    console.error('DB not found at', dbPath);
    process.exit(1);
  }
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);

  const res = db.exec(`
    SELECT id, title, status, working_directory, resume_session_id, last_exit_code, restart_count, tmux_session_name
    FROM agents
    ORDER BY working_directory, title
  `);

  if (!res.length) {
    console.log('(no agents)');
    return;
  }
  const cols = res[0].columns;
  for (const row of res[0].values) {
    const r = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
    console.log(
      `[${r.status.padEnd(10)}] ${r.title}\n` +
      `  id=${r.id}  exit=${r.last_exit_code}  restarts=${r.restart_count}\n` +
      `  cwd=${r.working_directory}\n` +
      `  resume=${JSON.stringify(r.resume_session_id)}\n` +
      `  tmux=${r.tmux_session_name || ''}\n`
    );
  }
})();
