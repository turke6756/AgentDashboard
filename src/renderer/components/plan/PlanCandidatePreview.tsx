import React, { useEffect, useMemo, useState } from 'react';
import type { PlanCandidatePreviewResponse } from '../../../shared/types';

export interface PlanCandidatePreviewSelection {
  selectedComponentIds: string[];
  selectedUnattributedEntryIds: string[];
  finalizationIds: string[];
}

export interface PlanCandidatePreviewProps {
  workspaceId: string;
  planId: string;
  selection: PlanCandidatePreviewSelection;
  title?: string;
  onClose?: () => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; response: PlanCandidatePreviewResponse };

const VERDICT_LABEL = {
  'verified-match': 'Verified',
  'verified-mismatch': 'Changed since review',
  'package-not-finalized': 'Not finalized',
  'final-checkpoint-unavailable': 'Checkpoint unavailable',
  'unsupported-entry': 'Unsupported',
} as const;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error ? error : 'Plan candidate preview unavailable.';
}

export default function PlanCandidatePreview({
  workspaceId,
  planId,
  selection,
  title,
  onClose,
}: PlanCandidatePreviewProps): React.ReactElement {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const request = useMemo(() => ({
    workspaceId,
    planId,
    selectedComponentIds: selection.selectedComponentIds,
    selectedUnattributedEntryIds: selection.selectedUnattributedEntryIds,
    finalizationIds: selection.finalizationIds,
  }), [
    workspaceId,
    planId,
    selection.selectedComponentIds,
    selection.selectedUnattributedEntryIds,
    selection.finalizationIds,
  ]);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    void window.api.plans.previewCandidate(request)
      .then((response) => {
        if (active) setState({ status: 'ready', response });
      })
      .catch((error: unknown) => {
        if (active) setState({ status: 'error', message: errorMessage(error) });
      });
    return () => { active = false; };
  }, [request]);

  if (state.status === 'loading') {
    return <div data-testid="candidate-preview-loading">Loading plan candidate preview…</div>;
  }

  if (state.status === 'error') {
    return (
      <div data-testid="candidate-preview-error">
        <p>{state.message}</p>
        {onClose && <button type="button" className="ui-btn ui-btn-outline" onClick={onClose}>Close</button>}
      </div>
    );
  }

  const { candidate, isCandidate } = state.response;
  return (
    <section className="mission-board__candidate-preview" data-testid="candidate-preview">
      {title && <h3>{title}</h3>}
      <p data-testid="candidate-preview-verdict">
        {isCandidate ? 'Finalized candidate preview.' : 'Selection preview; no finalized candidate yet.'}
      </p>
      <ul className="mission-board__file-list" data-testid="candidate-preview-members">
        {candidate.members.map((member) => (
          <li
            key={member.entryId}
            data-testid="candidate-member"
            data-verdict={member.packageVerification}
          >
            <span>{VERDICT_LABEL[member.packageVerification]}</span>{' '}
            <span>{member.path.displayPath}</span>
          </li>
        ))}
      </ul>
      {onClose && <button type="button" className="ui-btn ui-btn-outline" onClick={onClose}>Close</button>}
    </section>
  );
}
