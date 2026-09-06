import fs from 'fs/promises';
import path from 'path';
import mammoth from 'mammoth';

type MarkdownMammoth = typeof mammoth & {
  convertToMarkdown(input: { path: string }): Promise<{ value: string }>;
};

export interface ExtractedDocx {
  markdown: string;
  reader_rel_path: string;
  absolute_path: string;
}

export async function extractDocx(
  workspaceRoot: string,
  sourcePath: string,
  documentId: string,
): Promise<ExtractedDocx> {
  const result = await (mammoth as MarkdownMammoth).convertToMarkdown({ path: sourcePath });
  const markdown = result.value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const base = `${path.parse(sourcePath).name}.md`;
  const reader_rel_path = path.posix.join('.lares', 'library', 'derived', documentId, base);
  const absolute_path = path.join(workspaceRoot, ...reader_rel_path.split('/'));
  await fs.mkdir(path.dirname(absolute_path), { recursive: true });
  const temporary = `${absolute_path}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, markdown, 'utf8');
  await fs.rename(temporary, absolute_path);
  return { markdown, reader_rel_path, absolute_path };
}
