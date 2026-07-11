// pdf-parse gives no reliable paragraph signal (single \n for both line-wraps
// and real breaks, double \n only at page boundaries, sometimes mid-word) -
// see /docs. So for PDFs we fall back to sentence boundaries, which we can
// detect reliably from punctuation instead.
export const splitIntoSentences = (text: string): string[] => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const sentences: string[] = [];
  let start = 0;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    const prevChar = normalized[i - 1];
    const nextChar = normalized[i + 1];
    const isDecimal = ch === '.' && /\d/.test(prevChar) && /\d/.test(nextChar);
    const boundary =
      nextChar === undefined ||
      (nextChar === ' ' && /[A-Z0-9]/.test(normalized[i + 2] ?? ''));

    if (!isDecimal && boundary) {
      sentences.push(normalized.slice(start, i + 1).trim());
      start = i + 1;
    }
  }

  const rest = normalized.slice(start).trim();
  if (rest) sentences.push(rest);

  return sentences.filter(Boolean);
};
