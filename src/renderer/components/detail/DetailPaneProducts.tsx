import React, { useEffect, useState } from 'react';
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

  return <FileActivityList activities={activities} pathType={pathType} />;
}
