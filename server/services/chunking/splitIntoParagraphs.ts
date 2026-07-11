const LIST_ITEM_RE = /^\s*([-*+]|\d+\.)\s+/;

const isListBlock = (block: string): boolean => {
  const lines = block.split('\n').filter((line) => line.trim().length > 0);
  return lines.length > 1 && lines.every((line) => LIST_ITEM_RE.test(line));
};

export const splitIntoParagraphs = (markdown: string): string[] => {
  const blocks = markdown
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  const paragraphs: string[] = [];

  for (const block of blocks) {
    if (isListBlock(block)) {
      paragraphs.push(
        ...block
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      );
    } else {
      paragraphs.push(block);
    }
  }

  return paragraphs;
};
