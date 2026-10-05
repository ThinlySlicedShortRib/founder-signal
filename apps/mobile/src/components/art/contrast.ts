import { contrast, hex, over, type Rgb } from "./colors.ts";
import type { ArtNode, Scene } from "./scene.ts";

/**
 * Conservative contrast for text on the art: every colour a scene paints
 * (fills, strokes, gradient stops, grain, text), at its strongest opacity,
 * layered up to two deep over the background, then the scrim on top. The
 * text has to clear the target against all of them, so it clears it
 * wherever it lands.
 */

type Layer = { color: Rgb; alpha: number };

function layers(scene: Scene): Layer[] {
  const out = new Map<string, Layer>();
  const defs = new Map(scene.defs.map((d) => [d.id, d]));
  const add = (color: string, alpha: number) => {
    if (alpha <= 0.01) return;
    const key = `${color}@${alpha.toFixed(2)}`;
    if (!out.has(key)) out.set(key, { color: hex(color), alpha: Math.min(1, alpha) });
  };
  const paint = (value: string | undefined, alpha: number) => {
    if (!value || value === "none") return;
    const ref = /^url\(#(.+)\)$/.exec(value);
    if (!ref) return add(value, alpha);
    const def = defs.get(ref[1]!);
    if (!def) return;
    if (def.kind === "pattern") walk(def.children, alpha);
    else if (def.kind === "radial" || def.kind === "linear") def.stops.forEach((s) => add(s.color, alpha * (s.opacity ?? 1)));
  };
  const walk = (nodes: ArtNode[], alpha: number) => {
    for (const node of nodes) {
      const a = alpha * (node.opacity ?? 1);
      if (node.kind === "group") walk(node.children, a);
      else {
        paint(node.fill, a);
        paint(node.stroke, a);
      }
    }
  };
  walk(scene.nodes, 1);
  return [...out.values()];
}

/** Every colour that can end up behind text, before the scrim. */
export function backdrops(scene: Scene): Rgb[] {
  const ls = layers(scene);
  const all = new Map<string, Rgb>();
  const keep = (c: Rgb) => {
    const key = c.map(Math.round).join(",");
    if (all.has(key)) return false;
    all.set(key, c);
    return true;
  };
  let frontier = [hex(scene.background)].filter(keep);
  for (let depth = 0; depth < 2; depth++) frontier = frontier.flatMap((c) => ls.map((l) => over(l.color, l.alpha, c))).filter(keep);
  return [...all.values()];
}

/** The lowest contrast `text` gets against the scene under a scrim of the scene's background at `scrim`. */
export function worstContrast(scene: Scene, text: string, scrim: number, behind = backdrops(scene)): number {
  const [t, s] = [hex(text), hex(scene.background)];
  return Math.min(...behind.map((b) => contrast(t, over(s, scrim, b))));
}

/** The smallest scrim (to 0.05) that keeps every text colour at `target` or better. */
export function minScrim(scene: Scene, texts: string[], target = 4.5): number {
  const behind = backdrops(scene);
  for (let a = 0; a <= 1.001; a += 0.05) {
    if (texts.every((t) => worstContrast(scene, t, a, behind) >= target)) return Math.round(a * 100) / 100;
  }
  return 1;
}
