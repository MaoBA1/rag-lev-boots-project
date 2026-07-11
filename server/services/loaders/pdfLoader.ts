import { readFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { LoadedDoc } from './types';

// pdf-parse v2+ ships a rewritten class-based API; we pin 1.1.1 (see
// package.json) for the classic function-based one, which has no ESM types.
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDF_DIR = path.resolve(__dirname, '../../knowledge_pdfs');

export const loadPdfs = async (): Promise<LoadedDoc[]> => {
  const filenames = (await readdir(PDF_DIR)).filter((f) =>
    f.toLowerCase().endsWith('.pdf')
  );

  const docs: LoadedDoc[] = [];

  for (const filename of filenames) {
    const buffer = await readFile(path.join(PDF_DIR, filename));
    const { text } = await pdfParse(buffer);
    const source_id = filename.replace(/\.pdf$/i, '');

    docs.push({ source: 'pdf', source_id, text });
  }

  return docs;
};
