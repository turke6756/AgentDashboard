import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentSchedule,
  FiringHistoryRow,
  FiringOutcome,
  ScheduleSetDto,
  StoppingRule,
} from '../../../shared/schedule-types';

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
type IntervalUnit = keyof typeof UNIT_MS;
type StopMode = StoppingRule['kind'] | '';

const ERROR_COPY: Record<string, string> = {
  'no-agent': 'This agent no longer exists.',
  'message-invalid': 'Enter a message (up to 100,000 characters).',
  'interval-out-of-range': 'Choose an interval from 1 minute through 30 days.',
  'minute-invalid': 'Choose a valid daily time.',
  'count-invalid': 'Count must be a positive whole number.',
  'end-in-past': 'The end date must be in the future.',
  'schedule-exists': 'This agent already has a schedule. Reloading it now.',
  'revision-conflict': 'This schedule changed elsewhere. The latest version has been reloaded.',
};

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error) {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate.code === 'string' && ERROR_COPY[candidate.code]) return candidate.code;
    if (typeof candidate.message === 'string') {
      return Object.keys(ERROR_COPY).find((code) => candidate.message!.includes(code)) ?? null;
    }
  }
  return null;
}

function localDateTime(epochMs: number): string {
  const date = new Date(epochMs - new Date(epochMs).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function outcomeText(outcome: FiringOutcome): string {
  return typeof outcome === 'string' ? outcome : outcome.failed;
}

export interface ScheduleDialogProps {
  agentId: string;
  provider?: string | null;
  onClose: () => void;
}

export default function ScheduleDialog({ agentId, provider, onClose }: ScheduleDialogProps) {
  const [schedule, setSchedule] = useState<AgentSchedule | null>(null);
  const [history, setHistory] = useState<FiringHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recurrenceMode, setRecurrenceMode] = useState<'interval' | 'daily'>('interval');
  const [intervalValue, setIntervalValue] = useState('1');
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('hours');
  const [dailyTime, setDailyTime] = useState('09:00');
  const [message, setMessage] = useState('');
  const [stopMode, setStopMode] = useState<StopMode>('');
  const [count, setCount] = useState('1');
  const [until, setUntil] = useState('');
  const [enabled, setEnabled] = useState(true);

  const fill = useCallback((loaded: AgentSchedule | null) => {
    setSchedule(loaded);
    if (!loaded) {
      setRecurrenceMode('interval');
      setIntervalValue('1');
      setIntervalUnit('hours');
      setDailyTime('09:00');
      setMessage('');
      setStopMode('');
      setCount('1');
      setUntil('');
      setEnabled(true);
      return;
    }
    setMessage(loaded.message);
    setEnabled(loaded.enabled);
    setStopMode(loaded.stopping.kind);
    if (loaded.stopping.kind === 'count') setCount(String(loaded.stopping.remaining));
    if (loaded.stopping.kind === 'until') setUntil(localDateTime(loaded.stopping.endAtEpochMs));
    if (loaded.recurrence.kind === 'daily') {
      setRecurrenceMode('daily');
      const hour = Math.floor(loaded.recurrence.atMinuteOfDay / 60);
      const minute = loaded.recurrence.atMinuteOfDay % 60;
      setDailyTime(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    } else {
      setRecurrenceMode('interval');
      const everyMs = loaded.recurrence.everyMs;
      const unit: IntervalUnit = everyMs % UNIT_MS.days === 0
        ? 'days'
        : everyMs % UNIT_MS.hours === 0 ? 'hours' : 'minutes';
      setIntervalUnit(unit);
      setIntervalValue(String(everyMs / UNIT_MS[unit]));
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    const [loaded, rows] = await Promise.all([
      window.api.schedule.get(agentId),
      window.api.schedule.history(agentId),
    ]);
    fill(loaded);
    setHistory(rows);
    setLoading(false);
  }, [agentId, fill]);

  useEffect(() => { void reload().catch((cause) => {
    setError(ERROR_COPY[errorCode(cause) ?? ''] ?? 'Could not load this schedule.');
    setLoading(false);
  }); }, [reload]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!message.trim()) { setError(ERROR_COPY['message-invalid']); return; }
    if (!stopMode) { setError('Choose when this schedule should stop.'); return; }

    const dto: ScheduleSetDto = {
      message,
      recurrence: recurrenceMode === 'interval'
        ? { kind: 'interval', everyMs: Number(intervalValue) * UNIT_MS[intervalUnit] }
        : { kind: 'daily', atMinuteOfDay: Number(dailyTime.slice(0, 2)) * 60 + Number(dailyTime.slice(3, 5)) },
      stopping: stopMode === 'count'
        ? { kind: 'count', remaining: Number(count) }
        : stopMode === 'until'
          ? { kind: 'until', endAtEpochMs: new Date(until).getTime() }
          : { kind: 'manual' },
      enabled,
      revision: schedule?.revision ?? null,
    };
    setSaving(true);
    try {
      const saved = await window.api.schedule.set(agentId, dto);
      fill(saved);
      setHistory(await window.api.schedule.history(agentId));
    } catch (cause) {
      const code = errorCode(cause);
      setError(ERROR_COPY[code ?? ''] ?? 'Could not save this schedule.');
      if (code === 'revision-conflict' || code === 'schedule-exists') await reload();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this schedule?')) return;
    setError(null);
    try {
      await window.api.schedule.clear(agentId);
      onClose();
    } catch (cause) {
      setError(ERROR_COPY[errorCode(cause) ?? ''] ?? 'Could not delete this schedule.');
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4" onMouseDown={(e) => e.stopPropagation()}>
      <section role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title" className="panel-shell w-full max-w-lg max-h-[90vh] overflow-y-auto p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 id="schedule-dialog-title" className="text-base font-semibold">{schedule ? 'Edit schedule' : 'Schedule agent'}</h2>
          <button type="button" className="ui-btn ui-btn-ghost" aria-label="Close schedule" onClick={onClose}>×</button>
        </div>
        {['grok', 'agy', 'gemini'].includes(provider ?? '') && (
          <div role="status" className="mb-3 border border-accent-orange/40 bg-accent-orange/10 p-2 text-sm text-accent-orange">
            This provider can't be revived; firings while the agent is shut down will fail.
          </div>
        )}
        <p className="mb-4 text-xs text-gray-400">Schedules stop when you quit Lares.</p>
        {loading ? <p>Loading schedule…</p> : (
          <form onSubmit={submit} className="space-y-4">
            <fieldset>
              <legend className="text-sm font-semibold mb-1">Recurrence</legend>
              <label className="mr-4"><input type="radio" name="recurrence" checked={recurrenceMode === 'interval'} onChange={() => setRecurrenceMode('interval')} /> Interval</label>
              <label><input type="radio" name="recurrence" checked={recurrenceMode === 'daily'} onChange={() => setRecurrenceMode('daily')} /> Daily</label>
              {recurrenceMode === 'interval' ? (
                <div className="flex gap-2 mt-2">
                  <label className="sr-only" htmlFor="schedule-interval">Interval amount</label>
                  <input id="schedule-interval" className="ui-input flex-1" type="number" min="1" step="any" value={intervalValue} onChange={(e) => setIntervalValue(e.target.value)} />
                  <label className="sr-only" htmlFor="schedule-unit">Interval unit</label>
                  <select id="schedule-unit" className="ui-select" value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}>
                    <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option>
                  </select>
                </div>
              ) : (
                <label className="block mt-2">Time of day <input className="ui-input ml-2" type="time" required value={dailyTime} onChange={(e) => setDailyTime(e.target.value)} /></label>
              )}
            </fieldset>
            <label className="block text-sm font-semibold">Message
              <textarea className="ui-textarea mt-1 w-full min-h-24" required maxLength={100_000} value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <fieldset>
              <legend className="text-sm font-semibold mb-1">Stop</legend>
              <label className="block"><input type="radio" name="stopping" checked={stopMode === 'count'} onChange={() => setStopMode('count')} /> After count</label>
              {stopMode === 'count' && <label className="block ml-5">Occurrences <input className="ui-input ml-2 w-24" type="number" min="1" step="1" value={count} onChange={(e) => setCount(e.target.value)} /></label>}
              <label className="block"><input type="radio" name="stopping" checked={stopMode === 'until'} onChange={() => setStopMode('until')} /> Until</label>
              {stopMode === 'until' && <label className="block ml-5">End date <input className="ui-input ml-2" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} /></label>}
              <label className="block"><input type="radio" name="stopping" checked={stopMode === 'manual'} onChange={() => setStopMode('manual')} /> Manually</label>
            </fieldset>
            <label className="block"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
            {error && <div role="alert" className="text-sm text-accent-red">{error}</div>}
            <div className="flex gap-2">
              <button type="submit" className="ui-btn ui-btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save schedule'}</button>
              {schedule && <button type="button" className="ui-btn ui-btn-danger" onClick={remove}>Delete</button>}
              <button type="button" className="ui-btn ui-btn-ghost" onClick={onClose}>Cancel</button>
            </div>
          </form>
        )}
        <section className="mt-5" aria-labelledby="schedule-history-title">
          <h3 id="schedule-history-title" className="text-sm font-semibold">Recent history</h3>
          {history.length === 0 ? <p className="text-xs text-gray-500 mt-1">No firings yet.</p> : (
            <ul className="mt-1 space-y-1 text-xs">
              {history.map((row) => <li key={row.occurrenceSeq}>{outcomeText(row.outcome)} · due {new Date(row.dueAt).toLocaleString()} · fired {row.firedAt ? new Date(row.firedAt).toLocaleString() : '—'}</li>)}
            </ul>
          )}
        </section>
      </section>
    </div>,
    document.body,
  );
}
