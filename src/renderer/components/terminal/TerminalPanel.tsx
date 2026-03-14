import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useDashboardStore } from '../../stores/dashboard-store';

interface CachedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  unsub: (() => void) | null;
}

// Module-level cache — survives re-renders, preserves scrollback
const terminalCache = new Map<string, CachedTerminal>();

export default function TerminalPanel() {
  const { terminalAgentId, setTerminalAgent, agents } = useDashboardStore();
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const scrollLockedRef = useRef(false);
  const [scrollLocked, setScrollLocked] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const agent = agents.find(a => a.id === terminalAgentId);

  // Keep scrollLocked ref in sync
  useEffect(() => {
    scrollLockedRef.current = scrollLocked;
  }, [scrollLocked]);

  // Main terminal lifecycle effect
  useEffect(() => {
    if (!termRef.current || !terminalAgentId) return;

    // Capture agentId for this effect instance — critical for correct cleanup
    const agentId = terminalAgentId;
    const container = termRef.current;

    let cached = terminalCache.get(agentId);

    if (cached) {
      // Reattach existing terminal to DOM
      container.appendChild(cached.terminal.element!);
      cached.fitAddon.fit();
      cached.terminal.focus();
      xtermRef.current = cached.terminal;
      fitAddonRef.current = cached.fitAddon;

      // Re-attach IPC if needed (unsub was cleaned up on detach)
      if (!cached.unsub) {
        window.api.terminal.attach(agentId);
        const unsub = window.api.terminal.onData((incomingAgentId: string, data: string) => {
          if (incomingAgentId === agentId) {
            cached!.terminal.write(data);
          }
        });
        cached.unsub = unsub;
      }
    } else {
      // Create new terminal
      const terminal = new Terminal({
        theme: {
          background: '#0a0a0f',
          foreground: '#e0e0e0',
          cursor: '#ffffff',
          selectionBackground: '#3b82f680',
        },
        fontSize: 13,
        fontFamily: "'Cascadia Code', 'Consolas', monospace",
        cursorBlink: true,
        scrollback: 5000,
        smoothScrollDuration: 150,
        scrollSensitivity: 3,
        fastScrollSensitivity: 8,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);

      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // Forward terminal input to agent
      terminal.onData((data) => {
        window.api.terminal.write(agentId, data);
        if (!scrollLockedRef.current) {
          terminal.scrollToBottom();
        }
      });

      // Track scroll position for "scroll to bottom" button
      terminal.onScroll(() => {
        const viewportAtBottom =
          terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
        setIsAtBottom(viewportAtBottom);
      });

      // Attach IPC stream
      window.api.terminal.attach(agentId);

      const unsub = window.api.terminal.onData((incomingAgentId: string, data: string) => {
        if (incomingAgentId === agentId) {
          terminal.write(data);
        }
      });

      cached = { terminal, fitAddon, unsub };
      terminalCache.set(agentId, cached);

      terminal.focus();
    }

    // ResizeObserver for responsive fitting
    const observer = new ResizeObserver(() => {
      const entry = terminalCache.get(agentId);
      if (entry) {
        try {
          entry.fitAddon.fit();
          window.api.terminal.resize(agentId, entry.terminal.cols, entry.terminal.rows);
        } catch {
          // ignore fit errors during layout transitions
        }
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();

      const entry = terminalCache.get(agentId);
      if (entry) {
        // Clean up IPC listener
        if (entry.unsub) {
          entry.unsub();
          entry.unsub = null;
        }
        // Detach from main process
        window.api.terminal.detach(agentId);

        // Detach from DOM but DON'T dispose — preserve scrollback
        if (entry.terminal.element?.parentElement === container) {
          container.removeChild(entry.terminal.element);
        }
      }

      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalAgentId]);

  // Clean up cached terminals when agents are deleted
  useEffect(() => {
    const agentIds = new Set(agents.map(a => a.id));
    for (const [cachedId, entry] of terminalCache) {
      if (!agentIds.has(cachedId)) {
        if (entry.unsub) entry.unsub();
        entry.terminal.dispose();
        terminalCache.delete(cachedId);
      }
    }
  }, [agents]);

  // Sync scrollOnUserInput option without re-creating terminal
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.scrollOnUserInput = !scrollLocked;
    }
  }, [scrollLocked]);

  const scrollToBottom = useCallback(() => {
    if (xtermRef.current) {
      xtermRef.current.scrollToBottom();
      setIsAtBottom(true);
    }
  }, []);

  return (
    <div className="border-t border-gray-800 bg-surface-0 flex flex-col" style={{ height: '40%' }}>
      <div className="flex items-center justify-between px-4 py-1.5 bg-surface-1 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-400">Terminal</span>
          {agent && (
            <span className="text-xs text-gray-600">
              {agent.title}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
            <button
                onClick={() => xtermRef.current?.clear()}
                className="text-[10px] text-gray-500 hover:text-white uppercase tracking-wider border border-gray-700 hover:border-gray-500 px-2 py-0.5 rounded-sm transition-colors"
            >
                Clear
            </button>
            <button
                onClick={() => setScrollLocked(!scrollLocked)}
                className={`text-[10px] uppercase tracking-wider border px-2 py-0.5 rounded-sm transition-colors ${
                  scrollLocked
                    ? 'text-accent-orange border-accent-orange bg-accent-orange/10'
                    : 'text-gray-500 border-gray-700 hover:text-white hover:border-gray-500'
                }`}
                title={scrollLocked ? "Auto-scroll DISABLED" : "Auto-scroll ENABLED"}
            >
                {scrollLocked ? 'Scroll_Locked' : 'Scroll_Auto'}
            </button>
            <button
              onClick={() => setTerminalAgent(null)}
              className="text-gray-500 hover:text-white text-sm px-2 ml-2"
            >
              Close
            </button>
        </div>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <div ref={termRef} className="w-full h-full" onClick={() => xtermRef.current?.focus()} />
        {!isAtBottom && !scrollLocked && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-3 right-5 text-[10px] text-gray-400 bg-surface-2 border border-gray-700 hover:text-white hover:border-gray-500 px-3 py-1 rounded transition-colors shadow-lg"
          >
            ↓ Scroll to bottom
          </button>
        )}
      </div>
    </div>
  );
}
