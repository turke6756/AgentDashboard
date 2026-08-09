// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PlanCommentThread,
  PlanDocumentsModel,
  PlanDocumentRef,
  SelectionComment,
} from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import PlanDocumentTabs from './PlanDocumentTabs';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const LOGICAL_PLAN_KEY = 'lares-plan-doc:v1:eyJkb2NfcmVsX3BhdGhfd2l0aGluX2ZvbGRlciI6InBsYW4ubWQiLCJwbGFuX2FydGlmYWN0X2lkIjoicGxhbl8zN2NmNTI2MSJ9';
const DELIBERATION_KEY = 'lares-plan-doc:v1:eyJkb2NfcmVsX3BhdGhfd2l0aGluX2ZvbGRlciI6ImRlbGliZXJhdGlvbnMvcmlzay5tZCIsInBsYW5fYXJ0aWZhY3RfaWQiOiJwbGFuXzM3Y2Y1MjYxIn0';

function row(id: string, filePath: string, quotedText: string, body: string): SelectionComment {
  return {
    id, workspaceId: 'ws-1', targetType: 'file', kind: 'comment', filePath,
    pathType: null, rootDirectory: null, docHash: 'hash', anchorType: 'text', pdfAnchor: null,
    anchorStart: 0, anchorEnd: quotedText.length, lineStart: 1, lineEnd: 1,
    prefix: null, suffix: null, quotedText, body, status: 'draft', sentToAgentId: null,
    createdAt: '2026-08-09T00:00:00Z', updatedAt: '2026-08-09T00:00:00Z',
    sentAt: null, resolvedAt: null,
  };
}

const model: PlanDocumentsModel = {
  planId: 'plan-1', warnings: [], tabs: [
    { key: 'overview', populated: false, documents: [] },
    { key: 'plan', populated: true, documents: [
      { ref: { source: 'folder', documentId: 'd-plan' }, name: 'plan.md', kind: 'plan', sizeBytes: 20, mtimeMs: 1 },
    ] },
    { key: 'deliberations', populated: true, documents: [
      { ref: { source: 'folder', documentId: 'd-risk' }, name: 'risk.md', kind: 'deliberation', sizeBytes: 20, mtimeMs: 1 },
    ] },
  ],
};

describe('PlanDocumentTabs inline plan comments (WP-8)', () => {
  let host: HTMLDivElement;
  let root: Root;
  let threads: PlanCommentThread[];
  const createComment = vi.fn();
  const replyComment = vi.fn();
  const resolve = vi.fn();

  beforeEach(async () => {
    threads = [{
      comment: row('existing-plan', LOGICAL_PLAN_KEY, 'plan body', 'Existing encoded-key comment'),
      replies: [],
      target: { kind: 'folder-doc', documentId: 'd-plan', tab: 'plan', docRelPath: 'plan.md', name: 'plan.md' },
    }];
    createComment.mockImplementation(async (req: { ref: PlanDocumentRef; body: string; quotedText?: string }) => {
      const isPlan = req.ref.documentId === 'd-plan';
      const comment = row(`created-${req.ref.documentId}`, isPlan ? LOGICAL_PLAN_KEY : DELIBERATION_KEY, req.quotedText ?? '', req.body);
      threads.push({
        comment, replies: [],
        target: { kind: 'folder-doc', documentId: req.ref.documentId, tab: isPlan ? 'plan' : 'deliberations', docRelPath: isPlan ? 'plan.md' : 'deliberations/risk.md', name: isPlan ? 'plan.md' : 'risk.md' },
      });
      return { ok: true as const, comment, recipientId: 'sup-1', send: null };
    });
    replyComment.mockImplementation(async (req: { commentId: string; body: string; callerAgentId: string }) => {
      const thread = threads.find((item) => item.comment.id === req.commentId)!;
      thread.replies.push({ id: `reply-${req.commentId}`, commentId: req.commentId, body: req.body, authorAgentId: req.callerAgentId, createdAt: 1 });
      return { ok: true as const, reply: thread.replies[0] };
    });
    resolve.mockImplementation(async (id: string) => {
      const comment = threads.find((item) => item.comment.id === id)!.comment;
      comment.status = 'resolved';
      return comment;
    });
    (window as unknown as { api: unknown }).api = {
      plans: {
        documents: vi.fn(async () => model),
        readDocument: vi.fn(async (_planId: string, ref: PlanDocumentRef) => ({
          ref, name: ref.documentId === 'd-plan' ? 'plan.md' : 'risk.md',
          content: ref.documentId === 'd-plan' ? '# Plan\n\nplan body' : '# Risk\n\nrisk body',
          truncated: false, sizeBytes: 20,
        })),
        getOverview: vi.fn(async () => null),
        listIntents: vi.fn(async () => null),
        listComments: vi.fn(async () => ({ planId: 'plan-1', threads: threads.map((thread) => ({ ...thread, replies: [...thread.replies] })), warnings: [] })),
        createComment,
        replyComment,
      },
      comments: {
        list: vi.fn(async () => []), update: vi.fn(async () => null), delete: vi.fn(async () => undefined),
        resolve, send: vi.fn(async () => ({ ok: true, agentId: 'sup-1', launched: false })),
        onChanged: vi.fn(() => () => {}),
      },
    };
    useDashboardStore.setState({
      selectedWorkspaceId: 'ws-1',
      agents: [{ id: 'sup-1', workspaceId: 'ws-1', title: 'Supervisor', isSupervisor: true } as never],
    } as never);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(<PlanDocumentTabs planId="plan-1" />); });
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.getSelection()?.removeAllRanges();
    document.getElementById('selection-toast-container')?.remove();
    vi.clearAllMocks();
  });

  async function flush(): Promise<void> {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  }

  const button = (label: string) => Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes(label)) as HTMLButtonElement;

  function type(textarea: HTMLTextAreaElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => { setter.call(textarea, value); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
  }

  async function createAnchoredComment(quote: string, body: string): Promise<void> {
    const textNode = Array.from(document.querySelectorAll('p')).find((item) => item.textContent?.includes(quote))!.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    act(() => (textNode.parentElement as HTMLElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    act(() => button('Add comment').click());
    type(document.querySelector('textarea')!, body);
    await act(async () => button('Save comment').click());
    await flush();
  }

  async function replyAndResolve(commentId: string): Promise<void> {
    await act(async () => (document.querySelector(`[data-testid="comment-marker-${commentId}"]`) as HTMLButtonElement).click());
    act(() => (document.querySelector('[data-testid="plan-comment-reply-open"]') as HTMLButtonElement).click());
    type(document.querySelector('[data-testid="plan-comment-reply-textarea"]') as HTMLTextAreaElement, 'Supervisor answer');
    await act(async () => (document.querySelector('[data-testid="plan-comment-reply-submit"]') as HTMLButtonElement).click());
    await flush();
    expect(replyComment).toHaveBeenLastCalledWith({ commentId, body: 'Supervisor answer', callerAgentId: 'sup-1' });
    expect(document.body.textContent).toContain('Supervisor answer');
    await act(async () => button('Resolve').click());
    await flush();
    expect(resolve).toHaveBeenCalledWith(commentId);
    expect(document.querySelector(`[data-testid="comment-marker-${commentId}"]`)).toBeNull();
  }

  it('REACHABILITY:wp8-inline-comments creates, reopens, replies, and resolves on plan.md and a deliberation', async () => {
    act(() => button('Plan').click());
    await flush();
    expect(document.querySelector('[data-testid="plan-comments-rail"]')).toBeNull();
    expect(document.querySelector('[data-testid="comment-marker-existing-plan"]')).not.toBeNull();

    await createAnchoredComment('plan body', 'Plan feedback');
    expect(createComment).toHaveBeenLastCalledWith(expect.objectContaining({
      planId: 'plan-1', ref: { source: 'folder', documentId: 'd-plan' },
      quotedText: 'plan body', body: 'Plan feedback', anchorStart: expect.any(Number), anchorEnd: expect.any(Number),
    }));
    await replyAndResolve('created-d-plan');

    act(() => button('Deliberations').click());
    await flush();
    await createAnchoredComment('risk body', 'Risk feedback');
    expect(createComment).toHaveBeenLastCalledWith(expect.objectContaining({
      planId: 'plan-1', ref: { source: 'folder', documentId: 'd-risk' }, quotedText: 'risk body', body: 'Risk feedback',
    }));
    await replyAndResolve('created-d-risk');
  });
});
