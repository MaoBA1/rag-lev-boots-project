// Slack-only variant of packIntoChunks. Returns one array of constituent
// unit strings per chunk (not pre-joined), so the Gatekeeper can judge each
// unit individually before deciding on the final chunk_content. Units are
// never split across chunks - unlike packIntoChunks, which enforces `max` by
// slicing a unit's words if needed, this only enforces `min`; a chunk may
// exceed a typical size if the unit that pushed it over min was itself
// large. This is safe for Slack specifically since messages are always
// short (~20-50 words - see load-data.md), so that never actually happens in
// practice. It is not used for PDFs/articles, since an oversized paragraph
// could otherwise produce a very large, unfocused chunk - see
// gatekeeper.md for the full reasoning.
export const packIntoReversibleChunks = (units: string[], min = 200): string[][] => {
  const chunks: string[][] = [];
  let buffer: string[] = [];
  let bufferWordCount = 0;

  const flush = () => {
    if (buffer.length > 0) {
      chunks.push(buffer);
      buffer = [];
      bufferWordCount = 0;
    }
  };

  for (const unit of units) {
    const trimmedUnit = unit.trim();
    const wordCount = trimmedUnit.split(/\s+/).filter(Boolean).length;

    buffer.push(trimmedUnit);
    bufferWordCount += wordCount;

    if (bufferWordCount >= min) {
      flush();
    }
  }

  flush();

  return chunks;
};
