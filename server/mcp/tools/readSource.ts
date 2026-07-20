import { readSource } from '../../services/ragService';

export default async (sourceName: string, sourceType?: 'pdf' | 'article') => {
  try {
    const text = await readSource(sourceName, sourceType);
    return { content: [{ type: 'text' as const, text }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `error reading source "${sourceName}"` }] };
  }
};
