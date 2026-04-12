import { AgentStatus, GroupThinkSession } from '../../shared/types';

export interface SupervisorEvent {
  type: 'status_change' | 'context_threshold' | 'groupthink_start' | 'team_created' | 'team_loop_detected';
  agentId: string;
  agentTitle: string;
  workspaceId: string;
  fromStatus?: AgentStatus;
  toStatus?: AgentStatus;
  lastExitCode?: number | null;
  contextPercentage?: number;
  contextWindowMax?: number;
  totalContextTokens?: number;
  turnCount?: number;
  model?: string;
  logTail?: string;
  // Group Think fields
  groupthinkSessionId?: string;
  groupthinkTopic?: string;
  groupthinkMembers?: { agentId: string; title: string; provider: string }[];
  groupthinkMaxRounds?: number;
  // Team fields
  teamId?: string;
  teamName?: string;
  teamMembers?: { agentId: string; title: string; provider: string; role: string }[];
  teamTemplate?: string;
  loopAgentA?: string;
  loopAgentB?: string;
  loopAlternations?: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

function formatLogTail(logTail: string | undefined, maxLines: number): string {
  if (!logTail?.trim()) return '';
  const lines = logTail.trim().split('\n').slice(-maxLines);
  return '\nLast output:\n' + lines.map(l => `> ${l}`).join('\n');
}

function formatContext(event: SupervisorEvent): string {
  if (event.contextPercentage == null) return '';
  const tokens = event.totalContextTokens != null && event.contextWindowMax != null
    ? ` (${formatTokens(event.totalContextTokens)}/${formatTokens(event.contextWindowMax)} tokens`
      + (event.turnCount != null ? `, ${event.turnCount} turns)` : ')')
    : '';
  return `\nContext: ${event.contextPercentage}%${tokens}`;
}

export function buildEventPayload(event: SupervisorEvent): string {
  const agentLine = `Agent: "${event.agentTitle}" (${event.agentId.slice(0, 8)})`;

  if (event.type === 'status_change') {
    const statusLine = event.fromStatus && event.toStatus
      ? `Status: ${event.fromStatus} → ${event.toStatus}`
      : `Status: ${event.toStatus || 'unknown'}`;
    const exitLine = event.toStatus === 'crashed' && event.lastExitCode != null
      ? `\nExit code: ${event.lastExitCode}`
      : '';

    return [
      '[DASHBOARD EVENT] Agent status changed',
      agentLine,
      statusLine + exitLine,
      formatContext(event),
      formatLogTail(event.logTail, 5),
    ].filter(Boolean).join('\n');
  }

  if (event.type === 'context_threshold') {
    return [
      '[DASHBOARD EVENT] Context threshold crossed',
      agentLine,
      formatContext(event),
      `Threshold: ${event.contextPercentage}% — compact this agent (read log, launch new agent with summary, stop old agent)`,
    ].filter(Boolean).join('\n');
  }

  if (event.type === 'groupthink_start') {
    const members = (event.groupthinkMembers || [])
      .map(m => `  - "${m.title}" (${m.agentId.slice(0, 8)}) [${m.provider}]`)
      .join('\n');
    return [
      '[DASHBOARD EVENT] Group Think session started',
      `Session: ${event.groupthinkSessionId}`,
      `Topic: ${event.groupthinkTopic}`,
      `Max rounds: ${event.groupthinkMaxRounds}`,
      `Enrolled agents:\n${members}`,
      '',
      'Follow the Group Think protocol in your instructions: brief each agent, monitor rounds, cross-pollinate, and synthesize.',
    ].join('\n');
  }

  if (event.type === 'team_created') {
    const members = (event.teamMembers || [])
      .map(m => `  - "${m.title}" (${m.agentId.slice(0, 8)}) [${m.provider}] — ${m.role}`)
      .join('\n');
    return [
      '[TEAM EVENT] Team created',
      `Team: "${event.teamName}" (${event.teamId})`,
      `Template: ${event.teamTemplate || 'custom'}`,
      `Members:\n${members}`,
      '',
      'Team members now have MCP tools (send_message, get_messages, get_tasks, etc.) to communicate directly. Monitor via get_team.',
    ].join('\n');
  }

  if (event.type === 'team_loop_detected') {
    return [
      '[TEAM EVENT] Communication loop detected',
      `Team: "${event.teamName}" (${event.teamId})`,
      `Between: ${event.loopAgentA} ↔ ${event.loopAgentB}`,
      `Alternations: ${event.loopAlternations}`,
      '',
      'The pair has been temporarily blocked. Assess the situation: modify channels, send new instructions, or remove one agent from the team.',
    ].join('\n');
  }

  return `[DASHBOARD EVENT] Unknown event type: ${event.type}`;
}

export function buildConsolidatedPayload(events: SupervisorEvent[]): string {
  if (events.length === 1) return buildEventPayload(events[0]);

  const lines = [`[DASHBOARD EVENT] ${events.length} events occurred while you were busy:\n`];
  for (const event of events) {
    const title = `"${event.agentTitle}" (${event.agentId.slice(0, 8)})`;
    if (event.type === 'status_change') {
      lines.push(`- ${title}: ${event.fromStatus} → ${event.toStatus}`);
    } else if (event.type === 'context_threshold') {
      lines.push(`- ${title}: context at ${event.contextPercentage}%`);
    }
  }
  lines.push('\nUse list_agents and read_agent_log to assess each agent.');
  return lines.join('\n');
}
