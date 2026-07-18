// Make sure you've reviewd the README.md file to understand the task and the RAG flow

import sequelize from '../config/database';
import { loadPdfs } from './loaders/pdfLoader';
import { loadArticles } from './loaders/articleLoader';
import { loadSlackMessages } from './loaders/slackLoader';
import { storeAllDocs } from './knowledgeBaseStore';
import { embedText, generateAnswer, ChatMessage } from './ollamaService';

const TOP_K = 5;
const DISTANCE_THRESHOLD = 0.46;
const NO_DATA_MESSAGE =
  "I don't have any information about that in the Lev-Boots knowledge base.";

interface RetrievedChunk {
  source: string;
  source_id: string;
  chunk_content: string;
}

export const loadAllData = async () => {
  const [pdfDocs, articleDocs, slackDocs] = await Promise.all([
    loadPdfs(),
    loadArticles(),
    loadSlackMessages(),
  ]);

  await storeAllDocs([...pdfDocs, ...articleDocs, ...slackDocs]);
};

const retrieveRelevantChunks = async (
  questionEmbedding: number[]
): Promise<RetrievedChunk[]> => {
  const vectorLiteral = `[${questionEmbedding.join(',')}]`;

  const [rows] = await sequelize.query(
    `SELECT source, source_id, chunk_content
     FROM knowledge_base
     WHERE embeddings_768 <=> :embedding::vector < :threshold
     ORDER BY embeddings_768 <=> :embedding::vector
     LIMIT :topK`,
    {
      replacements: {
        embedding: vectorLiteral,
        threshold: DISTANCE_THRESHOLD,
        topK: TOP_K,
      },
    }
  );

  return rows as RetrievedChunk[];
};

const buildSystemPrompt = (chunks: RetrievedChunk[]): string => {
  const context = chunks
    .map(
      (c, i) =>
        `[${i + 1}] (source: ${c.source}, id: ${c.source_id})\n${c.chunk_content}`
    )
    .join('\n\n');

  return `You are a knowledge assistant for Lev-Boots, a personal gravity-reversal levitation device. Answer the user's question using ONLY the context chunks provided below, which were retrieved from an internal knowledge base (technical PDFs, published articles, and internal team Slack discussions).

Rules:
- Base your answer strictly on the provided context. Do not use any outside knowledge, assumptions, or general knowledge about physics, levitation technology, or similar products.
- If the provided context does not contain enough information to answer the question, respond with exactly: "I don't have enough information in the knowledge base to answer that question." Do not guess, speculate, or partially answer from incomplete context.
- Be concise and factual. Do not mention "the context," "chunks," or that you were given retrieved material - just answer naturally, as if this is what you know.

Context:
${context}`;
};

export interface AskResult {
  answer: string;
  retrievedChunks: RetrievedChunk[];
}

export const askWithContext = async (userQuestion: string): Promise<AskResult> => {
  const questionEmbedding = await embedText(userQuestion);
  const chunks = await retrieveRelevantChunks(questionEmbedding);

  if (chunks.length === 0) {
    return { answer: NO_DATA_MESSAGE, retrievedChunks: [] };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(chunks) },
    { role: 'user', content: userQuestion },
  ];

  const answer = await generateAnswer(messages);
  return { answer, retrievedChunks: chunks };
};

export const ask = async (userQuestion: string): Promise<string> => {
  const { answer } = await askWithContext(userQuestion);
  return answer;
};
