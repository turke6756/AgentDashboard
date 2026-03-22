import React, { useState } from 'react';
import type { Agent, QueryResult } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';

interface QueryDialogProps {
  sourceAgent: Agent;
  onClose: () => void;
}

export default function QueryDialog({ sourceAgent, onClose }: QueryDialogProps) {
  const { agents, queryAgent } = useDashboardStore();
  const [targetId, setTargetId] = useState('');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);

  const eligibleTargets = agents.filter(
    (a) => a.id !== sourceAgent.id && a.resumeSessionId
  );

  const handleSend = async () => {
    if (!targetId || !question.trim()) return;
    setLoading(true);
    setResult(null);
    const res = await queryAgent(targetId, question.trim(), sourceAgent.id);
    setResult(res);
    setLoading(false);
  };

  const handleCopy = async () => {
    if (result?.result) {
      await navigator.clipboard.writeText(result.result);
    }
  };

  const handleInject = () => {
    if (result?.result) {
      window.api.terminal.write(sourceAgent.id, result.result);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface-2 border border-gray-700 rounded-xl w-[480px] max-h-[80vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-gray-700 flex items-center justify-between">
          <h3 className="font-bold text-sm">Query Agent</h3>
          <button onClick={onClose} className="text-gray-300 hover:text-gray-300 text-sm">X</button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3 flex-1 overflow-y-auto">
          {/* Target selector */}
          <div>
            <label className="text-[13px] text-gray-300 block mb-1">Target agent</label>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="w-full bg-surface-0 border border-gray-700 rounded text-[13px] p-2 focus:outline-none focus:border-accent-blue"
            >
              <option value="">Select an agent...</option>
              {eligibleTargets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title} ({a.status})
                </option>
              ))}
            </select>
            {eligibleTargets.length === 0 && (
              <p className="text-[13px] text-gray-400 mt-1">No agents with session IDs available</p>
            )}
          </div>

          {/* Question */}
          <div>
            <label className="text-[13px] text-gray-300 block mb-1">Question</label>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What would you like to ask?"
              className="w-full bg-surface-0 border border-gray-700 rounded text-[13px] p-2 resize-none h-24 focus:outline-none focus:border-accent-blue"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
          </div>

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={loading || !targetId || !question.trim()}
            className="w-full py-2 text-[13px] font-medium bg-accent-blue hover:bg-blue-500 rounded transition-colors text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? 'Querying... this may take up to 60s' : 'Send Query'}
          </button>

          {/* Result */}
          {result && (
            <div className={`p-3 rounded text-[13px] ${result.isError ? 'bg-red-500/10 border border-red-500/30' : 'bg-surface-0 border border-gray-700'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-[13px] font-medium ${result.isError ? 'text-red-400' : 'text-green-400'}`}>
                  {result.isError ? 'Error' : 'Response'}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={handleCopy}
                    className="text-[13px] text-gray-300 hover:text-gray-300"
                  >
                    Copy
                  </button>
                  {!result.isError && (
                    <button
                      onClick={handleInject}
                      className="text-[13px] text-purple-400 hover:text-purple-300"
                    >
                      Inject to terminal
                    </button>
                  )}
                </div>
              </div>
              <pre className="whitespace-pre-wrap text-gray-300 max-h-48 overflow-y-auto">{result.result}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
