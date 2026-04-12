import React, { useState, useMemo } from 'react';
import type { Agent, TeamTemplate, CreateTeamInput } from '../../../shared/types';
import { PROVIDER_META } from '../../../shared/constants';
import { useDashboardStore } from '../../stores/dashboard-store';

interface Props {
  workspaceId: string;
  agents: Agent[];
  preSelectedAgentId?: string;
  onClose: () => void;
}

export default function TeamDialog({ workspaceId, agents, preSelectedAgentId, onClose }: Props) {
  const { createTeam } = useDashboardStore();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<TeamTemplate>('groupthink');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    preSelectedAgentId ? new Set([preSelectedAgentId]) : new Set()
  );
  const [customChannels, setCustomChannels] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const eligibleAgents = agents.filter(
    (a) => !a.isSupervisor && !['done', 'crashed'].includes(a.status)
  );

  const selectedAgents = useMemo(
    () => eligibleAgents.filter((a) => selectedIds.has(a.id)),
    [eligibleAgents, selectedIds]
  );

  // All directed pairs among selected agents
  const possiblePairs = useMemo(() => {
    const pairs: { from: Agent; to: Agent; key: string }[] = [];
    for (const a of selectedAgents) {
      for (const b of selectedAgents) {
        if (a.id !== b.id) {
          pairs.push({ from: a, to: b, key: `${a.id}->${b.id}` });
        }
      }
    }
    return pairs;
  }, [selectedAgents]);

  const toggleAgent = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleChannel = (key: string) => {
    setCustomChannels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const canSubmit = name.trim() && selectedIds.size >= 2 && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      const members = Array.from(selectedIds).map((agentId) => ({ agentId }));

      let channels: CreateTeamInput['channels'] | undefined;
      if (template === 'custom' && customChannels.size > 0) {
        channels = Array.from(customChannels).map((key) => {
          const [from, to] = key.split('->');
          return { from, to };
        });
      }

      await createTeam({
        workspaceId,
        name: name.trim(),
        description: description.trim() || undefined,
        template,
        members,
        channels,
      });
      onClose();
    } catch (err) {
      console.error('Failed to create team:', err);
      setSubmitting(false);
    }
  };

  const templateOptions: { value: TeamTemplate; label: string; desc: string }[] = [
    { value: 'groupthink', label: 'Groupthink', desc: 'All-to-all communication' },
    { value: 'pipeline', label: 'Pipeline', desc: 'Linear chain A\u2192B\u2192C' },
    { value: 'custom', label: 'Custom', desc: 'Define channels manually' },
  ];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-2 border border-gray-700 rounded-xl p-6 w-[560px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-white mb-4">Create Team</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Team Name */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Team Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Backend Refactor Squad"
              className="w-full bg-surface-1 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this team working on?"
              className="w-full bg-surface-1 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm resize-none h-20 focus:outline-none focus:border-purple-500"
            />
          </div>

          {/* Template Selector */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Template</label>
            <div className="flex gap-2">
              {templateOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setTemplate(opt.value)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm border transition-colors ${
                    template === opt.value
                      ? 'bg-purple-500/20 border-purple-500/50 text-white'
                      : 'bg-surface-1 border-gray-700 text-gray-400 hover:border-gray-500'
                  }`}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Agent Selection */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Members <span className="text-gray-500">({selectedIds.size} selected, min 2)</span>
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

          {/* Custom Channel Editor */}
          {template === 'custom' && selectedAgents.length >= 2 && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                Channels <span className="text-gray-500">({customChannels.size} selected)</span>
              </label>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {possiblePairs.map(({ from, to, key }) => {
                  const selected = customChannels.has(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleChannel(key)}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-left text-sm transition-colors ${
                        selected
                          ? 'bg-blue-500/20 border border-blue-500/50 text-white'
                          : 'bg-surface-1 border border-gray-700 text-gray-400 hover:border-gray-500'
                      }`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full ${selected ? 'bg-blue-400' : 'bg-gray-600'}`}
                      />
                      <span className="truncate">
                        {from.title}
                        <span className="text-gray-500 mx-1">{'\u2192'}</span>
                        {to.title}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

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
              disabled={!canSubmit}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
            >
              {submitting ? 'Creating...' : 'Create Team'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
