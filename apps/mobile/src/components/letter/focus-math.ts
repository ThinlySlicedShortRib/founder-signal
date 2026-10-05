// The geometry behind the reader's focus highlight. Pure functions, run as worklets on the UI
// thread on every scroll frame (and from node's test runner: the directive is only a string there).

/** The focusable blocks, sorted by `top`; offsets within the article. */
export type FocusGeo = { idx: number[]; top: number[]; bottom: number[] };

export const EMPTY_GEO: FocusGeo = { idx: [], top: [], bottom: [] };

/** Where the reading line sits in the viewport: 38% down, but never above the bar's bottom + 24. */
export const LINE_AT = 0.38;

export type LineInput = {
  /** The scroll offset. */
  y: number;
  viewH: number;
  contentH: number;
  /** The bottom of whatever covers the top of the scroll (the bar or the shrinking photo header). */
  headerBottom: number;
  /** The offset at which the article's top reaches the header (0 without a lead). */
  startY: number;
  /** The middles of the first and last focusable blocks, in content offsets. */
  firstMid: number;
  lastMid: number;
};

/**
 * The reading line, in content offsets. Mostly a fixed line in the viewport; over the first and
 * last half-screen of scrolling it eases towards the first / last block, so the opening
 * paragraphs and the ones that never scroll as far as the line (above the end card) still
 * come into focus in turn.
 */
export function readingLine({ y, viewH, contentH, headerBottom, startY, firstMid, lastMid }: LineInput): number {
  "worklet";
  const base = Math.max(headerBottom + 24, viewH * LINE_AT);
  const range = Math.max(1, viewH * 0.5);
  const maxY = Math.max(0, contentH - viewH);
  let line = y + base;
  const towardsEnd = Math.min(1, Math.max(0, 1 - (maxY - y) / range));
  line += towardsEnd * Math.max(0, lastMid - (maxY + base));
  const towardsStart = Math.min(1, Math.max(0, 1 - (y - startY) / range));
  line -= towardsStart * Math.max(0, startY + base - firstMid);
  return line;
}

/** The block under the line, or the nearer one when the line is in a gap. -1 with no blocks. */
export function pickFocus(geo: FocusGeo, line: number): number {
  "worklet";
  const n = geo.top.length;
  if (n === 0) return -1;
  // The last block that starts at or above the line.
  let lo = 0;
  let hi = n - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (geo.top[mid]! <= line) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (at < 0) return geo.idx[0]!;
  if (line <= geo.bottom[at]! || at === n - 1) return geo.idx[at]!;
  return line - geo.bottom[at]! <= geo.top[at + 1]! - line ? geo.idx[at]! : geo.idx[at + 1]!;
}

/** Measurements (any order, possibly overlapping) to a sorted geometry. */
export function toGeo(blocks: { index: number; top: number; height: number }[]): FocusGeo {
  const sorted = blocks.filter((b) => b.height > 0).sort((a, b) => a.top - b.top || a.index - b.index);
  return { idx: sorted.map((b) => b.index), top: sorted.map((b) => b.top), bottom: sorted.map((b) => b.top + b.height) };
}
