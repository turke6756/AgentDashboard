import React, { useEffect, useState } from 'react';

interface Props {
  agentId: string;
}

export default function DetailPaneLog({ agentId }: Props) {
  const [log, setLog] = useState('');

  useEffect(() => {
    const fetchLog = async () => {
      const text = await window.api.agents.getLog(agentId, 80);
      setLog(text);
    };

    fetchLog();
    const interval = setInterval(fetchLog, 3000);
    return () => clearInterval(interval);
  }, [agentId]);

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-4">
      <pre className="text-[11px] text-gray-400 font-mono whitespace-pre-wrap break-all leading-relaxed">
        {log || 'No output yet...'}
      </pre>
    </div>
  );
}
