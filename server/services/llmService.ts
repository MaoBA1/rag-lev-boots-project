const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const FREELLMAPI_BASE_URL = process.env.FREELLMAPI_BASE_URL || 'http://127.0.0.1:3001';
const FREELLMAPI_API_KEY = process.env.FREELLMAPI_API_KEY;

// Embeddings stay on local Ollama - freeLLMAPI has no embedding model
// configured yet, and switching would mean every stored chunk needs
// re-embedding (a different model's vectors are never comparable to
// nomic-embed-text's, regardless of quality).
export const EMBEDDING_MODEL = 'nomic-embed-text';

// Chat/generation and judging go through freeLLMAPI (an OpenAI-compatible
// proxy stacking several free-tier providers behind one endpoint).
export const GENERATION_MODEL = 'nemotron-nano-9b-v2';
export const JUDGE_MODEL = 'gpt-oss-120b';

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

export interface GenerateOptions {
  model?: string;
  json?: boolean;
  temperature?: number;
}

export const generateAnswer = async (
  messages: ChatMessage[],
  options: GenerateOptions = {}
): Promise<string> => {
  const { model = GENERATION_MODEL, json = false, temperature = 0 } = options;

  const res = await fetch(`${FREELLMAPI_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FREELLMAPI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`FreeLLMAPI chat request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices: { message: { role: string; content: string } }[];
  };
  return data.choices[0].message.content;
};
