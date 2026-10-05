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

/**
 * The link to an item's original: its canonical URL, unless that's a
 * synthetic key (a newsletter that arrived by email with no web version is
 * `newsletter://<hash>`), which has nothing to open.
 */
export function originalUrlOf(canonicalUrl: string): string | null {
  return /^https?:\/\//i.test(canonicalUrl) ? canonicalUrl : null;
}
