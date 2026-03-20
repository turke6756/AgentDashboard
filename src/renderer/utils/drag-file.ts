/**
 * Utilities for dragging file paths from UI elements into the terminal.
 */

/** Characters that are safe to leave unquoted in a shell path */
const SAFE_PATH_RE = /^[a-zA-Z0-9._/:\-]+$/;

/**
 * Shell-escape a file path for safe pasting into a terminal.
 * Clean paths pass through unchanged; paths with spaces or special
 * characters get single-quote wrapped with internal `'` escaped.
 */
export function shellEscapePath(path: string): string {
  if (SAFE_PATH_RE.test(path)) return path;
  // Wrap in single quotes, escaping any internal single quotes as '\''
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

/**
 * onDragStart handler — sets the file path on the drag event's dataTransfer.
 * Attach to any element that represents a file the user might want to
 * drop into the terminal.
 */
export function fileDragStart(e: React.DragEvent, filePath: string): void {
  e.dataTransfer.setData('application/x-file-path', filePath);
  e.dataTransfer.setData('text/plain', filePath);
  e.dataTransfer.effectAllowed = 'copy';
}
