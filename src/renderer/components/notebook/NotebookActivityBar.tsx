interface NotebookActivityBarProps {
  running: boolean;
  errored: boolean;
}

export function NotebookActivityBar({ running, errored }: NotebookActivityBarProps) {
  if (!running && !errored) {
    return <div className="h-1 bg-transparent" />;
  }

  return (
    <div className="h-1 overflow-hidden bg-surface-2">
      <div
        className={`h-full w-full ${
          errored
            ? 'bg-accent-red'
            : 'bg-[linear-gradient(90deg,var(--color-accent-blue)_0%,var(--color-accent-green)_45%,var(--color-accent-blue-bright)_100%)] notebook-activity-bar-running'
        }`}
      />
    </div>
  );
}
