// Run with `pnpm --filter @fs/mobile test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type LineInput, pickFocus, readingLine, toGeo } from "./focus-math.ts";

// Ten 100px paragraphs with 18px gaps, from 200.
const geo = toGeo(Array.from({ length: 10 }, (_, i) => ({ index: i, top: 200 + i * 118, height: 100 })));

test("pickFocus: the block under the line, the nearer one in a gap, clamped at the ends", () => {
  assert.equal(pickFocus(geo, 250), 0);
  assert.equal(pickFocus(geo, 330), 1);
  assert.equal(pickFocus(geo, 302), 0); // gap 300–318: nearer the first
  assert.equal(pickFocus(geo, 312), 1);
  assert.equal(pickFocus(geo, 0), 0);
  assert.equal(pickFocus(geo, 99_999), 9);
  assert.equal(pickFocus(toGeo([]), 100), -1);
});

test("toGeo sorts by top and drops unmeasured blocks", () => {
  const g = toGeo([
    { index: 3, top: 500, height: 40 },
    { index: 1, top: 100, height: 40 },
    { index: 2, top: 300, height: 0 },
  ]);
  assert.deepEqual(g, { idx: [1, 3], top: [100, 500], bottom: [140, 540] });
});

const base: LineInput = { y: 1000, viewH: 800, contentH: 4000, headerBottom: 100, startY: 0, firstMid: 250, lastMid: 3000 };

test("readingLine: 38% down the viewport mid-article", () => {
  assert.equal(readingLine(base), 1000 + 800 * 0.38);
});

test("readingLine: never above the bar", () => {
  assert.equal(readingLine({ ...base, headerBottom: 400 }), 1000 + 424);
});

test("readingLine: at the bottom of the scroll it reaches the last block", () => {
  const maxY = 4000 - 800;
  const lastMid = maxY + 700; // well below the usual line, above the end card
  assert.equal(readingLine({ ...base, y: maxY, lastMid }), lastMid);
  // Half a screen earlier it's still the usual line; in between it moves steadily.
  assert.equal(readingLine({ ...base, y: maxY - 400, lastMid }), maxY - 400 + 304);
  const mid = readingLine({ ...base, y: maxY - 200, lastMid });
  assert.ok(mid > maxY - 200 + 304 && mid < lastMid);
});

test("readingLine: at the start of the article it begins on the first block", () => {
  const firstMid = 150;
  assert.equal(readingLine({ ...base, y: 0, firstMid }), firstMid);
  // A first block below the line needs no help.
  assert.equal(readingLine({ ...base, y: 0, firstMid: 600 }), 304);
});

test("every block comes into focus over a full scroll", () => {
  const contentH = 200 + 10 * 118 + 600; // an end card below the last paragraph
  const viewH = 800;
  const seen = new Set<number>();
  for (let y = 0; y <= contentH - viewH; y += 4) {
    const line = readingLine({ y, viewH, contentH, headerBottom: 100, startY: 0, firstMid: 250, lastMid: 200 + 9 * 118 + 50 });
    seen.add(pickFocus(geo, line));
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
