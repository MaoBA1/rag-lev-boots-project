import sequelize from '../config/database';
import { LoadedDoc } from './loaders/types';
import { splitIntoParagraphs } from './chunking/splitIntoParagraphs';
import { splitIntoSentences } from './chunking/splitIntoSentences';
import { splitIntoMessages } from './chunking/splitIntoMessages';
import { packIntoChunks } from './chunking/packIntoChunks';
import { embedText } from './llmService';

const splitters: Record<LoadedDoc['source'], (text: string) => string[]> = {
  pdf: splitIntoSentences,
  article: splitIntoParagraphs,
  slack: splitIntoMessages,
};

const getExistingChunkIndices = async (
  source: string,
  source_id: string
): Promise<Set<number>> => {
  const [rows] = await sequelize.query(
    `SELECT chunk_index FROM knowledge_base WHERE source = :source AND source_id = :source_id`,
    { replacements: { source, source_id } }
  );
  return new Set((rows as { chunk_index: number }[]).map((r) => r.chunk_index));
};

const insertChunk = async (
  source: string,
  source_id: string,
  chunk_index: number,
  chunk_content: string,
  embedding: number[]
): Promise<void> => {
  const vectorLiteral = `[${embedding.join(',')}]`;

  await sequelize.query(
    `INSERT INTO knowledge_base (source, source_id, chunk_index, chunk_content, embeddings_768)
     VALUES (:source, :source_id, :chunk_index, :chunk_content, :embedding::vector)
     ON CONFLICT (source, source_id, chunk_index) DO NOTHING`,
    {
      replacements: {
        source,
        source_id,
        chunk_index,
        chunk_content,
        embedding: vectorLiteral,
      },
    }
  );
};

export const storeDoc = async (doc: LoadedDoc): Promise<void> => {
  const split = splitters[doc.source];
  const units = split(doc.text);
  const chunks = packIntoChunks(units);
  const existing = await getExistingChunkIndices(doc.source, doc.source_id);

  let stored = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (existing.has(i)) continue;

    const embedding = await embedText(chunks[i]);
    await insertChunk(doc.source, doc.source_id, i, chunks[i], embedding);
    stored++;
  }

  console.log(
    `[${doc.source}:${doc.source_id}] ${chunks.length} chunk(s), ${stored} newly stored, ${chunks.length - stored} already existed`
  );
};

export const storeAllDocs = async (docs: LoadedDoc[]): Promise<void> => {
  for (const doc of docs) {
    await storeDoc(doc);
  }
};
