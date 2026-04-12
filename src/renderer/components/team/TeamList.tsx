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
      {/* Header with New Team button */}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Teams</span>
        <button
          onClick={onNewTeam}
          className="text-xs px-2 py-1 text-purple-400 border border-purple-500/30 rounded hover:bg-purple-500/10 transition-colors"
        >
          + New Team
        </button>
      </div>

      {/* Team list */}
      {teams.length === 0 ? (
        <p className="text-gray-600 text-xs px-3 py-2">No teams yet.</p>
      ) : (
        <div className="space-y-0.5">
          {teams.map((team) => {
            const selected = team.id === selectedTeamId;
            const memberCount = team.members?.length ?? 0;
            const templateStyle = TEMPLATE_COLORS[team.template ?? 'custom'] ?? TEMPLATE_COLORS.custom;

            return (
              <button
                key={team.id}
                onClick={() => onSelectTeam(team.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? 'bg-surface-1 text-white'
                    : 'text-gray-300 hover:bg-surface-1/50'
                }`}
              >
                {/* Status dot */}
                <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[team.status] ?? 'bg-gray-500'}`} />

                {/* Name */}
                <span className="flex-1 truncate">{team.name}</span>

                {/* Template badge */}
                {team.template && (
                  <span className={`text-xs px-1.5 py-0.5 rounded ${templateStyle.bg} ${templateStyle.text}`}>
                    {team.template}
                  </span>
                )}

                {/* Member count */}
                <span className="text-xs text-gray-500">{memberCount}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
