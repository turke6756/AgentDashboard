const { initDatabase, getWorkspaces, getSupervisorAgent } = require('./dist/main/main/database');

async function main() {
  await initDatabase();
  const workspaces = getWorkspaces();
  console.log('--- Workspaces ---');
  for (const ws of workspaces) {
    const supervisor = getSupervisorAgent(ws.id);
    console.log(`${ws.title} (${ws.id}) - Supervisor: ${supervisor ? supervisor.id : 'None'}`);
  }
}

main().catch(console.error);
