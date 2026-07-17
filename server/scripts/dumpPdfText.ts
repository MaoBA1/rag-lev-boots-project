// Temp/throwaway script — extracts plain text from the 3 PDFs so it can be
// grepped for RAGAS ground-truth quote validation. Not part of the main pipeline.

import fs from 'node:fs';
import path from 'node:path';
import { loadPdfs } from '../services/loaders/pdfLoader';

const OUT_DIR = path.resolve(process.cwd(), 'pdf_text_dump');

const main = async () => {
  const pdfs = await loadPdfs();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const doc of pdfs) {
    const safeName = doc.source_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    fs.writeFileSync(path.join(OUT_DIR, `${safeName}.txt`), doc.text, 'utf-8');
  }
  console.log(`Wrote ${pdfs.length} PDF text files to ${OUT_DIR}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
