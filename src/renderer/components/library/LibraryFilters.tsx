import React from 'react';
import { SHELF_STATUSES, type LibraryDocumentType, type LibraryTrust, type ShelfStatus } from '../../../shared/library';

export interface LibraryFilterState {
  types: LibraryDocumentType[];
  trusts: LibraryTrust[];
  dateFrom: string;
  dateTo: string;
  topic: string;
  provider: string;
  status: '' | ShelfStatus;
  title: string;
}

export const EMPTY_LIBRARY_FILTERS: LibraryFilterState = {
  types: [], trusts: [], dateFrom: '', dateTo: '', topic: '', provider: '', status: '', title: '',
};

const SHELF_STATUS_LABELS: Record<ShelfStatus, string> = {
  pending: 'Not indexed yet',
  stale: 'Needs re-index',
  indexing: 'Working',
  ready: 'Ready to search',
  error: 'Ingest failed',
};

export default function LibraryFilters({ value, onChange }: { value: LibraryFilterState; onChange: (next: LibraryFilterState) => void }) {
  const set = (patch: Partial<LibraryFilterState>) => onChange({ ...value, ...patch });
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label="Library filters">
      <select aria-label="Type" value={value.types[0] ?? ''} onChange={(event) => set({ types: event.target.value ? [event.target.value as LibraryDocumentType] : [] })} className="ui-input">
        <option value="">All types</option>{['research', 'pdf', 'docx', 'md', 'txt', 'note'].map((type) => <option key={type}>{type}</option>)}
      </select>
      <select aria-label="Trust" value={value.trusts[0] ?? ''} onChange={(event) => set({ trusts: event.target.value ? [event.target.value as LibraryTrust] : [] })} className="ui-input">
        <option value="">All trust tiers</option>{['untrusted', 'cleared', 'user-trusted'].map((trust) => <option key={trust}>{trust}</option>)}
      </select>
      <input aria-label="Date from" type="date" value={value.dateFrom} onChange={(event) => set({ dateFrom: event.target.value })} className="ui-input" />
      <input aria-label="Date to" type="date" value={value.dateTo} onChange={(event) => set({ dateTo: event.target.value })} className="ui-input" />
      <input aria-label="Topic" placeholder="Topic" value={value.topic} onChange={(event) => set({ topic: event.target.value })} className="ui-input" />
      <input aria-label="Provider" placeholder="Provider" value={value.provider} onChange={(event) => set({ provider: event.target.value })} className="ui-input" />
      <select aria-label="Processing state" value={value.status} onChange={(event) => set({ status: event.target.value as LibraryFilterState['status'] })} className="ui-input">
        <option value="">All states</option>{SHELF_STATUSES.map((status) => <option key={status} value={status}>{SHELF_STATUS_LABELS[status]}</option>)}
      </select>
      <input aria-label="Title" placeholder="Filter titles" value={value.title} onChange={(event) => set({ title: event.target.value })} className="ui-input" />
    </div>
  );
}
