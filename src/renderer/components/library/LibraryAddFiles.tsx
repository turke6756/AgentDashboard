import React, { useRef, useState } from 'react';

const ACCEPT = '.pdf,.docx,.md,.markdown,.txt';

export default function LibraryAddFiles({ onAdd, onRescan }: { onAdd: (files: File[], trigger: 'add' | 'drop') => Promise<void>; onRescan: () => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`flex items-center justify-between rounded border border-dashed p-3 ${dragging ? 'border-accent-blue bg-accent-blue/10' : 'border-white/15'}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); void onAdd(Array.from(event.dataTransfer.files), 'drop'); }}
      data-testid="library-drop-zone"
    >
      <span className="text-xs text-gray-400">Drop PDF, DOCX, Markdown, or text files here</span>
      <div className="flex gap-2">
        <input ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(event) => void onAdd(Array.from(event.target.files ?? []), 'add')} />
        <button className="ui-btn" onClick={() => inputRef.current?.click()}>Add files</button>
        <button className="ui-btn" onClick={() => void onRescan()}>Rescan</button>
      </div>
    </div>
  );
}
