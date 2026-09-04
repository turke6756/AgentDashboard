import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../../shared/session-events';
import { mergeChatEvents } from './chat-event-merge';

function system(uuid: string, agentId = 'agent-a'): SessionEvent {
  return {
    type: 'system-init',
    uuid,
    timestamp: '2026-09-04T00:00:00.000Z',
    agentId,
    model: 'test/model',
  };
}

describe('mergeChatEvents', () => {
  it('deduplicates a force-polled batch delivered by hydration and push', () => {
    const replay = system('replay');
    const ownInit = system('own-init');

    expect(mergeChatEvents([replay, ownInit], [replay, ownInit])).toEqual([
      replay,
      ownInit,
    ]);
  });

  it('keeps snapshot history before events pushed during hydration', () => {
    const history = system('history');
    const live = system('live');

    expect(mergeChatEvents([history], [live])).toEqual([history, live]);
  });
});
