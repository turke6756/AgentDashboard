import React, { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentCard from './AgentCard';
import GroupThinkDialog from './GroupThinkDialog';
import TeamDialog from '../team/TeamDialog';

export default function AgentGrid() {
  const { agents, selectedWorkspaceId } = useDashboardStore();
  const [groupThinkAgentId, setGroupThinkAgentId] = useState<string | null>(null);
  const [teamDialogAgentId, setTeamDialogAgentId] = useState<string | null>(null);

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <div className="text-center">
          <div className="text-2xl mb-2">No agents running</div>
          <div className="text-sm">Click "Launch Agent" to start one</div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <AnimatePresence>
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onGroupThink={(agentId) => setGroupThinkAgentId(agentId)}
              onTeam={(agentId) => setTeamDialogAgentId(agentId)}
            />
          ))}
        </AnimatePresence>
      </div>
      {groupThinkAgentId && selectedWorkspaceId && (
        <GroupThinkDialog
          workspaceId={selectedWorkspaceId}
          agents={agents}
          preSelectedAgentId={groupThinkAgentId}
          onClose={() => setGroupThinkAgentId(null)}
        />
      )}
      {teamDialogAgentId && selectedWorkspaceId && (
        <TeamDialog
          workspaceId={selectedWorkspaceId}
          agents={agents}
          preSelectedAgentId={teamDialogAgentId}
          onClose={() => setTeamDialogAgentId(null)}
        />
      )}
    </>
  );
}
