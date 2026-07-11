// Make sure you've reviewd the README.md file to understand the task and the RAG flow

import { loadPdfs } from './loaders/pdfLoader';
import { loadArticles } from './loaders/articleLoader';
import { loadSlackMessages } from './loaders/slackLoader';
import { storeAllDocs } from './knowledgeBaseStore';

export const loadAllData = async () => {
  const [pdfDocs, articleDocs, slackDocs] = await Promise.all([
    loadPdfs(),
    loadArticles(),
    loadSlackMessages(),
  ]);

  await storeAllDocs([...pdfDocs, ...articleDocs, ...slackDocs]);
};

export const ask = async (userQuestion: string): Promise<string> => {
  const placeholderAnswer = `Generate the answer based off the ${userQuestion}`;

  return placeholderAnswer;
};
