/** Average adult silent reading speed for non-fiction. */
const WORDS_PER_MINUTE = 230;

export function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return matches?.length ?? 0;
}

/** Minutes to read, rounded up, never less than 1. */
export function readTimeMinutes(wordCount: number): number {
  return Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE));
}
