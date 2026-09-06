import React, { useCallback, useEffect, useState } from 'react';
import * as Icons from 'lucide-react';

import { useDashboardStore } from '../../stores/dashboard-store';

type Provider = 'claude' | 'codex' | 'agy';

type ResearchInboxReport =
  | {
    status: 'ok';
    relPath: string;
    filePath: string;
    artifactId: string;
    topic: string;
    created: string;
    summary: string;
    provider?: Provider;
  }
  | {
    status: 'malformed';
    relPath: string;
    filePath: string;
    reason: string;
    recovered?: {
      artifactId?: string;
      topic?: string;
      summary?: string;
      provider?: Provider;
    };
  };

type ResearchApi = {
  research?: { listInboxReports: (workspaceId: string) => Promise<ResearchInboxReport[]> };
};

function compareReports(left: ResearchInboxReport, right: ResearchInboxReport): number {
  if (left.status !== right.status) return left.status === 'ok' ? -1 : 1;
  if (left.status === 'malformed' || right.status === 'malformed') {
    return left.relPath.localeCompare(right.relPath);
  }
  const byCreated = Date.parse(right.created) - Date.parse(left.created);
  return byCreated || left.relPath.localeCompare(right.relPath);
}

function ResearchCard({
  report,
  onOpen,
}: {
  report: ResearchInboxReport;
  onOpen: (report: ResearchInboxReport) => void;
}): React.ReactElement {
  const malformed = report.status === 'malformed';
  const topic = malformed ? report.recovered?.topic ?? 'Malformed report' : report.topic;
  const summary = malformed ? report.recovered?.summary ?? 'Metadata could not be read.' : report.summary;
  const provider = (malformed ? report.recovered?.provider : report.provider) ?? 'unknown';
  return (
    <article
      className={`flex min-h-56 w-72 shrink-0 flex-col rounded-lg border p-4 ${
        malformed ? 'border-accent-orange/40 bg-accent-orange/[0.04]' : 'border-white/10 bg-surface-0'
      }`}
      data-testid={malformed ? 'research-card-malformed' : 'research-card'}
    >
      <h3 className="line-clamp-2 text-[14px] font-semibold leading-5 text-gray-100">{topic}</h3>
      <p className="mt-2 line-clamp-4 text-[12px] leading-5 text-gray-400">{summary}</p>
      <span className="mt-3 text-[10px] uppercase tracking-wide text-gray-500">Provider</span>
      <span className="text-[12px] text-gray-300" data-testid="research-provider">{provider}</span>
      {malformed && (
        <p className="mt-3 text-[11px] leading-4 text-accent-orange" data-testid="research-malformed-reason">
          {report.reason}
        </p>
      )}
      <button
        type="button"
        className="ui-btn mt-auto flex items-center justify-center gap-1 px-2 py-1.5 text-[11px]"
        onClick={() => onOpen(report)}
        data-testid="research-open-raw"
        title={`Open ${report.relPath} in Files`}
      >
        <Icons.ExternalLink className="h-3.5 w-3.5" />
        Open raw file
      </button>
    </article>
  );
}

export default function ResearchCardGallery(): React.ReactElement {
  const selectedWorkspaceId = useDashboardStore((state) => state.selectedWorkspaceId);
  const workspace = useDashboardStore((state) =>
    state.workspaces.find((candidate) => candidate.id === selectedWorkspaceId),
  );
  const openTab = useDashboardStore((state) => state.openTab);
  const showFileViewer = useDashboardStore((state) => state.showFileViewer);
  const openToolTab = useDashboardStore((state) => state.openToolTab);
  const [reports, setReports] = useState<ResearchInboxReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    if (!workspace) {
      setReports([]);
      return;
    }
    setReports(null);
    try {
      const api = window.api as typeof window.api & ResearchApi;
      if (!api.research) throw new Error('research bridge unavailable');
      const loadedReports = await api.research.listInboxReports(workspace.id);
      setReports([...loadedReports].sort(compareReports));
    } catch {
      setReports([]);
      setError('Could not load Library research reports from this workspace.');
    }
  }, [workspace]);

  useEffect(() => { void load(); }, [load]);

  const openRaw = useCallback((report: ResearchInboxReport) => {
    if (!workspace) return;
    openTab(report.filePath, workspace.path, workspace.pathType, undefined, workspace.id);
    showFileViewer();
  }, [openTab, showFileViewer, workspace]);

  return (
    <section
      className="flex min-h-0 flex-1 flex-col rounded-lg border border-white/10 bg-surface-1"
      aria-labelledby="plans-research-title"
      data-testid="plans-research-region"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-4">
        <Icons.BookOpenText className="h-4 w-4 text-accent-blue" />
        <h2 id="plans-research-title" className="text-[13px] font-semibold text-gray-200">Library research</h2>
        <button
          type="button"
          onClick={() => openToolTab('library', 'Library', { params: { type: 'research' } })}
          className="rounded px-2 py-1 text-[11px] text-accent-blue hover:bg-white/10"
        >
          Open Library
        </button>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto rounded px-2 py-1 text-[11px] text-gray-400 hover:bg-white/10 hover:text-gray-100"
        >
          Refresh
        </button>
      </div>
      {error ? (
        <div className="flex min-h-24 flex-1 items-center justify-center p-6 text-[12px] text-accent-red">{error}</div>
      ) : reports === null ? (
        <div className="flex min-h-24 flex-1 items-center justify-center p-6 text-[12px] text-gray-500">Loading research…</div>
      ) : reports.length === 0 ? (
        <div className="flex min-h-24 flex-1 items-center justify-center p-6 text-[12px] text-gray-500">
          {workspace ? 'No Library research reports yet.' : 'Select a workspace to view Library research.'}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto overflow-y-hidden p-4 scrollbar-thin" data-testid="research-card-row">
          {reports.map((report) => <ResearchCard key={report.relPath} report={report} onOpen={openRaw} />)}
        </div>
      )}
    </section>
  );
}
