// Run with `pnpm --filter @fs/mobile test` (node's own test runner; this folder's art code is pure TypeScript).
import assert from "node:assert/strict";
import { test } from "node:test";
import { contrast, GROUNDS, hex, LINES } from "./colors.ts";
import { minScrim, worstContrast } from "./contrast.ts";
import { rng } from "./random.ts";
import { type ArtNode, elementCount, type Scene, toSvg } from "./scene.ts";
import { drawArt, pickStyle, STYLE_ORDER, STYLES, type StyleId, styleSet } from "./styles.ts";

const FONTS = { display: "D", mono: "M" };
const SIZES = [
  [390, 506],
  [390, 844],
  [430, 560],
  [320, 400],
] as const;
const SEEDS = Array.from({ length: 30 }, (_, i) => `seed-${i}`);
const input = (seed: string, [width, height]: readonly [number, number]) => ({ width, height, seed, date: "2026-10-05", number: 12 });

function colours(scene: Scene): string[] {
  const out: string[] = [scene.background];
  const walk = (nodes: ArtNode[]) =>
    nodes.forEach((node) => {
      if (node.kind === "group") return walk(node.children);
      for (const p of [node.fill, node.stroke]) if (p && !p.startsWith("url(")) out.push(p);
    });
  walk(scene.nodes);
  scene.defs.forEach((d) => ("stops" in d ? d.stops.forEach((s) => out.push(s.color)) : walk(d.children)));
  return out;
}

test("rng is deterministic for a seed", () => {
  const [a, b] = [rng("x"), rng("x")];
  for (let i = 0; i < 20; i++) assert.equal(a.next(), b.next());
  assert.notEqual(rng("x").next(), rng("y").next());
});

test("each style draws the same picture for the same seed, and a different one for another", () => {
  for (const style of STYLE_ORDER) {
    const one = toSvg(drawArt(style, input("letter-1", SIZES[0])), FONTS);
    assert.equal(toSvg(drawArt(style, input("letter-1", SIZES[0])), FONTS), one, style);
    assert.notEqual(toSvg(drawArt(style, input("letter-2", SIZES[0])), FONTS), one, style);
  }
});

test("scenes stay small: few elements, short SVG", () => {
  for (const style of STYLE_ORDER)
    for (const size of SIZES)
      for (const seed of SEEDS.slice(0, 10)) {
        const scene = drawArt(style, input(seed, size));
        assert.ok(elementCount(scene) <= 40, `${style} draws ${elementCount(scene)} elements`);
        assert.ok(toSvg(scene, FONTS).length < 30_000, `${style} is ${toSvg(scene, FONTS).length} characters`);
      }
});

test("every colour is a valid #RRGGBB", () => {
  for (const style of STYLE_ORDER) for (const seed of SEEDS.slice(0, 5)) for (const c of colours(drawArt(style, input(seed, SIZES[1])))) assert.doesNotThrow(() => hex(c), `${style}: ${c}`);
});

test("text on the art keeps 4.5:1 under each style's scrim, whatever it draws", () => {
  for (const style of STYLE_ORDER) {
    const s = STYLES[style];
    const texts = [s.text.primary, s.text.secondary, s.text.accent];
    for (const seed of SEEDS)
      for (const size of SIZES) {
        const scene = drawArt(style, input(seed, size));
        for (const t of texts) assert.ok(worstContrast(scene, t, s.scrim) >= 4.5, `${style} ${seed}: ${t} at scrim ${s.scrim}`);
        // And the scrim isn't heavier than it needs to be (within 0.05).
        assert.ok(minScrim(scene, texts) <= s.scrim, style);
      }
  }
});

test("every style is quiet: a pale ground, a light scrim and light line tints", () => {
  for (const style of STYLE_ORDER) {
    assert.equal(STYLES[style].tone, "light", style);
    // Scrims are light now that the art is (the old ones were 0.35 to 0.85).
    assert.ok(STYLES[style].scrim <= 0.3, `${style} scrim ${STYLES[style].scrim}`);
    for (const seed of SEEDS.slice(0, 10)) {
      const scene = drawArt(style, input(seed, SIZES[1]));
      // The ground is near-white (or a pale brand tint).
      assert.ok(contrast(hex(scene.background), hex("#FFFFFF")) < 1.3, `${style} ${seed}: ground ${scene.background}`);
    }
  }
  // Line tints are visible on every ground (text over them is checked with each style's scrim above).
  for (const c of LINES) for (const g of GROUNDS) assert.ok(contrast(hex(c), hex(g)) >= 2.5, `${c} on ${g}`);
});

test("variants: a style looks different across seeds (more than one ground or palette)", () => {
  for (const style of STYLE_ORDER) {
    const looks = new Set(SEEDS.map((seed) => colours(drawArt(style, input(seed, SIZES[0]))).sort().join()));
    assert.ok(looks.size >= 2, `${style} has ${looks.size} palette`);
  }
});

test("the pick is random but stable for a seed, and every style is reachable", () => {
  assert.equal(pickStyle({ seed: "letter-a", date: "2026-10-05", sequence: 12 }), pickStyle({ seed: "letter-a", date: "2026-10-05", sequence: 12 }));
  const counts = new Map<StyleId, number>();
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const style = pickStyle({ seed: `letter-${i}`, date: "2026-10-05", sequence: i });
    counts.set(style, (counts.get(style) ?? 0) + 1);
  }
  assert.equal(counts.size, STYLE_ORDER.length, "every style is picked");
  // Roughly even: each within ±35% of its share.
  for (const [style, c] of counts) assert.ok(Math.abs(c / N - 1 / STYLE_ORDER.length) < 0.35 / STYLE_ORDER.length, `${style}: ${c}`);
  // Different letters on the same place in the sequence get different styles.
  assert.ok(new Set(SEEDS.map((seed) => pickStyle({ seed, date: "2026-10-05", sequence: 4 }))).size >= 4);
});

test("consecutive letters, and consecutive days, never share a style", () => {
  assert.deepEqual([...styleSet(0), ...styleSet(1)].sort(), [...STYLE_ORDER].sort());
  assert.equal(styleSet(0).length, styleSet(1).length, "the two sets are the same size");
  for (let n = 1; n < 200; n++) assert.notEqual(pickStyle({ seed: `id-${n}`, date: "2026-10-05", sequence: n }), pickStyle({ seed: `id-${n + 1}`, date: "2026-10-05", sequence: n + 1 }));
  for (let d = 1; d < 31; d++) {
    const [a, b] = [`2026-10-${String(d).padStart(2, "0")}`, `2026-10-${String(d + 1).padStart(2, "0")}`];
    assert.notEqual(pickStyle({ seed: a, date: a }), pickStyle({ seed: b, date: b }));
  }
  // Over the month boundary too.
  assert.notEqual(pickStyle({ seed: "2026-09-30", date: "2026-09-30" }), pickStyle({ seed: "2026-10-01", date: "2026-10-01" }));
});
