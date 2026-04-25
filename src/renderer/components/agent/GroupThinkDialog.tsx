import React, { useState } from 'react';
import type { Agent } from '../../../shared/types';
import { PROVIDER_META, GROUPTHINK_MAX_ROUNDS_LIMIT, GROUPTHINK_DEFAULT_MAX_ROUNDS } from '../../../shared/constants';
import { useDashboardStore } from '../../stores/dashboard-store';

interface Props {
  workspaceId: string;
  agents: Agent[];
  preSelectedAgentId?: string;
  onClose: () => void;
}

export default function GroupThinkDialog({ workspaceId, agents, preSelectedAgentId, onClose }: Props) {
  const { startGroupThink } = useDashboardStore();
  const [topic, setTopic] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    preSelectedAgentId ? new Set([preSelectedAgentId]) : new Set()
  );
  const [maxRounds, setMaxRounds] = useState(GROUPTHINK_DEFAULT_MAX_ROUNDS);
  const [starting, setStarting] = useState(false);

  const eligibleAgents = agents.filter(
    (a) => !a.isSupervisor && !['done', 'crashed'].includes(a.status)
  );

  const toggleAgent = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || selectedIds.size < 2) return;

    setStarting(true);
    try {
      await startGroupThink(workspaceId, topic.trim(), Array.from(selectedIds), maxRounds);
      onClose();
    } catch (err) {
      console.error('Failed to start group think:', err);
      setStarting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="panel-shell w-[480px] max-h-[90vh] overflow-y-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[13px] font-semibold mb-3">Start Group Think</h2>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Topic / Question</label>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What should the agents deliberate on?"
              className="ui-textarea text-[13px] resize-none h-24"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">
              Enroll Agents <span className="text-gray-600">({selectedIds.size} selected, min 2)</span>
            </label>
            <div className="space-y-0.5 max-h-48 overflow-y-auto">
              {eligibleAgents.length === 0 ? (
                <p className="text-gray-500 text-[13px] py-2">No active agents in this workspace.</p>
              ) : (
                eligibleAgents.map((agent) => {
                  const meta = PROVIDER_META[agent.provider];
                  const selected = selectedIds.has(agent.id);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => toggleAgent(agent.id)}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors border ${
                        selected
                          ? 'bg-accent-purple/10 border-accent-purple/30 text-gray-200'
                          : 'border-transparent text-gray-400 hover:bg-white/[0.04]'
                      }`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full ${selected ? 'bg-accent-purple' : 'bg-gray-600'}`}
                      />
                      <span className="flex-1 truncate">{agent.title}</span>
                      <span
                        className="text-[11px] px-1.5 py-0.5"
                        style={{ backgroundColor: meta.color + '22', color: meta.color }}
                      >
                        {meta.label}
                      </span>
                      <span className="text-[11px] text-gray-600 font-mono">#{agent.id.slice(0, 6)}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Max Rounds</label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={GROUPTHINK_MAX_ROUNDS_LIMIT}
                value={maxRounds}
                onChange={(e) => setMaxRounds(parseInt(e.target.value, 10))}
                className="flex-1 accent-purple-500"
              />
              <span className="text-gray-300 text-[13px] font-mono w-6 text-center">{maxRounds}</span>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="ui-btn ui-btn-ghost px-3 py-1.5 text-[13px]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!topic.trim() || selectedIds.size < 2 || starting}
              className="ui-btn ui-btn-primary px-3 py-1.5 text-[13px]"
            >
              {starting ? 'Starting...' : 'Start Group Think'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
