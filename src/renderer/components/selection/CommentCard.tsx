// Shared comment card + send controls (plan §1.10).
//
// Extracted from FileCommentGutter so the markdown gutter and the new
// PdfCommentSidebar render the SAME card — status label, quote, body, the
// Send / Send-all / Resolve / Delete controls, and the agent picker — without
// forking the send UI. The card is purely PRESENTATIONAL: it owns only the
// transient picker-open state; every location decision (where the card sits,
// what the status label says) is supplied by the host positioning adapter.
//
// The send/status/event machinery is unchanged — hosts pass `onSendOne` /
// `onSendAll` that call `sendPersistedComments`, so text and PDF comments share
// one dispatch path.
import React, { useState } from 'react';
import type { SelectionComment, SelectionCommentReply } from '../../../shared/types';
import type { SelectionAgentTarget } from '../../lib/selection/selection-types';
import AgentPickerDropdown from './AgentPickerDropdown';

export interface CommentCardProps {
  comment: SelectionComment;
  workspaceId: string;
  /** Already-resolved display label (host decides orphaned vs. status). */
  statusLabel: string;
  /** Whether the Send control is offered (status is in the sendable set). */
  sendable: boolean;
  /** Number of draft comments in this surface; Send-all shows when > 1. */
  draftCount: number;
  /** Optional location line under the quote, e.g. "Page 3" for PDF cards. */
  locationLabel?: string;
  /** Left border accent on the quote block (defaults to the comment blue). */
  quoteBorderClass?: string;
  /** Positioning + sizing supplied by the host adapter. */
  style?: React.CSSProperties;
  className?: string;
  onClose: () => void;
  onSendOne: (target: SelectionAgentTarget) => void;
  onSendAll?: (target: SelectionAgentTarget) => void;
  onResolve: () => void;
  onDelete: () => void;
  onUpdate?: (body: string) => void;
  replies?: SelectionCommentReply[];
  replyAgents?: Array<{ id: string; title: string }>;
  onReply?: (body: string, callerAgentId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Overridable so the markdown gutter keeps its existing test id. */
  testId?: string;
}

export default function CommentCard({
  comment,
  workspaceId,
  statusLabel,
  sendable,
  draftCount,
  locationLabel,
  quoteBorderClass = 'border-accent-blue/50',
  style,
  className,
  onClose,
  onSendOne,
  onSendAll,
  onResolve,
  onDelete,
  onUpdate,
  replies = [],
  replyAgents = [],
  onReply,
  testId = 'comment-card',
}: CommentCardProps) {
  const [pickerFor, setPickerFor] = useState<'one' | 'all' | null>(null);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [replyAgentId, setReplyAgentId] = useState(replyAgents[0]?.id ?? '');
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const showSendAll = draftCount > 1 && !!onSendAll;

  return (
    <div
      data-testid={testId}
      className={`ui-menu pointer-events-auto absolute p-2 ${className ?? ''}`}
      style={style}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-gray-400">
          {statusLabel}
        </span>
        <button className="ui-btn text-[11px] px-1.5 py-0" onClick={onClose} title="Collapse">
          ✕
        </button>
      </div>
      <div
        className={`px-2 py-1 mb-1.5 border-l-2 ${quoteBorderClass} text-[12px] text-gray-400 italic whitespace-pre-wrap max-h-24 overflow-auto`}
      >
        {comment.quotedText}
      </div>
      {locationLabel && (
        <div className="text-[11px] text-gray-500 mb-1.5">{locationLabel}</div>
      )}
      {editing ? (
        <textarea
          value={editBody}
          onChange={(event) => setEditBody(event.target.value)}
          rows={3}
          autoFocus
          className="w-full resize-y rounded border border-white/15 bg-surface-0 px-2 py-1 text-[13px] text-gray-200 mb-2"
        />
      ) : (
        <div className="text-[13px] text-gray-200 whitespace-pre-wrap max-h-40 overflow-auto mb-2">
          {comment.body}
        </div>
      )}
      {replies.length > 0 && (
        <div className="mb-2 space-y-1 border-l border-white/10 pl-2" data-testid="plan-comment-replies">
          {replies.map((reply) => (
            <div key={reply.id} className="text-[12px] text-gray-300" data-testid="plan-comment-reply-body">
              {reply.body}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {onUpdate && (editing ? (
          <button className="ui-btn text-[12px]" disabled={!editBody.trim()} onClick={() => {
            if (!editBody.trim()) return;
            onUpdate(editBody.trim());
            setEditing(false);
          }}>Save</button>
        ) : (
          <button className="ui-btn text-[12px]" onClick={() => { setEditBody(comment.body); setEditing(true); }}>Edit</button>
        ))}
        {sendable && (
          <button
            className="ui-btn text-[12px]"
            onClick={() => setPickerFor((v) => (v === 'one' ? null : 'one'))}
          >
            Send&nbsp;▸
          </button>
        )}
        {showSendAll && (
          <button
            className="ui-btn text-[12px]"
            onClick={() => setPickerFor((v) => (v === 'all' ? null : 'all'))}
            title={`Send all ${draftCount} draft comments as one message`}
          >
            Send all ({draftCount})&nbsp;▸
          </button>
        )}
        <button
          className="ui-btn text-[12px]"
          onClick={() => {
            onClose();
            onResolve();
          }}
        >
          Resolve
        </button>
        <button
          className="ui-btn text-[12px]"
          onClick={() => {
            onClose();
            onDelete();
          }}
        >
          Delete
        </button>
        {onReply && replyAgents.length > 0 && (
          <button
            className="ui-btn text-[12px]"
            data-testid="plan-comment-reply-open"
            onClick={() => {
              setReplyAgentId((prior) => replyAgents.some((agent) => agent.id === prior) ? prior : replyAgents[0].id);
              setReplyError(null);
              setReplyOpen((open) => !open);
            }}
          >
            Reply
          </button>
        )}
      </div>
      {replyOpen && onReply && (
        <div className="mt-2" data-testid="plan-comment-reply-form">
          <textarea
            value={replyBody}
            onChange={(event) => setReplyBody(event.target.value)}
            disabled={replyBusy}
            rows={2}
            data-testid="plan-comment-reply-textarea"
            className="w-full resize-y rounded border border-white/15 bg-surface-0 px-2 py-1 text-[12px] text-gray-200"
          />
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {replyAgents.length > 1 && (
              <select
                value={replyAgentId}
                onChange={(event) => setReplyAgentId(event.target.value)}
                data-testid="plan-comment-reply-supervisor-select"
                className="rounded border border-white/15 bg-surface-0 px-1.5 py-1 text-[12px] text-gray-200"
              >
                {replyAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.title}</option>)}
              </select>
            )}
            <button
              className="ui-btn text-[12px]"
              data-testid="plan-comment-reply-submit"
              disabled={replyBusy || !replyBody.trim() || !replyAgentId}
              onClick={() => {
                setReplyBusy(true);
                setReplyError(null);
                void onReply(replyBody.trim(), replyAgentId).then((result) => {
                  if (result.ok) {
                    setReplyBody('');
                    setReplyOpen(false);
                  } else setReplyError(result.error ?? 'Could not post the reply.');
                }).finally(() => setReplyBusy(false));
              }}
            >
              {replyBusy ? 'Posting…' : 'Post reply'}
            </button>
            {replyError && <span role="alert" className="text-[11px] text-red-400">{replyError}</span>}
          </div>
        </div>
      )}
      {pickerFor && (
        <div className="mt-1.5">
          <AgentPickerDropdown
            workspaceId={workspaceId}
            onPick={(target) => {
              setPickerFor(null);
              if (pickerFor === 'all') onSendAll?.(target);
              else onSendOne(target);
            }}
          />
        </div>
      )}
    </div>
  );
}
