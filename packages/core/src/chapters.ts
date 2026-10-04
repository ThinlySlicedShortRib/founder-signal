/**
 * Splits a video transcript into reader chapters: 4 to 8, about three
 * minutes each, cut at caption boundaries. Titles are the chapter's own
 * opening words, so nothing is invented.
 */

export interface TimedSegment {
  text: string;
  offsetMs: number;
  durationMs: number;
}

export interface Chapter {
  startSeconds: number;
  title: string;
  text: string;
}

const TARGET_CHAPTER_SECONDS = 180;
const TITLE_MAX_CHARS = 48;

export function chapterTitle(text: string): string {
  const first = (text.match(/^[^.!?…]+/)?.[0] ?? text).replace(/^(so|and|but|okay|ok|um|uh|well|right)[,\s]+/i, "").trim();
  if (first.length <= TITLE_MAX_CHARS) return capitalize(first);
  const cut = first.slice(0, TITLE_MAX_CHARS);
  return `${capitalize(cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : TITLE_MAX_CHARS))}…`;
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function splitChapters(segments: TimedSegment[], { min = 4, max = 8 } = {}): Chapter[] {
  const segs = segments.filter((s) => s.text.trim());
  if (!segs.length) return [];
  const end = Math.max(...segs.map((s) => s.offsetMs + s.durationMs));
  const target = Math.min(max, Math.max(min, Math.round(end / 1000 / TARGET_CHAPTER_SECONDS)));
  const count = Math.min(target, segs.length);
  const span = end / count;

  const chapters: TimedSegment[][] = [];
  for (const s of segs) {
    const index = Math.min(count - 1, Math.floor(s.offsetMs / span));
    // Never go back a chapter; a late caption joins the current one.
    const at = Math.max(index, chapters.length - 1);
    (chapters[at] ??= []).push(s);
  }
  return chapters
    .filter((c) => c?.length)
    .map((c) => {
      const text = c.map((s) => s.text.trim()).join(" ").replace(/\s+/g, " ");
      return { startSeconds: Math.floor(c[0]!.offsetMs / 1000), title: chapterTitle(text), text };
    });
}
