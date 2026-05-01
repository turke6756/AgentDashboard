import { useState, useEffect } from 'react';
import type { FileContent, PathType } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';

// Module-level cache: tabId -> FileContent
const contentCache = new Map<string, FileContent>();

export function evictTabCache(tabId: string) {
  contentCache.delete(tabId);
}

export function evictAllCache() {
  contentCache.clear();
}

export function useFileContentCache(tabId: string, filePath: string, pathType: PathType, skip = false) {
  const [content, setContent] = useState<FileContent | null>(() => skip ? null : (contentCache.get(tabId) || null));
  const [loading, setLoading] = useState(!skip && !contentCache.has(tabId));
  const checkHealth = useDashboardStore((s) => s.checkHealth);

  useEffect(() => {
    if (!filePath || skip) {
      setContent(null);
      setLoading(false);
      return;
    }

    // Check if cached content matches current filePath
    const cached = contentCache.get(tabId);
    if (cached && cached.path === filePath) {
      setContent(cached);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    window.api.files.readFile(filePath, pathType).then((result) => {
      if (cancelled) return;
      contentCache.set(tabId, result);
      setContent(result);
      setLoading(false);
      if (pathType === 'wsl') {
        void checkHealth();
      }
    });

    return () => { cancelled = true; };
  }, [tabId, filePath, pathType, skip, checkHealth]);

  return { content, loading };
}
