import { generateAnswer, ChatMessage, JUDGE_MODEL } from '../services/llmService';

export interface JudgeResult {
  score: number;
  justification: string;
}

const buildJudgePrompt = (
  question: string,
  groundTruthAnswer: string,
  supportingQuotes: string[],
  generatedAnswer: string
): string => `You are grading the output of a RAG (Retrieval-Augmented Generation) system. You will be given a question, a verified ground-truth answer with supporting quotes from the source material, and the answer the RAG system actually generated. Score how well the generated answer matches the ground truth on a scale of 1-10.

Scoring rubric:
- 10: Fully correct — all key facts from the ground truth are present and accurate.
- 7-9: Correct, but missing a minor detail or worded very differently from the ground truth.
- 4-6: Partially correct — missing a significant fact, or contains a minor inaccuracy.
- 1-3: Wrong, contradicts the ground truth, or fails to actually answer the question.

Use the supporting quotes to check specific facts (numbers, names, conditions) in the generated answer, not just whether it "sounds similar" to the ground truth.

Respond with ONLY a JSON object in this exact shape, no other text:
{"score": <integer 1-10>, "justification": "<one sentence explaining the score>"}

Question:
${question}

Ground-truth answer:
${groundTruthAnswer}

Supporting quotes:
${supportingQuotes.map((q) => `- ${q}`).join('\n')}

Generated answer to grade:
${generatedAnswer}`;

export const judgeAnswer = async (
  question: string,
  groundTruthAnswer: string,
  supportingQuotes: string[],
  generatedAnswer: string
): Promise<JudgeResult> => {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildJudgePrompt(question, groundTruthAnswer, supportingQuotes, generatedAnswer),
    },
    { role: 'user', content: 'Grade the generated answer now.' },
  ];

  const raw = await generateAnswer(messages, { model: JUDGE_MODEL, json: true });
  const parsed = JSON.parse(raw) as { score: number; justification: string };

  return { score: parsed.score, justification: parsed.justification };
};
