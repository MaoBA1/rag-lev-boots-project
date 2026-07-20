import { listKnowledgeSources } from '../../services/ragService';

export default async () => {
  try {
    const sources = await listKnowledgeSources();
    return { content: [{ type: 'text' as const, text: JSON.stringify(sources) }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: 'error listing knowledge sources' }] };
  }
};
