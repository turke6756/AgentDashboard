import type * as nbformat from '@jupyterlab/nbformat';

export type RichOutput =
  | nbformat.IExecuteResult
  | nbformat.IDisplayData
  | nbformat.IDisplayUpdate;

export type NormalizedOutput =
  | nbformat.IError
  | RichOutput
  | (nbformat.IStream & { text: string })
  | nbformat.IUnrecognizedOutput;

export const WIDGET_MIME_TYPES = [
  'application/vnd.jupyter.widget-view+json',
  'application/vnd.bokehjs_exec.v0+json',
];

export const MIME_PRIORITY = [
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'text/html',
  'text/markdown',
  'application/json',
  'text/plain',
];

export function normalizeOutputs(outputs: nbformat.IOutput[]): NormalizedOutput[] {
  const normalized: NormalizedOutput[] = [];

  for (const output of outputs) {
    if (isStreamOutput(output)) {
      const text = joinMultiline(output.text);
      const previous = normalized[normalized.length - 1];
      if (isStreamOutput(previous) && previous.name === output.name) {
        previous.text = applyCarriageReturns(previous.text + text);
      } else {
        normalized.push({ ...output, text: applyCarriageReturns(text) });
      }
      continue;
    }

    normalized.push(output as NormalizedOutput);
  }

  return normalized;
}

export function joinMultiline(value: nbformat.MultilineString | undefined): string {
  if (typeof value === 'undefined') return '';
  return Array.isArray(value) ? value.join('') : value;
}

export function mimeValueToText(value: nbformat.IMimeBundle[string] | undefined): string {
  if (typeof value === 'undefined') return '';
  if (typeof value === 'string' || Array.isArray(value)) return joinMultiline(value);
  return JSON.stringify(value, null, 2);
}

export function selectMimeType(data: nbformat.IMimeBundle): string | null {
  const widgetMime = WIDGET_MIME_TYPES.find((mime) => Object.prototype.hasOwnProperty.call(data, mime));
  if (widgetMime) return widgetMime;
  return MIME_PRIORITY.find((mime) => Object.prototype.hasOwnProperty.call(data, mime)) ?? null;
}

export function isWidgetMime(mimeType: string | null): boolean {
  return !!mimeType && WIDGET_MIME_TYPES.includes(mimeType);
}

export function isRichOutput(output: NormalizedOutput): output is RichOutput {
  return (
    output.output_type === 'execute_result' ||
    output.output_type === 'display_data' ||
    output.output_type === 'update_display_data'
  );
}

export function isStreamOutput(output: unknown): output is nbformat.IStream & { text: nbformat.MultilineString } {
  return !!output && typeof output === 'object' && (output as nbformat.IBaseOutput).output_type === 'stream';
}

export function isErrorOutput(output: NormalizedOutput): output is nbformat.IError {
  return output.output_type === 'error';
}

export function applyCarriageReturns(input: string): string {
  const lines = [''];
  let column = 0;

  for (const char of input) {
    if (char === '\r') {
      column = 0;
      continue;
    }

    if (char === '\n') {
      lines.push('');
      column = 0;
      continue;
    }

    const index = lines.length - 1;
    const line = lines[index];
    lines[index] = line.slice(0, column) + char + line.slice(column + 1);
    column += 1;
  }

  return lines.join('\n');
}

export function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64.replace(/\s/g, ''));
  const chunks: Uint8Array[] = [];
  const chunkSize = 8192;

  for (let offset = 0; offset < binary.length; offset += chunkSize) {
    const slice = binary.slice(offset, offset + chunkSize);
    const bytes = new Uint8Array(slice.length);
    for (let i = 0; i < slice.length; i += 1) {
      bytes[i] = slice.charCodeAt(i);
    }
    chunks.push(bytes);
  }

  return new Blob(chunks, { type: mimeType });
}
