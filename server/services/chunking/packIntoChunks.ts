export const packIntoChunks = (
  units: string[],
  min = 200,
  max = 400
): string[] => {
  const chunks: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length > 0) {
      chunks.push(buffer.join(' '));
      buffer = [];
    }
  };

  for (const unit of units) {
    const words = unit.trim().split(/\s+/).filter(Boolean);
    buffer.push(...words);

    while (buffer.length > max) {
      chunks.push(buffer.slice(0, max).join(' '));
      buffer = buffer.slice(max);
    }

    if (buffer.length >= min) {
      flush();
    }
  }

  flush();

  return chunks;
};
