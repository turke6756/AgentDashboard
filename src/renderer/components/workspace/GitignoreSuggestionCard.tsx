import React, { useEffect, useState } from 'react';
import * as Icons from 'lucide-react';
import type { GitignoreSuggestionNotice } from '../../../shared/types';

export default function GitignoreSuggestionCard() {
  const [notices, setNotices] = useState<GitignoreSuggestionNotice[]>([]);
  const [busyWorkspaceId, setBusyWorkspaceId] = useState<string | null>(null);
  const [errorByWorkspace, setErrorByWorkspace] = useState<Record<string, string>>({});

  useEffect(() => window.api.workspaces.onGitignoreSuggestion((notice) => {
    setNotices((current) => [
      ...current.filter((item) => item.workspaceId !== notice.workspaceId),
      notice,
    ]);
  }), []);

  const dismiss = (workspaceId: string) =>
    setNotices((current) => current.filter((item) => item.workspaceId !== workspaceId));

  const accept = async (notice: GitignoreSuggestionNotice) => {
    setBusyWorkspaceId(notice.workspaceId);
    try {
      const result = await window.api.workspaces.acceptGitignore(notice.workspaceId);
      if (result.accepted) dismiss(notice.workspaceId);
      else setErrorByWorkspace((current) => ({ ...current, [notice.workspaceId]: 'Suggestion expired; review again.' }));
    } catch (error) {
      setErrorByWorkspace((current) => ({
        ...current,
        [notice.workspaceId]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setBusyWorkspaceId(null);
    }
  };

  if (notices.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-4 z-[129] app-no-drag flex flex-col gap-2">
      {notices.map((notice) => (
        <div key={notice.workspaceId} role="status" className="w-[380px] rounded-lg border shadow-xl bg-surface-1 border-accent-blue/60 p-3">
          <div className="flex items-start gap-2.5">
            <Icons.FileCog className="w-4 h-4 mt-0.5 shrink-0 text-accent-blue" />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-gray-100">Keep generated files out of workspace scans?</div>
              <div className="text-[11px] text-gray-300 mt-1">
                Lares suggests {notice.missingRules.length} missing .gitignore rule{notice.missingRules.length === 1 ? '' : 's'}.
              </div>
              <pre className="text-[10px] text-gray-400 mt-1 max-h-24 overflow-auto whitespace-pre-wrap">
                {notice.missingRules.join('\n')}
              </pre>
              {errorByWorkspace[notice.workspaceId] && (
                <div className="text-[10px] text-accent-red mt-1">{errorByWorkspace[notice.workspaceId]}</div>
              )}
            </div>
            <button onClick={() => dismiss(notice.workspaceId)} aria-label="Dismiss gitignore suggestion" className="text-gray-400 hover:text-gray-100">
              <Icons.X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex justify-end mt-2">
            <button
              onClick={() => void accept(notice)}
              disabled={busyWorkspaceId === notice.workspaceId}
              className="ui-btn ui-btn-primary px-2.5 py-1 text-[11px]"
            >
              {busyWorkspaceId === notice.workspaceId ? 'Adding…' : 'Add suggested rules'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
