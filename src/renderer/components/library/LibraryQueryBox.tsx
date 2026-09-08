import React, { useEffect, useRef } from 'react';

export default function LibraryQueryBox({ value, onChange, onQuery }: {
  value: string;
  onChange: (text: string) => void;
  onQuery: (trimmedQuery: string) => void;
}) {
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  }, []);

  const change = (text: string) => {
    onChange(text);
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      onQuery(text.trim());
    }, 250);
  };

  const clear = () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    onChange('');
    onQuery('');
  };

  return (
    <div className="flex items-center gap-3">
      <input aria-label="Search library" className="ui-input flex-1" placeholder="Search words or a phrase" value={value} onChange={(event) => change(event.target.value)} />
      {value.length > 0 && <button type="button" className="ui-btn" aria-label="Clear library search" onClick={clear}>Clear</button>}
    </div>
  );
}
