// @vitest-environment jsdom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentSchedule, FiringHistoryRow } from '../../../shared/schedule-types';
import ScheduleDialog from './ScheduleDialog';

let host: HTMLDivElement;
let root: Root;

function schedule(revision = 7): AgentSchedule {
  return {
    id: 'schedule-1', agentId: 'agent-1', message: 'check the dashboard',
    recurrence: { kind: 'daily', atMinuteOfDay: 8 * 60 + 30 },
    stopping: { kind: 'manual' }, enabled: true, lifecycle: 'active', revision,
    createdAtEpochMs: 1, updatedAtEpochMs: 2, nextFireAt: Date.now() + 60_000,
    lastFiredAt: null, fireCount: 0, occurrenceCount: 0, lastOutcome: null,
    lastNotificationRoute: null,
  };
}

const history: FiringHistoryRow = {
  scheduleId: 'schedule-1', occurrenceSeq: 1, dueAt: Date.UTC(2026, 8, 6, 8),
  heldAt: null, revivedAt: null, firedAt: Date.UTC(2026, 8, 6, 8, 1), collapsedCount: 0,
  liveness: 'idle', outcome: 'confirmed', notificationRoute: 'ordinary',
  cancellationRequestedAt: null, confirmationSource: 'hook', completedAt: Date.UTC(2026, 8, 6, 8, 1),
};

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('ScheduleDialog', () => {
  it('requires a deliberate stopping rule and creates interval schedules with revision null', async () => {
    const saved = { ...schedule(1), recurrence: { kind: 'interval' as const, everyMs: 172_800_000 }, stopping: { kind: 'manual' as const } };
    (window as any).api = { schedule: {
      get: vi.fn(async () => null), history: vi.fn(async () => []),
      set: vi.fn(async () => saved), clear: vi.fn(), hydrate: vi.fn(), onChanged: vi.fn(),
    } };
    await act(async () => { root.render(<ScheduleDialog agentId="agent-1" provider="grok" onClose={vi.fn()} />); });
    await flush();

    expect(document.body.textContent).toContain("This provider can't be revived; firings while the agent is shut down will fail.");
    expect(document.body.textContent).toContain('Schedules stop when you quit Lares.');
    const stopping = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[name="stopping"]'));
    expect(stopping).toHaveLength(3);
    expect(stopping.every((radio) => !radio.checked)).toBe(true);

    setValue(document.body.querySelector('textarea')!, 'run weekly review');
    setValue(document.body.querySelector<HTMLInputElement>('#schedule-interval')!, '2');
    setValue(document.body.querySelector<HTMLSelectElement>('#schedule-unit')!, 'days');
    await act(async () => { document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Choose when');

    await act(async () => { stopping[2].click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
    await flush();
    expect(window.api.schedule.set).toHaveBeenCalledWith('agent-1', {
      message: 'run weekly review', recurrence: { kind: 'interval', everyMs: 172_800_000 },
      stopping: { kind: 'manual' }, enabled: true, revision: null,
    });
  });

  it('prefills edits, shows history, reloads on revision conflict, and confirms delete', async () => {
    const original = schedule(7);
    const reloaded = { ...original, revision: 8, message: 'changed elsewhere' };
    const get = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(reloaded);
    const conflict = Object.assign(new Error('revision-conflict'), { code: 'revision-conflict' });
    const close = vi.fn();
    (window as any).api = { schedule: {
      get, history: vi.fn(async () => [history]), set: vi.fn(async () => { throw conflict; }),
      clear: vi.fn(async () => true), hydrate: vi.fn(), onChanged: vi.fn(),
    } };
    await act(async () => { root.render(<ScheduleDialog agentId="agent-1" provider="codex" onClose={close} />); });
    await flush();

    expect((document.body.querySelector('textarea') as HTMLTextAreaElement).value).toBe('check the dashboard');
    expect((document.body.querySelector('input[type="time"]') as HTMLInputElement).value).toBe('08:30');
    expect(document.body.textContent).toContain('confirmed · due');
    await act(async () => { document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
    await flush();
    expect(window.api.schedule.set).toHaveBeenCalledWith('agent-1', expect.objectContaining({ revision: 7 }));
    expect(get).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('latest version has been reloaded');
    expect((document.body.querySelector('textarea') as HTMLTextAreaElement).value).toBe('changed elsewhere');

    const deleteButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Delete')!;
    await act(async () => { deleteButton.click(); });
    expect(window.confirm).toHaveBeenCalledWith('Delete this schedule?');
    expect(window.api.schedule.clear).toHaveBeenCalledWith('agent-1');
    expect(close).toHaveBeenCalled();
  });
});
