import { useState, useCallback, useEffect, useRef } from 'react';

interface UseResizeOptions {
  direction: 'horizontal' | 'vertical';
  initialSize: number;
  min: number;
  max: number;
  storageKey: string;
}

export function useResize({ direction, initialSize, min, max, storageKey }: UseResizeOptions) {
  const [size, setSize] = useState<number>(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const val = parseInt(stored, 10);
      if (!isNaN(val) && val >= min && val <= max) return val;
    }
    return initialSize;
  });

  const isResizing = useRef(false);
  const startPos = useRef(0);
  const startSize = useRef(0);
  const rafId = useRef(0);
  const [resizing, setResizing] = useState(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;
    startSize.current = size;
    setResizing(true);

    document.body.classList.add(direction === 'horizontal' ? 'resizing-h' : 'resizing-v');
    document.body.style.userSelect = 'none';
  }, [direction, size]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(() => {
        const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
        const delta = currentPos - startPos.current;
        const newSize = Math.min(max, Math.max(min, startSize.current + delta));
        setSize(newSize);
      });
    };

    const handleMouseUp = () => {
      if (!isResizing.current) return;
      isResizing.current = false;
      cancelAnimationFrame(rafId.current);
      setResizing(false);
      document.body.classList.remove('resizing-h', 'resizing-v');
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      cancelAnimationFrame(rafId.current);
    };
  }, [direction, min, max]);

  // Persist to localStorage on change (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      localStorage.setItem(storageKey, String(size));
    }, 200);
    return () => clearTimeout(timer);
  }, [size, storageKey]);

  return { size, isResizing: resizing, handleMouseDown, setSize };
}
