import React, { useState, useEffect, useRef } from 'react';
import type { AgentProvider, Workspace } from '../../../shared/types';
import { PROVIDER_COMMANDS, PROVIDER_META } from '../../../shared/constants';
import { useDashboardStore } from '../../stores/dashboard-store';

const PROVIDERS: AgentProvider[] = ['claude', 'gemini', 'codex'];

interface Props {
  workspace: Workspace;
  onClose: () => void;
}

export default function AgentLaunchDialog({ workspace, onClose }: Props) {
  const { loadAgents } = useDashboardStore();
  const [title, setTitle] = useState('');
  const [roleDescription, setRoleDescription] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState(workspace.path);
  const [provider, setProvider] = useState<AgentProvider>('claude');
  const [command, setCommand] = useState(PROVIDER_COMMANDS.claude[workspace.pathType]);
  const [autoRestart, setAutoRestart] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [agentMd, setAgentMd] = useState<{ found: boolean; fileName: string | null } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Update command when provider changes
  useEffect(() => {
    setCommand(PROVIDER_COMMANDS[provider][workspace.pathType]);
  }, [provider, workspace.pathType]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!workingDirectory.trim()) {
        setAgentMd(null);
        return;
      }
      try {
        const result = await window.api.agents.checkAgentMd(workingDirectory.trim(), workspace.pathType);
        setAgentMd(result);
      } catch {
        setAgentMd(null);
      }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [workingDirectory, workspace.pathType]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setLaunching(true);
    try {
      await window.api.agents.launch({
        workspaceId: workspace.id,
        title: title.trim(),
        roleDescription: roleDescription.trim(),
        workingDirectory: workingDirectory.trim(),
        command: command.trim(),
        provider,
        autoRestartEnabled: autoRestart,
      });
      await loadAgents(workspace.id);
      onClose();
    } catch (err) {
      console.error('Failed to launch agent:', err);
      setLaunching(false);
    }
  };

  const handlePickDir = async () => {
    const dir = await window.api.system.pickDirectory();
    if (dir) setWorkingDirectory(dir);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-2 border border-gray-700 rounded-xl p-6 w-[480px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold mb-4">Launch Agent</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[13px] text-gray-400 mb-1">Agent Title *</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-surface-0 border border-gray-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent-blue"
              placeholder="e.g. Feature Builder"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-[13px] text-gray-400 mb-1">Role Description</label>
            <textarea
              value={roleDescription}
              onChange={(e) => setRoleDescription(e.target.value)}
              className="w-full bg-surface-0 border border-gray-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent-blue resize-none"
              rows={2}
              placeholder="What should this agent do?"
            />
          </div>

          <div>
            <label className="block text-[13px] text-gray-400 mb-1">Working Directory</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={workingDirectory}
                onChange={(e) => setWorkingDirectory(e.target.value)}
                className="flex-1 bg-surface-0 border border-gray-700 rounded-md px-3 py-2 text-sm font-sans focus:outline-none focus:border-accent-blue"
              />
              <button
                type="button"
                onClick={handlePickDir}
                className="px-3 py-2 text-sm bg-surface-3 hover:bg-gray-600 rounded-md"
              >
                Browse
              </button>
            </div>
            {agentMd && agentMd.found && (
              <div className="mt-1.5 inline-flex items-center gap-1 bg-green-500/15 text-green-400 text-[13px] px-2 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full" />
                {agentMd.fileName} found
              </div>
            )}
            {agentMd && !agentMd.found && (
              <div className="mt-1.5 text-[13px] text-gray-400">
                No agent.md
              </div>
            )}
          </div>

          {/* Provider selector */}
          <div>
            <label className="block text-[13px] text-gray-400 mb-1">Provider</label>
            <div className="flex gap-1">
              {PROVIDERS.map((p) => {
                const meta = PROVIDER_META[p];
                const isActive = provider === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setProvider(p)}
                    className={`flex-1 px-3 py-2 text-[13px] font-sans font-bold  rounded-md border transition-all
                      ${isActive
                        ? `${meta.bgClass} ${meta.textClass} border-current`
                        : 'bg-surface-0 text-gray-300 border-gray-700 hover:bg-surface-3 hover:text-gray-300'
                      }`}
                  >
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-[13px] text-gray-400 mb-1">Command</label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="w-full bg-surface-0 border border-gray-700 rounded-md px-3 py-2 text-sm font-sans focus:outline-none focus:border-accent-blue"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="autoRestart"
              checked={autoRestart}
              onChange={(e) => setAutoRestart(e.target.checked)}
              className="rounded"
            />
            <label htmlFor="autoRestart" className="text-sm text-gray-400">
              Auto-restart on crash
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm bg-surface-3 hover:bg-gray-600 rounded-md"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || launching}
              className="px-4 py-2 text-sm bg-accent-blue hover:bg-accent-blue/80 text-white rounded-md font-medium disabled:"
            >
              {launching ? 'Launching...' : 'Launch'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
