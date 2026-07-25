import sequelize from '../config/database';
import { LoadedDoc } from './loaders/types';
import { splitIntoParagraphs } from './chunking/splitIntoParagraphs';
import { splitIntoSentences } from './chunking/splitIntoSentences';
import { splitIntoMessages } from './chunking/splitIntoMessages';
import { packIntoChunks } from './chunking/packIntoChunks';
import { packIntoReversibleChunks } from './chunking/packIntoReversibleChunks';
import { embedText } from './llmService';
import { filterSignificantUnits } from './gatekeeper';

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

// Builds the final chunk_content per chunk index. Slack goes through the
// reversible packer + Gatekeeper (a chunk entry is null if every unit in it
// got filtered out); PDF/article use the original packer directly and skip
// the Gatekeeper entirely - see gatekeeper.md for why the two sources are
// treated differently.
const buildChunkContents = async (doc: LoadedDoc, units: string[]): Promise<(string | null)[]> => {
  if (doc.source !== 'slack') {
    return packIntoChunks(units);
  }

  const chunkUnitGroups = packIntoReversibleChunks(units);
  const contents: (string | null)[] = [];

  for (const unitGroup of chunkUnitGroups) {
    const survivingUnits = await filterSignificantUnits(unitGroup, doc.source, doc.source_id);
    contents.push(survivingUnits.length > 0 ? survivingUnits.join(' ') : null);
  }

  return contents;
};

export const storeDoc = async (doc: LoadedDoc): Promise<void> => {
  const split = splitters[doc.source];
  const units = split(doc.text);
  const chunkContents = await buildChunkContents(doc, units);
  const existing = await getExistingChunkIndices(doc.source, doc.source_id);

  let stored = 0;
  let filteredOut = 0;

  for (let i = 0; i < chunkContents.length; i++) {
    if (existing.has(i)) continue;

    const content = chunkContents[i];
    if (content === null) {
      filteredOut++;
      continue;
    }

    const embedding = await embedText(content);
    await insertChunk(doc.source, doc.source_id, i, content, embedding);
    stored++;
  }

  const alreadyExisted = chunkContents.length - stored - filteredOut;
  console.log(
    `[${doc.source}:${doc.source_id}] ${chunkContents.length} chunk(s), ${stored} newly stored, ${alreadyExisted} already existed, ${filteredOut} fully filtered by gatekeeper`
  );
};

export const storeAllDocs = async (docs: LoadedDoc[]): Promise<void> => {
  for (const doc of docs) {
    await storeDoc(doc);
  }
};
