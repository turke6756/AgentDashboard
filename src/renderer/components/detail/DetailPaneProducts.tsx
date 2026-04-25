import React, { useEffect, useMemo, useState } from 'react';
import type { FileActivity, PathType } from '../../../shared/types';
import FileActivityList from './FileActivityList';

interface Props {
  agentId: string;
  pathType?: PathType;
}

export default function DetailPaneProducts({ agentId, pathType }: Props) {
  const [activities, setActivities] = useState<FileActivity[]>([]);

  useEffect(() => {
    const fetchActivities = async () => {
      // Fetch both write and create operations
      const data = await window.api.agents.getFileActivities(agentId);
      setActivities(data.filter((a) => a.operation === 'write' || a.operation === 'create'));
    };

    fetchActivities();
    const interval = setInterval(fetchActivities, 5000);

    const unsub = window.api.agents.onFileActivity((activity) => {
      if (activity.agentId === agentId && (activity.operation === 'write' || activity.operation === 'create')) {
        setActivities((prev) => [activity, ...prev]);
      }
    });

    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [agentId]);

  const { created, modified } = useMemo(() => {
    const created: FileActivity[] = [];
    const modified: FileActivity[] = [];
    for (const a of activities) {
      if (a.operation === 'create') created.push(a);
      else if (a.operation === 'write') modified.push(a);
    }
    return { created, modified };
  }, [activities]);

  if (created.length === 0 && modified.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-gray-400 text-sm">
        No outputs yet...
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <FileActivityList
        activities={created}
        pathType={pathType}
        agentId={agentId}
        title="Created"
        embedded
      />
      <FileActivityList
        activities={modified}
        pathType={pathType}
        agentId={agentId}
        title="Modified"
        embedded
      />
    </div>
  );
}
