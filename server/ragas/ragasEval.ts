import fs from 'node:fs';
import path from 'node:path';
import { ask } from '../services/ragService';
import { judgeAnswer } from './judge';

interface GroundTruthItem {
  question: string;
  answer: string;
  supportingQuotes: string[];
}

interface EvalItem {
  question: string;
  groundTruthAnswer: string;
  generatedAnswer: string;
  evaluationScore: number;
  justificationForScore: string;
}

const RAGAS_DIR = path.resolve(process.cwd(), 'ragas');
const GROUND_TRUTH_PATH = path.join(RAGAS_DIR, 'ground-truth.json');
const LOGS_DIR = path.join(RAGAS_DIR, 'logs');

const runEval = async (): Promise<void> => {
  const groundTruth: GroundTruthItem[] = JSON.parse(
    fs.readFileSync(GROUND_TRUTH_PATH, 'utf-8')
  );

  const groundTruthEval: EvalItem[] = [];

  for (let i = 0; i < groundTruth.length; i++) {
    const { question, answer, supportingQuotes } = groundTruth[i];
    console.log(`[${i + 1}/${groundTruth.length}] ${question}`);

    const generatedAnswer = await ask(question);
    const { score, justification } = await judgeAnswer(
      question,
      answer,
      supportingQuotes,
      generatedAnswer
    );

    console.log(`  score: ${score}/10 — ${justification}`);

    groundTruthEval.push({
      question,
      groundTruthAnswer: answer,
      generatedAnswer,
      evaluationScore: score,
      justificationForScore: justification,
    });
  }

  const quality =
    (groundTruthEval.reduce((sum, item) => sum + item.evaluationScore, 0) /
      groundTruthEval.length) *
    10;

  console.log(`\nOverall quality: ${quality.toFixed(1)}/100`);

  const label = process.argv[2] ?? `run-${Date.now()}`;
  const logPath = path.join(LOGS_DIR, `${label}.json`);

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(
    logPath,
    JSON.stringify(
      { timestamp: new Date().toISOString(), groundTruthEval, quality },
      null,
      2
    ),
    'utf-8'
  );

  console.log(`Log written to ${logPath}`);
};

runEval().catch((err) => {
  console.error(err);
  process.exit(1);
});
