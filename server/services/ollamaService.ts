const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

export const EMBEDDING_MODEL = 'nomic-embed-text';
export const GENERATION_MODEL = 'llama3.2';

export const embedText = async (text: string): Promise<number[]> => {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
  });

  if (!res.ok) {
    throw new Error(`Ollama embeddings request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
};

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export const generateAnswer = async (messages: ChatMessage[]): Promise<string> => {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: GENERATION_MODEL, messages, stream: false }),
  });

  if (!res.ok) {
    throw new Error(`Ollama chat request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { message: { role: string; content: string } };
  return data.message.content;
};
