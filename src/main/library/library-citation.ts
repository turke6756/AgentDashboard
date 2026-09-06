import path from 'path';
import type { LibraryChunkLocatorV1, LibraryDocumentType } from '../../shared/library';

export interface LibraryCitationInput {
  title: string;
  type: LibraryDocumentType;
  source_rel_path: string;
  locator: LibraryChunkLocatorV1;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

function portablePath(value: string): string {
  return singleLine(value).split(path.sep).join('/').replace(/\\/g, '/');
}

/** The sole citation formatter shared by query, IPC, and agent projections. */
export function formatLibraryCitation(input: LibraryCitationInput): string {
  if (input.locator.kind === 'pdf') {
    return `${singleLine(input.title)}, p.${input.locator.page_number}`;
  }
  const sourcePath = portablePath(input.source_rel_path);
  if (input.type === 'docx' || input.locator.kind === 'docx-markdown') {
    return `${sourcePath}:converted ${input.locator.line_start}-${input.locator.line_end}`;
  }
  return `${sourcePath}:${input.locator.line_start}-${input.locator.line_end}`;
}
