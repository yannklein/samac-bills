import { extractText, getDocumentProxy } from 'unpdf';

/** Extract plain text from a PDF buffer, pages joined by newlines. */
export async function pdfText(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}
