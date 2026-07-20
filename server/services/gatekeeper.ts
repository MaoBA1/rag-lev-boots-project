import fs from 'node:fs/promises';
import path from 'node:path';
import { ChatMessage, generateAnswer, JUDGE_MODEL } from './ollamaService';

const REJECTIONS_LOG_PATH = path.resolve(process.cwd(), 'gatekeeper_rejections.json');

interface UnitVerdict {
  index: number;
  significant: boolean;
}

interface RejectionEntry {
  timestamp: string;
  source: string;
  source_id: string;
  unit: string;
}

const buildGatekeeperPrompt = (units: string[]): string => {
  const pieces = units.map((u, i) => `[${i + 1}] ${u}`).join('\n');

  return `You are a data-quality classifier for a Lev-Boots knowledge base. You will be given a numbered list of messages that together make up one chunk of a Slack conversation thread. For each message, decide whether it is significant: does it contain concrete, verifiable information about Lev-Boots (a specific technical detail, measurement, decision, finding, or safety-relevant fact) that would be useful to someone searching a knowledge base about Lev-Boots?

Use the surrounding messages as context - a short or otherwise ambiguous message is significant if it depends on or reinforces a specific claim made nearby, but not significant if it carries no informational content of its own even in context.

Rules:
- NOT significant: greetings, social acknowledgments, pure status-check questions with no information of their own, or off-topic chatter unrelated to Lev-Boots.
- Significant: any message stating a concrete fact, number, decision, or finding about Lev-Boots technology, engineering, or safety - even if brief.
- Judge every message independently, but let the surrounding messages inform your judgment of each one.

Respond with ONLY a JSON object in this exact shape, no other text, with one
entry per message listed below:
{"verdicts": [{"index": <message number>, "significant": <true or false>}, ...]}

Messages:
${pieces}`;
};

const logRejections = async (
  source: string,
  source_id: string,
  units: string[]
): Promise<void> => {
  const newEntries: RejectionEntry[] = units.map((unit) => ({
    timestamp: new Date().toISOString(),
    source,
    source_id,
    unit,
  }));

  let existing: RejectionEntry[] = [];
  try {
    existing = JSON.parse(await fs.readFile(REJECTIONS_LOG_PATH, 'utf-8'));
  } catch {
    // no log file yet - start fresh
  }

  await fs.writeFile(
    REJECTIONS_LOG_PATH,
    JSON.stringify([...existing, ...newEntries], null, 2),
    'utf-8'
  );
};

export const filterSignificantUnits = async (
  units: string[],
  source: string,
  source_id: string
): Promise<string[]> => {
  if (units.length === 0) return [];

  const messages: ChatMessage[] = [
    { role: 'system', content: buildGatekeeperPrompt(units) },
    { role: 'user', content: 'Classify each message now.' },
  ];

  const raw = await generateAnswer(messages, { model: JUDGE_MODEL, json: true });
  const { verdicts } = JSON.parse(raw) as { verdicts: UnitVerdict[] };
  const significantIndices = new Set(
    verdicts.filter((v) => v.significant).map((v) => v.index)
  );

  const survivors: string[] = [];
  const rejected: string[] = [];

  units.forEach((unit, i) => {
    if (significantIndices.has(i + 1)) {
      survivors.push(unit);
    } else {
      rejected.push(unit);
    }
  });

  if (rejected.length > 0) {
    await logRejections(source, source_id, rejected);
  }

  return survivors;
};
