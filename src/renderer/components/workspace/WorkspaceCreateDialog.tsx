import React, { useState } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { PathType } from '../../../shared/types';

export default function WorkspaceCreateDialog({ onClose }: { onClose: () => void }) {
  const { loadWorkspaces, selectWorkspace } = useDashboardStore();
  const [title, setTitle] = useState('');
  const [dirPath, setDirPath] = useState('');
  const [pathType, setPathType] = useState<PathType>('windows');
  const [description, setDescription] = useState('');

  const handlePickDir = async () => {
    const dir = await window.api.system.pickDirectory();
    if (dir) {
      setDirPath(dir);
      // Auto-detect path type
      if (dir.startsWith('/')) {
        setPathType('wsl');
      } else {
        setPathType('windows');
      }
      // Auto-fill title from directory name
      if (!title) {
        const name = dir.split(/[/\\]/).filter(Boolean).pop() || '';
        setTitle(name);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !dirPath.trim()) return;

    const ws = await window.api.workspaces.create({
      title: title.trim(),
      path: dirPath.trim(),
      pathType,
      description: description.trim() || undefined,
    });
    await loadWorkspaces();
    selectWorkspace(ws.id);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-2 border border-gray-700 rounded-xl p-6 w-[440px]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold mb-4">New Workspace</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Directory</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={dirPath}
                onChange={(e) => setDirPath(e.target.value)}
                className="flex-1 bg-surface-0 border border-gray-700 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent-blue"
                placeholder="C:\Projects\myapp or /home/user/project"
              />
              <button
                type="button"
                onClick={handlePickDir}
                className="px-3 py-2 text-sm bg-surface-3 hover:bg-gray-600 rounded-md"
              >
                Browse
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Path Type</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPathType('windows')}
                className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                  pathType === 'windows'
                    ? 'bg-blue-500/30 text-blue-300 border border-blue-500/50'
                    : 'bg-surface-0 text-gray-500 border border-gray-700'
                }`}
              >
                Windows
              </button>
              <button
                type="button"
                onClick={() => setPathType('wsl')}
                className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                  pathType === 'wsl'
                    ? 'bg-orange-500/30 text-orange-300 border border-orange-500/50'
                    : 'bg-surface-0 text-gray-500 border border-gray-700'
                }`}
              >
                WSL
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Title *</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-surface-0 border border-gray-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent-blue"
              placeholder="My Project"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-surface-0 border border-gray-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent-blue"
              placeholder="Optional description"
            />
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
              disabled={!title.trim() || !dirPath.trim()}
              className="px-4 py-2 text-sm bg-accent-blue hover:bg-accent-blue/80 text-white rounded-md font-medium disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
