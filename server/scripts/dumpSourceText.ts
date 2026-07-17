// Temp/throwaway script for RAGAS prep — dumps raw article + slack thread text
// to local files so they can be handed to an LLM chat for ground-truth Q&A
// generation. Not part of the main loadAllData pipeline.

import fs from 'node:fs';
import path from 'node:path';
import { loadArticles } from '../services/loaders/articleLoader';
import { loadSlackMessages } from '../services/loaders/slackLoader';
import { LoadedDoc } from '../services/loaders/types';

const ARTICLES_DIR = path.resolve(process.cwd(), 'articles_dump');
const SLACK_DIR = path.resolve(process.cwd(), 'slack_dump');

const writeDocs = (dir: string, docs: LoadedDoc[], ext: string) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const doc of docs) {
    const safeName = doc.source_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    fs.writeFileSync(path.join(dir, `${safeName}.${ext}`), doc.text, 'utf-8');
  }
};

const main = async () => {
  console.log('Fetching articles...');
  const articles = await loadArticles();
  writeDocs(ARTICLES_DIR, articles, 'md');
  console.log(`Wrote ${articles.length} article files to ${ARTICLES_DIR}`);

  console.log('Fetching slack messages (paginated, rate-limited — this takes a bit)...');
  const slackThreads = await loadSlackMessages();
  writeDocs(SLACK_DIR, slackThreads, 'txt');
  console.log(`Wrote ${slackThreads.length} slack thread files to ${SLACK_DIR}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
