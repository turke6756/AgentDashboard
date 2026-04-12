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
        className="bg-surface-2 border border-gray-700 rounded-xl p-6 w-[520px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-white mb-4">Start Group Think</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Topic */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Topic / Question</label>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What should the agents deliberate on?"
              className="w-full bg-surface-1 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm resize-none h-24 focus:outline-none focus:border-purple-500"
              autoFocus
            />
          </div>

          {/* Agent Selection */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Enroll Agents <span className="text-gray-500">({selectedIds.size} selected, min 2)</span>
            </label>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {eligibleAgents.length === 0 ? (
                <p className="text-gray-500 text-sm py-2">No active agents in this workspace.</p>
              ) : (
                eligibleAgents.map((agent) => {
                  const meta = PROVIDER_META[agent.provider];
                  const selected = selectedIds.has(agent.id);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => toggleAgent(agent.id)}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm transition-colors ${
                        selected
                          ? 'bg-purple-500/20 border border-purple-500/50 text-white'
                          : 'bg-surface-1 border border-gray-700 text-gray-300 hover:border-gray-500'
                      }`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full ${selected ? 'bg-purple-400' : 'bg-gray-600'}`}
                      />
                      <span className="flex-1 truncate">{agent.title}</span>
                      <span
                        className="text-xs px-1.5 py-0.5 rounded"
                        style={{ backgroundColor: meta.color + '33', color: meta.color }}
                      >
                        {meta.label}
                      </span>
                      <span className="text-xs text-gray-500">#{agent.id.slice(0, 6)}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Max Rounds */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Max Rounds</label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={GROUPTHINK_MAX_ROUNDS_LIMIT}
                value={maxRounds}
                onChange={(e) => setMaxRounds(parseInt(e.target.value, 10))}
                className="flex-1 accent-purple-500"
              />
              <span className="text-white text-sm font-mono w-6 text-center">{maxRounds}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!topic.trim() || selectedIds.size < 2 || starting}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
            >
              {starting ? 'Starting...' : 'Start Group Think'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
