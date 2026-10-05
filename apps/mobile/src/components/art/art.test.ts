// Run with `pnpm --filter @fs/mobile test` (node's own test runner; this folder's art code is pure TypeScript).
import assert from "node:assert/strict";
import { test } from "node:test";
import { hex } from "./colors.ts";
import { minScrim, worstContrast } from "./contrast.ts";
import { rng } from "./random.ts";
import { type ArtNode, elementCount, type Scene, toSvg } from "./scene.ts";
import { drawArt, STYLE_ORDER, STYLES, styleForDay } from "./styles.ts";

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
        assert.ok(elementCount(scene) <= 60, `${style} draws ${elementCount(scene)} elements`);
        assert.ok(toSvg(scene, FONTS).length < 60_000, `${style} is ${toSvg(scene, FONTS).length} characters`);
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

test("the day picks the style, and two days running never share one", () => {
  assert.equal(styleForDay("2026-10-05"), styleForDay("2026-10-05"));
  let prev = styleForDay("2026-09-30");
  for (let d = 1; d <= 31; d++) {
    const day = styleForDay(`2026-10-${String(d).padStart(2, "0")}`);
    assert.notEqual(day, prev);
    prev = day;
  }
});
