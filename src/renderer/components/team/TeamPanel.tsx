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
      <div className="px-4 py-3 border-b border-surface-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[team.status] ?? 'bg-gray-500'}`} />
            <h2 className="text-gray-100 font-semibold text-[13px] truncate">{team.name}</h2>
            {team.template && (
              <span className={`text-[11px] px-1.5 py-0.5 ${templateStyle.bg} ${templateStyle.text}`}>
                {team.template}
              </span>
            )}
            <span className="text-[11px] text-gray-500">{memberCount} member{memberCount !== 1 ? 's' : ''}</span>
          </div>

          {team.status === 'active' && (
            <button
              onClick={handleDisband}
              disabled={disbanding}
              className="ui-btn ui-btn-danger text-[11px]"
            >
              {disbanding ? 'Disbanding...' : 'Disband'}
            </button>
          )}
        </div>

        {team.description && (
          <p className="text-[13px] text-gray-400 mt-1 truncate">{team.description}</p>
        )}

        {/* Tab bar */}
        <div className="flex mt-2 border-b border-surface-3">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`ui-tab ${activeTab === tab.id ? 'ui-tab-active' : ''}`}
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
