import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useDashboardStore } from '../../stores/dashboard-store';

export default function TerminalPanel() {
  const { terminalAgentId, setTerminalAgent, agents } = useDashboardStore();
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const agent = agents.find(a => a.id === terminalAgentId);

  useEffect(() => {
    if (!termRef.current || !terminalAgentId) return;

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
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(termRef.current);
    fitAddon.fit();

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Attach live stream — don't preload log history as raw escape
    // sequences corrupt xterm cursor state. The detail panel shows logs.
    window.api.terminal.attach(terminalAgentId);
    // Send initial resize so PTY knows terminal dimensions
    window.api.terminal.resize(terminalAgentId, terminal.cols, terminal.rows);
    // Focus the terminal so user can type
    terminal.focus();

    // Forward terminal input to agent
    terminal.onData((data) => {
      if (terminalAgentId) {
        window.api.terminal.write(terminalAgentId, data);
      }
    });

    // Receive data from agent
    const unsub = window.api.terminal.onData((agentId, data) => {
      if (agentId === terminalAgentId) {
        terminal.write(data);
      }
    });

    // Handle resize
    const handleResize = () => {
      fitAddon.fit();
      if (terminalAgentId) {
        window.api.terminal.resize(terminalAgentId, terminal.cols, terminal.rows);
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      unsub();
      if (terminalAgentId) {
        window.api.terminal.detach(terminalAgentId);
      }
      terminal.dispose();
    };
  }, [terminalAgentId]);

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
        <button
          onClick={() => setTerminalAgent(null)}
          className="text-gray-500 hover:text-white text-sm px-2"
        >
          Close
        </button>
      </div>
      <div ref={termRef} className="flex-1" onClick={() => xtermRef.current?.focus()} />
    </div>
  );
}
