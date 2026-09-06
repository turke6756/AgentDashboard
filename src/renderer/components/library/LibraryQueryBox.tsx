import React, { useEffect, useState } from 'react';

export default function LibraryQueryBox({ onQuery, includeUntrusted, onIncludeUntrusted }: { onQuery: (query: string) => void; includeUntrusted: boolean; onIncludeUntrusted: (value: boolean) => void }) {
  const [value, setValue] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => onQuery(value.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [value, onQuery]);
  return (
    <div className="flex items-center gap-3">
      <input aria-label="Search library" className="ui-input flex-1" placeholder="Search words or a phrase" value={value} onChange={(event) => setValue(event.target.value)} />
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={includeUntrusted} onChange={(event) => onIncludeUntrusted(event.target.checked)} />Include untrusted</label>
    </div>
  );
}
