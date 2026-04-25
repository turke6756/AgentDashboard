import React from 'react';
import type { Team } from '../../../shared/types';

interface Props {
  teams: Team[];
  selectedTeamId: string | null;
  onSelectTeam: (id: string) => void;
  onNewTeam: () => void;
}

const STATUS_DOT: Record<string, string> = {
  active: 'bg-green-400',
  paused: 'bg-yellow-400',
  disbanded: 'bg-gray-500',
};

const TEMPLATE_COLORS: Record<string, { bg: string; text: string }> = {
  groupthink: { bg: 'bg-purple-500/20', text: 'text-purple-400' },
  pipeline:   { bg: 'bg-blue-500/20',   text: 'text-blue-400' },
  custom:     { bg: 'bg-gray-500/20',   text: 'text-gray-400' },
};

export default function TeamList({ teams, selectedTeamId, onSelectTeam, onNewTeam }: Props) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-3">
        <span className="ui-section-header">Teams</span>
        <button
          onClick={onNewTeam}
          className="ui-btn ui-btn-purple text-[11px]"
        >
          + New Team
        </button>
      </div>

      {teams.length === 0 ? (
        <p className="text-gray-600 text-[13px] px-3 py-2">No teams yet.</p>
      ) : (
        <div className="space-y-0">
          {teams.map((team) => {
            const selected = team.id === selectedTeamId;
            const memberCount = team.members?.length ?? 0;
            const templateStyle = TEMPLATE_COLORS[team.template ?? 'custom'] ?? TEMPLATE_COLORS.custom;

            return (
              <button
                key={team.id}
                onClick={() => onSelectTeam(team.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors border-l-2 ${
                  selected
                    ? 'border-l-accent-blue bg-accent-blue/10 text-gray-200'
                    : 'border-l-transparent text-gray-400 hover:bg-white/[0.04]'
                }`}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[team.status] ?? 'bg-gray-500'}`} />
                <span className="flex-1 truncate">{team.name}</span>
                {team.template && (
                  <span className={`text-[11px] px-1.5 py-0.5 ${templateStyle.bg} ${templateStyle.text}`}>
                    {team.template}
                  </span>
                )}
                <span className="text-[11px] text-gray-600">{memberCount}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
