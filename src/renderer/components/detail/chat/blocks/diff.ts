export type DiffLineKind = 'removed' | 'added' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export function computeLineDiff(oldStr: string, newStr: string): DiffLine[] {
  const hasOld = oldStr.length > 0;
  const hasNew = newStr.length > 0;
  const out: DiffLine[] = [];
  if (hasOld) {
    for (const line of oldStr.split('\n')) {
      out.push({ kind: 'removed', text: line });
    }
  }
  if (hasNew) {
    for (const line of newStr.split('\n')) {
      out.push({ kind: 'added', text: line });
    }
  }
  return out;
}
