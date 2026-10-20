import { C, LINES } from "./colors.ts";
import type { Rng } from "./random.ts";
import { type ArtNode, grain, n, polygonD, type Scene } from "./scene.ts";
import type { ArtInput } from "./styles.ts";

/** The letter's number, or the day of the month before there is one. */
function numeral({ number, date }: ArtInput): string {
  return String(number ?? Number(date.slice(8, 10)));
}

/** Letterhead: paper with a faint watermark (a seal, or the letter's number) and a fine double rule. */
export function letterhead(r: Rng, input: ArtInput): Scene {
  const { width: w, height: h } = input;
  const ground = r.pick([C.paper, C.paper, C.ground]);
  const ink = r.pick(LINES);
  const ruleY = h * r.range(0.2, 0.26);
  const mark = { x: w * r.range(0.55, 0.72), y: h * r.range(0.4, 0.5), r: Math.min(w, h) * r.range(0.3, 0.38) };
  const nodes: ArtNode[] = [];
  if (r.chance(0.5)) {
    // A seal: two rings, a ring of fine ticks and "FS" in the middle.
    let ticks = "";
    for (let i = 0; i < 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      const [c, s] = [Math.cos(t), Math.sin(t)];
      ticks += `M${n(mark.x + c * mark.r * 0.84)} ${n(mark.y + s * mark.r * 0.84)}L${n(mark.x + c * mark.r * 0.9)} ${n(mark.y + s * mark.r * 0.9)}`;
    }
    nodes.push({
      kind: "group",
      opacity: 0.22,
      children: [
        { kind: "circle", cx: mark.x, cy: mark.y, r: mark.r, stroke: ink, strokeWidth: 1.4 },
        { kind: "circle", cx: mark.x, cy: mark.y, r: mark.r * 0.76, stroke: ink, strokeWidth: 0.8 },
        { kind: "path", d: ticks, stroke: ink, strokeWidth: 0.8 },
        { kind: "text", x: mark.x, y: mark.y + mark.r * 0.2, text: "FS", size: mark.r * 0.6, font: "display", anchor: "middle", spacing: -mark.r * 0.02, fill: ink },
      ],
    });
  } else {
    nodes.push({ kind: "text", x: mark.x, y: mark.y + mark.r * 0.45, text: numeral(input), size: mark.r * 1.5, font: "display", anchor: "middle", spacing: -mark.r * 0.06, fill: ink, opacity: 0.16 });
  }
  // The double rule, with a small orange diamond where it breaks.
  const mid = w * r.pick([0.5, 0.18, 0.82]);
  nodes.push(
    { kind: "path", d: `M20 ${n(ruleY)}H${n(mid - 10)}M${n(mid + 10)} ${n(ruleY)}H${n(w - 20)}`, stroke: ink, strokeWidth: 0.8, opacity: 0.8 },
    { kind: "path", d: `M20 ${n(ruleY + 4)}H${n(mid - 10)}M${n(mid + 10)} ${n(ruleY + 4)}H${n(w - 20)}`, stroke: ink, strokeWidth: 0.4, opacity: 0.7 },
    { kind: "path", d: polygonD([[mid, ruleY - 2.5], [mid + 4.5, ruleY + 2], [mid, ruleY + 6.5], [mid - 4.5, ruleY + 2]]), fill: C.orange, opacity: 0.45 },
  );
  return { width: w, height: h, background: ground, defs: [grain(r, "grain", C.ink, 70)], nodes: [...nodes, { kind: "rect", x: 0, y: 0, w, h, fill: "url(#grain)", opacity: 0.06 }] };
}
