import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import type { AgentStatus } from '../../../shared/types';

interface Props {
  agentId: string;
  agentStatus: AgentStatus;
}

// --- ANSI stripping (from wsl-runner.ts) ---
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
  | 'separator'
  | 'system';

interface Block {
  type: BlockType;
  lines: string[];
  toolName?: string;
}

const KNOWN_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task',
  'WebSearch', 'WebFetch', 'NotebookEdit', 'Skill',
  'TodoRead', 'TodoWrite', 'MultiEdit',
]);

// --- Parser ---
function parseLog(text: string): Block[] {
  const clean = stripAnsi(text);
  const rawLines = clean.split('\n');
  const blocks: Block[] = [];
  let current: Block | null = null;

  const flush = () => {
    if (current) {
      blocks.push(current);
      current = null;
    }
  };

  for (const line of rawLines) {
    if (/^[─]{4,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: 'separator', lines: [line] });
      continue;
    }

    if (line.startsWith('❯ ') || line === '❯') {
      flush();
      current = { type: 'user-input', lines: [line] };
      continue;
    }

    const toolMatch = line.match(/^● (\w+)\(/);
    if (toolMatch && KNOWN_TOOLS.has(toolMatch[1])) {
      flush();
      current = { type: 'tool-call', lines: [line], toolName: toolMatch[1] };
      continue;
    }

    if (line.startsWith('● ')) {
      flush();
      current = { type: 'model-text', lines: [line] };
      continue;
    }

    if (line.startsWith('  ⎿ ') || line === '  ⎿') {
      flush();
      current = { type: 'tool-output', lines: [line] };
      continue;
    }

    if (line.startsWith('✻ ') || line === '✻') {
      flush();
      current = { type: 'summary', lines: [line] };
      continue;
    }

    if (/^[╭╰│⏵┌┐└┘├┤┬┴┼]/.test(line) || line.startsWith('⏵⏵')) {
      if (current?.type === 'model-text') {
        current.lines.push(line);
        continue;
      }
      flush();
      current = { type: 'system', lines: [line] };
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else if (line.trim() !== '') {
      current = { type: 'system', lines: [line] };
    }
  }

  flush();
  return blocks;
}

// --- Renderers ---

const COLLAPSE_THRESHOLD = 3;

function CollapsibleToolOutput({ block }: { block: Block }) {
  const [expanded, setExpanded] = useState(false);
  const lines = block.lines;
  const isLong = lines.length > COLLAPSE_THRESHOLD;
  const firstLine = lines[0] || '';
  const hiddenCount = lines.length - 1;

  if (!isLong) {
    return (
      <div className="border-l border-gray-700 ml-3 pl-3 my-0.5">
        <pre className="text-gray-500 whitespace-pre-wrap break-all m-0">{lines.join('\n')}</pre>
      </div>
    );
  }

  return (
    <div className="border-l border-gray-700 ml-3 pl-3 my-0.5">
      <div
        className="flex items-center gap-2 cursor-pointer select-none group"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-gray-600 text-[10px] transition-transform duration-150"
              style={{ display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          &#9654;
        </span>
        <pre className="text-gray-500 whitespace-pre-wrap break-all m-0 inline">{firstLine}</pre>
        {!expanded && (
          <span className="text-gray-600 text-[10px] whitespace-nowrap">
            +{hiddenCount} lines
          </span>
        )}
      </div>
      {expanded && (
        <pre className="text-gray-500 whitespace-pre-wrap break-all m-0 mt-0.5">
          {lines.slice(1).join('\n')}
        </pre>
      )}
    </div>
  );
}

function BlockDiv({ block }: { block: Block }) {
  const text = block.lines.join('\n');

  switch (block.type) {
    case 'user-input':
      return (
        <div className="border-l-2 border-[var(--color-accent-blue)] pl-3 py-1 my-1">
          <pre className="text-[var(--color-accent-blue)] whitespace-pre-wrap break-all m-0">{text}</pre>
        </div>
      );

    case 'tool-call':
      return (
        <div className="bg-[var(--color-surface-2)] border border-gray-800 rounded-sm px-3 py-1.5 my-1">
          <pre className="whitespace-pre-wrap break-all m-0">
            <span className="text-[var(--color-accent-orange)]">{block.toolName}</span>
            <span className="text-gray-400">{text.slice(text.indexOf('('))}</span>
          </pre>
        </div>
      );

    case 'tool-output':
      return <CollapsibleToolOutput block={block} />;

    case 'model-text':
      return (
        <div className="bg-[var(--color-surface-1)] border-l-2 border-[var(--color-accent-green)]/30 rounded-sm px-3 py-1.5 my-1">
          <pre className="whitespace-pre-wrap break-all m-0">
            {text.startsWith('● ') ? (
              <>
                <span className="text-[var(--color-accent-green)]">{'● '}</span>
                <span className="text-gray-300">{text.slice(2)}</span>
              </>
            ) : (
              <span className="text-gray-300">{text}</span>
            )}
          </pre>
        </div>
      );

    case 'summary':
      return (
        <div className="py-0.5 my-0.5">
          <pre className="text-[var(--color-accent-purple)] text-[10px] whitespace-pre-wrap break-all m-0 opacity-70">{text}</pre>
        </div>
      );

    case 'separator':
      return <div className="border-t border-gray-800 my-2" />;

    case 'system':
      return (
        <div className="opacity-30 my-0.5">
          <pre className="text-gray-500 whitespace-pre-wrap break-all m-0">{text}</pre>
        </div>
      );
  }
}

// --- Chat input bar ---

const ACCEPTING_INPUT: AgentStatus[] = ['idle', 'waiting', 'done', 'crashed'];

function ChatInputBar({ agentId, agentStatus }: { agentId: string; agentStatus: AgentStatus }) {
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
      // Send input to the agent (uses tmux send-keys for WSL, \r for Windows)
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
    <div className="border-t border-gray-800 bg-[var(--color-surface-0)] px-3 py-2">
      <div className={`flex items-end gap-2 border rounded-sm px-2 py-1.5 transition-colors ${
        isDisabled
          ? 'border-gray-800 opacity-50'
          : 'border-gray-700 focus-within:border-[var(--color-accent-blue)]/50'
      }`}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          placeholder={statusHint}
          rows={1}
          className="flex-1 bg-transparent text-[11px] text-gray-200 placeholder-gray-600 font-mono resize-none outline-none min-h-[20px] max-h-[80px] leading-relaxed disabled:cursor-not-allowed"
          style={{ fieldSizing: 'content' } as React.CSSProperties}
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 transition-all text-[var(--color-accent-blue)] hover:bg-[var(--color-accent-blue)]/10 disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
        >
          {sending ? '...' : 'SEND'}
        </button>
      </div>
      {isDisabled && (agentStatus === 'working' || agentStatus === 'launching') && (
        <div className="flex items-center gap-1.5 mt-1.5 px-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-accent-yellow)] animate-pulse" />
          <span className="text-[9px] text-gray-500 uppercase tracking-wider">
            {agentStatus === 'launching' ? 'Launching' : 'Processing'}
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
      <div className="flex-1 flex flex-col overflow-hidden">
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
    <div className="flex-1 flex flex-col overflow-hidden">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pb-4 text-[11px] font-mono leading-relaxed">
        {blocks.map((block, i) => (
          <BlockDiv key={i} block={block} />
        ))}
      </div>
      <ChatInputBar agentId={agentId} agentStatus={agentStatus} />
    </div>
  );
}
