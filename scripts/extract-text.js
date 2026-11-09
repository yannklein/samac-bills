// Usage: node scripts/extract-text.js <pdf>  -> prints the text the app sees
import { readFile } from 'node:fs/promises';
import { pdfText } from '../src/pdf.js';
console.log(await pdfText(await readFile(process.argv[2])));
