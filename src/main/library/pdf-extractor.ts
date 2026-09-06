import fs from 'fs/promises';
import { PDFiumLibrary } from '@hyzyla/pdfium';

export interface ExtractedPdfPage {
  page_index: number;
  text: string;
}

export interface ExtractedPdf {
  pages: ExtractedPdfPage[];
  page_count: number;
}

export async function extractPdfBytes(bytes: Uint8Array): Promise<ExtractedPdf> {
  const library = await PDFiumLibrary.init();
  const document = await library.loadDocument(bytes);
  try {
    const pages: ExtractedPdfPage[] = [];
    for (let page_index = 0; page_index < document.getPageCount(); page_index += 1) {
      pages.push({ page_index, text: document.getPage(page_index).getText() });
    }
    return { pages, page_count: document.getPageCount() };
  } finally {
    document.destroy();
    library.destroy();
  }
}

export async function extractPdf(filePath: string): Promise<ExtractedPdf> {
  return extractPdfBytes(await fs.readFile(filePath));
}
