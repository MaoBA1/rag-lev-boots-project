import { ask } from '../../services/ragService';

export default async (question: string) => {
  try {
    const answer = await ask(question);
    return { content: [{ type: 'text' as const, text: answer }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: 'error in retrieval' }] };
  }
};
