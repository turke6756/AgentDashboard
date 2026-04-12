import React, { useState, useEffect } from 'react';
import type { Team, TeamMessage, TeamTask } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import TeamGraph from './TeamGraph';
import TeamMessageFlow from './TeamMessageFlow';
import TeamTaskBoard from './TeamTaskBoard';

interface Props {
  team: Team;
}

type TabId = 'graph' | 'messages' | 'tasks';

const TABS: { id: TabId; label: string }[] = [
  { id: 'graph', label: 'Graph' },
  { id: 'messages', label: 'Messages' },
  { id: 'tasks', label: 'Tasks' },
];

const STATUS_DOT: Record<string, string> = {
  active: 'bg-green-400',
  paused: 'bg-yellow-400',
  disbanded: 'bg-gray-500',
};

const TEMPLATE_BADGE: Record<string, { bg: string; text: string }> = {
  groupthink: { bg: 'bg-purple-500/20', text: 'text-purple-400' },
  pipeline:   { bg: 'bg-blue-500/20',   text: 'text-blue-400' },
  custom:     { bg: 'bg-gray-500/20',   text: 'text-gray-400' },
};

export default function TeamPanel({ team }: Props) {
  const { teamMessages, loadTeamMessages, disbandTeam } = useDashboardStore();
  const [activeTab, setActiveTab] = useState<TabId>('graph');
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [disbanding, setDisbanding] = useState(false);

  const messages: TeamMessage[] = teamMessages[team.id] ?? [];
  const memberCount = team.members?.length ?? 0;
  const templateStyle = TEMPLATE_BADGE[team.template ?? 'custom'] ?? TEMPLATE_BADGE.custom;

  // Load messages when switching to messages tab or on mount
  useEffect(() => {
    if (activeTab === 'messages') {
      loadTeamMessages(team.id);
    }
  }, [activeTab, team.id, loadTeamMessages]);

  // Load tasks when switching to tasks tab
  useEffect(() => {
    if (activeTab === 'tasks') {
      window.api.teams.getTasks(team.id).then(setTasks).catch(console.error);
    }
  }, [activeTab, team.id]);

  const handleDisband = async () => {
    if (disbanding) return;
    setDisbanding(true);
    try {
      await disbandTeam(team.id);
    } catch (err) {
      console.error('Failed to disband team:', err);
      setDisbanding(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            {/* Status dot */}
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${STATUS_DOT[team.status] ?? 'bg-gray-500'}`} />
            {/* Name */}
            <h2 className="text-white font-semibold text-base truncate">{team.name}</h2>
            {/* Template badge */}
            {team.template && (
              <span className={`text-xs px-1.5 py-0.5 rounded ${templateStyle.bg} ${templateStyle.text}`}>
                {team.template}
              </span>
            )}
            {/* Member count */}
            <span className="text-xs text-gray-500">{memberCount} member{memberCount !== 1 ? 's' : ''}</span>
          </div>

          {/* Disband button */}
          {team.status === 'active' && (
            <button
              onClick={handleDisband}
              disabled={disbanding}
              className="px-3 py-1 text-xs text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-40 transition-colors"
            >
              {disbanding ? 'Disbanding...' : 'Disband'}
            </button>
          )}
        </div>

        {team.description && (
          <p className="text-sm text-gray-400 mt-1 truncate">{team.description}</p>
        )}

        {/* Tab bar */}
        <div className="flex gap-1 mt-3">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                activeTab === tab.id
                  ? 'bg-surface-1 text-white'
                  : 'text-gray-400 hover:text-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'graph' && <TeamGraph team={team} />}
        {activeTab === 'messages' && <TeamMessageFlow messages={messages} />}
        {activeTab === 'tasks' && <TeamTaskBoard tasks={tasks} />}
      </div>
    </div>
  );
}
