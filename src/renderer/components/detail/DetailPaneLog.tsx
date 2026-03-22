import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import type { AgentStatus } from '../../../shared/types';
import { useThemeStore } from '../../stores/theme-store';

interface Props {
  agentId: string;
  agentStatus: AgentStatus;
}

// --- ANSI stripping ---
function stripAnsi(data: string): string {
  return data
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-Z]/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[hlm]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

// --- Block types ---
type BlockType =
  | 'user-input'
  | 'tool-call'
  | 'model-text'
  | 'tool-output'
  | 'summary'
  | 'system';

interface Block {
  type: BlockType;
  lines: string[];
  toolName?: string;
}

const KNOWN_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task',
  'WebSearch', 'WebFetch', 'NotebookEdit', 'Skill',
  'TodoRead', 'TodoWrite', 'MultiEdit', 'Agent',
]);

// Lines that are purely decorative junk from the terminal
function isJunkLine(line: string): boolean {
  // Pure separator lines (─, ━, ═, -, =, etc.)
  if (/^[\s─━═\-=╌╍┄┅·•]+$/.test(line)) return true;
  // Box-drawing borders (╭╮╰╯│┌┐└┘├┤┬┴┼)
  if (/^[\s╭╮╰╯│┌┐└┘├┤┬┴┼─━═┈┉╌╍]+$/.test(line)) return true;
  // Lines that are just the thinking spinner or progress
  if (/^[⏵⏴▸▹►▻⟩>]{2,}/.test(line)) return true;
  // Empty or whitespace-only
  if (line.trim() === '') return false; // keep blank lines for spacing
  return false;
}

// Clean decorative unicode from the start/end of content lines
function cleanLine(line: string): string {
  // Strip leading box-drawing chars that leak into content
  return line.replace(/^[╭╮╰╯│┌┐└┘├┤┬┴┼─]\s?/, '');
}

// --- Parser ---
function parseLog(text: string): Block[] {
  const clean = stripAnsi(text);
  const rawLines = clean.split('\n');
  const blocks: Block[] = [];
  let current: Block | null = null;
  let blankRun = 0;

  const flush = () => {
    if (current) {
      // Trim trailing blank lines from block
      while (current.lines.length > 0 && current.lines[current.lines.length - 1].trim() === '') {
        current.lines.pop();
      }
      if (current.lines.length > 0) {
        blocks.push(current);
      }
      current = null;
    }
  };

  for (const raw of rawLines) {
    const line = raw;

    // Skip pure junk/decorative lines
    if (isJunkLine(line)) continue;

    // Collapse multiple blank lines into max 1
    if (line.trim() === '') {
      blankRun++;
      if (blankRun <= 1 && current) {
        current.lines.push('');
      }
      continue;
    }
    blankRun = 0;

    // User input (❯ prompt)
    if (line.startsWith('❯ ') || line === '❯') {
      flush();
      current = { type: 'user-input', lines: [line.replace(/^❯\s?/, '')] };
      continue;
    }

    // Tool call (● ToolName(...))
    const toolMatch = line.match(/^●\s+(\w+)\(/);
    if (toolMatch && KNOWN_TOOLS.has(toolMatch[1])) {
      flush();
      current = { type: 'tool-call', lines: [line.replace(/^●\s+/, '')], toolName: toolMatch[1] };
      continue;
    }

    // Model text (● followed by text)
    if (line.startsWith('● ')) {
      flush();
      current = { type: 'model-text', lines: [line.replace(/^●\s+/, '')] };
      continue;
    }

    // Tool output (  ⎿ ...)
    if (line.startsWith('  ⎿ ') || line === '  ⎿') {
      flush();
      current = { type: 'tool-output', lines: [line.replace(/^\s*⎿\s?/, '')] };
      continue;
    }

    // Summary (✻)
    if (line.startsWith('✻ ') || line === '✻') {
      flush();
      current = { type: 'summary', lines: [line.replace(/^✻\s?/, '')] };
      continue;
    }

    // Continuation of current block
    if (current) {
      // Clean box-drawing leaks from continuation lines
      const cleaned = current.type === 'system' ? cleanLine(line) : line;
      // For tool output, strip leading indent that comes from the ⎿ format
      if (current.type === 'tool-output') {
        current.lines.push(line.replace(/^\s{4}/, ''));
      } else {
        current.lines.push(cleaned);
      }
    } else if (line.trim() !== '') {
      const cleaned = cleanLine(line);
      if (cleaned.trim()) {
        current = { type: 'system', lines: [cleaned] };
      }
    }
  }

  flush();
  return blocks;
}

// --- Renderers ---

function CollapsibleBlock({
  children,
  summary,
  badge,
  badgeColor,
  defaultOpen = false,
  containerClass = '',
}: {
  children: React.ReactNode;
  summary: string;
  badge?: string;
  badgeColor?: string;
  defaultOpen?: boolean;
  containerClass?: string;
}) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={containerClass}>
      <div
        className="flex items-center gap-1.5 cursor-pointer select-none group"
        onClick={() => setOpen(o => !o)}
      >
        <span
          className={`text-[9px] transition-transform duration-100 ${isLight ? 'text-[#666666]' : 'text-gray-600'}`}
          style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          &#9654;
        </span>
        {badge && (
          <span className={`text-[9px] font-bold uppercase tracking-wider px-1 py-px rounded-sm ${badgeColor || ''}`}>
            {badge}
          </span>
        )}
        <span className={`text-[10px] truncate ${isLight ? 'text-[#57606a]' : 'text-gray-500'}`}>
          {summary}
        </span>
      </div>
      {open && <div className="mt-0.5">{children}</div>}
    </div>
  );
}

function ToolCallBlock({ block }: { block: Block }) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const text = block.lines.join('\n');
  const toolName = block.toolName || 'Tool';

  // Extract just the args portion for the summary
  const parenIdx = text.indexOf('(');
  const argsSummary = parenIdx >= 0
    ? text.slice(parenIdx + 1, text.indexOf(')', parenIdx) > 0 ? text.indexOf(')') : parenIdx + 60)
    : text.slice(toolName.length);
  const truncatedArgs = argsSummary.length > 80 ? argsSummary.slice(0, 80) + '...' : argsSummary;

  return (
    <CollapsibleBlock
      summary={truncatedArgs}
      badge={toolName}
      badgeColor={isLight
        ? 'text-[#6e5600] bg-[#daa520]/15 border border-[#daa520]/20'
        : 'text-amber-400/80 bg-amber-400/10'
      }
      containerClass={`my-0.5 py-1 px-2 rounded-sm ${
        isLight ? 'bg-[#ffffff] border border-[#d1d1d1]' : 'bg-white/[0.02] border border-white/[0.04]'
      }`}
    >
      <pre className={`whitespace-pre-wrap break-all m-0 text-[10px] pl-3 ${
        isLight ? 'text-[#666666]' : 'text-gray-500'
      }`}>
        {text}
      </pre>
    </CollapsibleBlock>
  );
}

function ToolOutputBlock({ block }: { block: Block }) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const lines = block.lines;
  const firstLine = lines[0] || '';
  const isLong = lines.length > 3;

  if (!isLong) {
    return (
      <div className={`pl-4 my-0.5 border-l ${isLight ? 'border-[#d1d1d1]' : 'border-white/[0.06]'}`}>
        <pre className={`whitespace-pre-wrap break-all m-0 text-[10px] ${
          isLight ? 'text-[#666666]' : 'text-gray-600'
        }`}>{lines.join('\n')}</pre>
      </div>
    );
  }

  return (
    <div className={`pl-4 my-0.5 border-l ${isLight ? 'border-[#d1d1d1]' : 'border-white/[0.06]'}`}>
      <CollapsibleBlock
        summary={`${firstLine.slice(0, 60)}${firstLine.length > 60 ? '...' : ''} (+${lines.length - 1} lines)`}
      >
        <pre className={`whitespace-pre-wrap break-all m-0 text-[10px] ${
          isLight ? 'text-[#666666]' : 'text-gray-600'
        }`}>{lines.join('\n')}</pre>
      </CollapsibleBlock>
    </div>
  );
}

function BlockDiv({ block }: { block: Block }) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const text = block.lines.join('\n');

  switch (block.type) {
    case 'user-input':
      return (
        <div className={`mt-3 mb-1 pl-2.5 py-1 border-l-2 ${
          isLight ? 'border-[#005e9e]' : 'border-[#58a6ff]'
        }`}>
          <pre className={`whitespace-pre-wrap break-all m-0 font-semibold text-[11px] ${
            isLight ? 'text-[#005e9e]' : 'text-[#79c0ff]'
          }`}>{text}</pre>
        </div>
      );

    case 'tool-call':
      return <ToolCallBlock block={block} />;

    case 'tool-output':
      return <ToolOutputBlock block={block} />;

    case 'model-text':
      return (
        <div className="my-1 py-0.5">
          <pre className={`whitespace-pre-wrap break-words m-0 text-[11px] leading-[1.5] ${
            isLight ? 'text-[#1f2328]' : 'text-gray-200'
          }`}>{text}</pre>
        </div>
      );

    case 'summary':
      return (
        <div className={`my-1 py-0.5 text-[10px] italic ${
          isLight ? 'text-[#6639ba]' : 'text-purple-400/70'
        }`}>
          <pre className="whitespace-pre-wrap break-all m-0">{text}</pre>
        </div>
      );

    case 'system':
      return (
        <div className={`my-0.5 text-[10px] ${isLight ? 'text-[#666666]' : 'text-gray-600'}`}>
          <pre className="whitespace-pre-wrap break-all m-0">{text}</pre>
        </div>
      );
  }
}

// --- Chat input bar ---

const ACCEPTING_INPUT: AgentStatus[] = ['idle', 'waiting', 'done', 'crashed'];

function ChatInputBar({ agentId, agentStatus }: { agentId: string; agentStatus: AgentStatus }) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const canSend = ACCEPTING_INPUT.includes(agentStatus) && input.trim().length > 0 && !sending;
  const isDisabled = !ACCEPTING_INPUT.includes(agentStatus);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !canSend) return;

    setSending(true);
    try {
      await window.api.agents.sendInput(agentId, text);
      setInput('');
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [agentId, input, canSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const statusHint = isDisabled
    ? agentStatus === 'working' || agentStatus === 'launching'
      ? 'Agent is working...'
      : `Agent is ${agentStatus}`
    : 'Message the agent...';

  return (
    <div className={`border-t px-3 py-2 ${
      isLight
        ? 'border-[#d1d1d1] bg-[#f5f5f5]'
        : 'border-gray-800/20 bg-surface-1/50'
    }`}>
      <div className={`flex items-end gap-2 border rounded-sm px-2 py-1.5 transition-all ${
        isDisabled
          ? isLight
            ? 'border-[#d0d4da] opacity-60'
            : 'border-gray-800/30 opacity-60'
          : isLight
            ? 'border-[#d1d1d1] bg-white shadow-none focus-within:border-[var(--color-accent-blue)] focus-within:ring-1 focus-within:ring-[var(--color-accent-blue)]/50'
            : 'border-gray-600/50 bg-surface-0 shadow-inner focus-within:border-[var(--color-accent-blue)]/60 focus-within:ring-1 focus-within:ring-[var(--color-accent-blue)]/20'
      }`}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          placeholder={statusHint}
          rows={1}
          className={`flex-1 bg-transparent text-[11px] font-mono resize-none outline-none min-h-[20px] max-h-[80px] leading-relaxed disabled:cursor-not-allowed ${
            isLight
              ? 'text-[#1a1a1a] placeholder-[#8b949e]'
              : 'text-gray-50 placeholder-gray-500'
          }`}
          style={{ fieldSizing: 'content' } as React.CSSProperties}
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          className="text-[10px] font-bold uppercase tracking-wider px-3 py-1.5 transition-all text-white bg-[var(--color-accent-blue)] hover:brightness-110 active:scale-95 disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed shrink-0 rounded-sm shadow-sm"
        >
          {sending ? '...' : 'Send'}
        </button>
      </div>
      {isDisabled && (agentStatus === 'working' || agentStatus === 'launching') && (
        <div className="flex items-center gap-1.5 mt-1.5 px-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-accent-yellow)] animate-pulse" />
          <span className={`text-[9px] uppercase tracking-wider font-bold ${
            isLight ? 'text-[#666666]' : 'text-gray-500'
          }`}>
            {agentStatus === 'launching' ? 'Initializing System' : 'Agent Processing'}
          </span>
        </div>
      )}
    </div>
  );
}

// --- Main component ---

export default function DetailPaneLog({ agentId, agentStatus }: Props) {
  const [log, setLog] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const isLight = useThemeStore((s) => s.theme) === 'light';

  useEffect(() => {
    const fetchLog = async () => {
      const text = await window.api.agents.getLog(agentId, 80);
      setLog(text);
    };

    fetchLog();
    const interval = setInterval(fetchLog, 3000);
    return () => clearInterval(interval);
  }, [agentId]);

  const blocks = useMemo(() => parseLog(log), [log]);

  if (!log) {
    return (
      <div className={`flex-1 flex flex-col overflow-hidden shadow-inner ${isLight ? 'bg-black/5' : 'bg-black/40'}`}>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          <pre className="text-[11px] text-gray-400 font-mono whitespace-pre-wrap break-all leading-relaxed">
            No output yet...
          </pre>
        </div>
        <ChatInputBar agentId={agentId} agentStatus={agentStatus} />
      </div>
    );
  }

  return (
    <div className={`flex-1 flex flex-col overflow-hidden shadow-inner ${isLight ? 'bg-black/5' : 'bg-black/40'}`}>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 pb-3 pt-1 text-[11px] font-mono leading-relaxed">
        {blocks.map((block, i) => (
          <BlockDiv key={i} block={block} />
        ))}
      </div>
      <ChatInputBar agentId={agentId} agentStatus={agentStatus} />
    </div>
  );
}
