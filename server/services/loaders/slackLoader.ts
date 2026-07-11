import { LoadedDoc } from './types';

const API_BASE = 'https://lev-boots-slack-api.jona-581.workers.dev/';
const CHANNELS = ['lab-notes', 'engineering', 'offtopic'];
const PAGE_DELAY_MS = 350;
const MAX_RETRIES = 8;

interface SlackMessage {
  id: string;
  channel: string;
  user: string;
  role: string;
  ts: string;
  text: string;
  thread_ts: string;
}

interface SlackPage {
  channel: string;
  page: number;
  limit: number;
  total: number;
  items: SlackMessage[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The API rate-limits aggressively (observed a 429 after ~3 rapid sequential
// requests), so we pace requests and back off with increasing delay on 429.
const fetchPage = async (channel: string, page: number): Promise<SlackPage> => {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(`${API_BASE}?channel=${channel}&page=${page}`);

    if (res.status === 429) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Slack API request failed: ${res.status}`);
    }

    return (await res.json()) as SlackPage;
  }

  throw new Error(`Slack API rate limit persisted after ${MAX_RETRIES} retries`);
};

const fetchChannelMessages = async (channel: string): Promise<SlackMessage[]> => {
  const first = await fetchPage(channel, 1);
  const totalPages = Math.ceil(first.total / first.limit);
  const messages = [...first.items];

  for (let page = 2; page <= totalPages; page++) {
    await sleep(PAGE_DELAY_MS);
    const res = await fetchPage(channel, page);
    messages.push(...res.items);
  }

  return messages;
};

export const loadSlackMessages = async (): Promise<LoadedDoc[]> => {
  const allMessages: SlackMessage[] = [];

  for (const channel of CHANNELS) {
    allMessages.push(...(await fetchChannelMessages(channel)));
  }

  // Threads are grouped by thread_ts regardless of channel: replies
  // occasionally cross-post into another channel's thread (see /docs), and
  // message ids (which thread_ts points to) are globally unique anyway.
  const threads = new Map<string, SlackMessage[]>();
  for (const message of allMessages) {
    const thread = threads.get(message.thread_ts) ?? [];
    thread.push(message);
    threads.set(message.thread_ts, thread);
  }

  const docs: LoadedDoc[] = [];
  for (const [threadTs, messages] of threads) {
    const sorted = [...messages].sort((a, b) => a.ts.localeCompare(b.ts));
    const text = sorted
      .map((m) => `${m.user} (${m.role}): ${m.text}`)
      .join('\n');

    docs.push({ source: 'slack', source_id: threadTs, text });
  }

  return docs;
};
