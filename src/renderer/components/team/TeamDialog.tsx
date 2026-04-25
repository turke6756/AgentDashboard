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
        className="panel-shell w-[520px] max-h-[90vh] overflow-y-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[13px] font-semibold mb-3">Create Team</h2>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Team Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Backend Refactor Squad"
              className="ui-input text-[13px]"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this team working on?"
              className="ui-textarea text-[13px] resize-none h-16"
            />
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Template</label>
            <div className="flex gap-1">
              {templateOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setTemplate(opt.value)}
                  className={`ui-btn flex-1 flex-col items-start py-2 text-[13px] ${
                    template === opt.value
                      ? 'bg-accent-purple/15 text-accent-purple border-accent-purple/40'
                      : ''
                  }`}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div className="text-[11px] text-gray-500 mt-0.5">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">
              Members <span className="text-gray-600">({selectedIds.size} selected, min 2)</span>
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

          {template === 'custom' && selectedAgents.length >= 2 && (
            <div>
              <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">
                Channels <span className="text-gray-600">({customChannels.size} selected)</span>
              </label>
              <div className="space-y-0.5 max-h-40 overflow-y-auto">
                {possiblePairs.map(({ from, to, key }) => {
                  const selected = customChannels.has(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleChannel(key)}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors border ${
                        selected
                          ? 'bg-accent-blue/10 border-accent-blue/30 text-gray-200'
                          : 'border-transparent text-gray-400 hover:bg-white/[0.04]'
                      }`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full ${selected ? 'bg-accent-blue' : 'bg-gray-600'}`}
                      />
                      <span className="truncate">
                        {from.title}
                        <span className="text-gray-600 mx-1">{'\u2192'}</span>
                        {to.title}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

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
              disabled={!canSubmit}
              className="ui-btn ui-btn-primary px-3 py-1.5 text-[13px]"
            >
              {submitting ? 'Creating...' : 'Create Team'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
