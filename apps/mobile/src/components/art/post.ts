import { C } from "./colors.ts";
import type { Rng } from "./random.ts";
import { type ArtNode, circleD, grain, n, polygonD, type Scene } from "./scene.ts";
import type { ArtInput } from "./styles.ts";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** "05 OCT 26" from "2026-10-05". */
function stampDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d} ${MONTHS[Number(m) - 1] ?? ""} ${y?.slice(2) ?? ""}`;
}

/** The letter's number, or the day of the month before there is one. */
function numeral({ number, date }: ArtInput): string {
  return String(number ?? Number(date.slice(8, 10)));
}

/** Wavy cancellation lines, as one path of quadratic waves. */
function waves(x0: number, x1: number, cy: number, lines: number, gap: number, amp: number, wavelength: number): string {
  let d = "";
  const half = wavelength / 2;
  for (let i = 0; i < lines; i++) {
    const y = cy + (i - (lines - 1) / 2) * gap;
    d += `M${n(x0)} ${n(y)}q${n(half / 2)} ${n(-amp)} ${n(half)} 0`;
    for (let x = x0 + half; x < x1; x += half) d += `t${n(half)} 0`;
  }
  return d;
}

/** A perforated stamp: the paper, then holes punched along its edges in the ground's colour. */
function perforated(x: number, y: number, w: number, h: number, paper: string, ground: string): ArtNode[] {
  const hole = 3.2;
  const pitch = 10;
  let d = "";
  for (let i = 0; i <= Math.round(w / pitch); i++) d += circleD(x + (i * w) / Math.round(w / pitch), y, hole) + circleD(x + (i * w) / Math.round(w / pitch), y + h, hole);
  for (let i = 1; i < Math.round(h / pitch); i++) d += circleD(x, y + (i * h) / Math.round(h / pitch), hole) + circleD(x + w, y + (i * h) / Math.round(h / pitch), hole);
  return [
    { kind: "rect", x, y, w, h, fill: paper },
    { kind: "path", d, fill: ground },
  ];
}

/** A round date stamp: two rings, the post office's name, the date and the letter's number. */
function dateStamp(cx: number, cy: number, rad: number, color: string, input: ArtInput): ArtNode[] {
  return [
    { kind: "circle", cx, cy, r: rad, stroke: color, strokeWidth: 2.4 },
    { kind: "circle", cx, cy, r: rad * 0.8, stroke: color, strokeWidth: 1.1 },
    { kind: "text", x: cx, y: cy - rad * 0.36, text: "FOUNDER SIGNAL", size: rad * 0.12, font: "mono", anchor: "middle", spacing: 1.2, fill: color },
    { kind: "text", x: cx, y: cy + rad * 0.1, text: stampDate(input.date), size: rad * 0.22, font: "mono", anchor: "middle", fill: color },
    { kind: "text", x: cx, y: cy + rad * 0.5, text: `NO. ${numeral(input)}`, size: rad * 0.14, font: "mono", anchor: "middle", spacing: 1.2, fill: color },
  ];
}

/** Cancelled: a round postmark with the letter's date and number, its waves running over a stamp. */
export function postmark(r: Rng, input: ArtInput): Scene {
  const { width: w, height: h } = input;
  const rad = Math.min(w, h) * r.range(0.19, 0.23);
  const cx = r.range(0.2, 0.34) * w;
  const cy = r.range(0.32, 0.42) * h;
  const turn = r.range(-12, 6);
  // The stamp the postmark cancels, top right, under the waves.
  const sw = w * 0.2;
  const sx = w * r.range(0.66, 0.74);
  const sy = cy - rad * r.range(0.9, 1.3);
  const stampTurn = r.range(-6, 6);
  const dashes = Array.from({ length: 6 }, () => `${r.int(40, 140)} ${r.int(2, 5)} ${r.int(20, 90)} ${r.int(2, 4)}`);
  const wave = waves(cx + rad + 8, w + 40, cy, 6, 10, 4.5, 30).split("M").filter(Boolean);

  return {
    width: w,
    height: h,
    background: C.ground,
    defs: [grain(r, "grain", C.ink, 70)],
    nodes: [
      // A faint older cancellation, lower left.
      { kind: "path", d: waves(-20, w * 0.6, cy + rad * 2.1, 5, 10, 4.5, 30), stroke: C.ink, strokeWidth: 1.6, opacity: 0.08, transform: `rotate(${n(turn + 4)} ${n(w * 0.2)} ${n(cy + rad * 2.1)})` },
      {
        kind: "group",
        transform: `rotate(${n(stampTurn)} ${n(sx + sw / 2)} ${n(sy + sw * 0.6)})`,
        children: [
          { kind: "rect", x: sx + 3, y: sy + 5, w: sw, h: sw * 1.2, fill: C.ink, opacity: 0.08 },
          ...perforated(sx, sy, sw, sw * 1.2, C.white, C.ground),
          { kind: "rect", x: sx + 7, y: sy + 7, w: sw - 14, h: sw * 1.2 - 14, fill: C.orange },
          { kind: "text", x: sx + sw / 2, y: sy + sw * 0.78, text: numeral(input), size: sw * 0.42, font: "display", anchor: "middle", fill: C.white },
        ],
      },
      {
        kind: "group",
        transform: `rotate(${n(turn)} ${n(cx)} ${n(cy)})`,
        opacity: 0.92,
        children: [
          ...dateStamp(cx, cy, rad, C.blue, input),
          ...wave.map((d, i): ArtNode => ({ kind: "path", d: "M" + d, stroke: C.blue, strokeWidth: 2.2, dash: dashes[i], opacity: r.range(0.75, 1) })),
        ],
      },
      { kind: "rect", x: 0, y: 0, w, h, fill: "url(#grain)", opacity: 0.12 },
    ],
  };
}

/** Stamp: one big perforated stamp carrying the letter's number, cancelled at a corner. */
export function stamp(r: Rng, input: ArtInput): Scene {
  const { width: w, height: h } = input;
  const warm = r.chance(0.5);
  const ground = warm ? C.peach : C.blueCard;
  const panel = warm ? C.blue : C.orange;
  const sw = Math.min(w * 0.62, h * 0.56);
  const sh = sw * 1.18;
  const sx = w * r.range(0.3, 0.38) - sw * 0.1;
  const sy = h * r.range(0.1, 0.16);
  const turn = r.pick([-1, 1]) * r.range(3, 7);
  const label = numeral(input);
  const inner = { x: sx + 14, y: sy + 14, w: sw - 28, h: sh - 28 };
  const size = Math.min(inner.h * 0.62, (inner.w * 1.5) / Math.max(1.6, label.length));
  // Engraving: fine diagonal lines across the panel, clipped to it.
  let lines = "";
  for (let t = -inner.h; t < inner.w; t += 9) lines += `M${n(inner.x + t)} ${n(inner.y + inner.h)}l${n(inner.h)} ${n(-inner.h)}`;
  const pm = { x: sx + sw * r.range(0.8, 0.95), y: sy + sh * r.range(0.72, 0.88), r: sw * 0.26 };

  return {
    width: w,
    height: h,
    background: ground,
    defs: [
      { kind: "clip", id: "panel", children: [{ kind: "rect", ...inner }] },
      grain(r, "grain", C.ink, 70),
    ],
    nodes: [
      {
        kind: "group",
        transform: `rotate(${n(turn)} ${n(sx + sw / 2)} ${n(sy + sh / 2)})`,
        children: [
          { kind: "rect", x: sx + 6, y: sy + 9, w: sw, h: sh, fill: C.ink, opacity: 0.1 },
          ...perforated(sx, sy, sw, sh, C.white, ground),
          { kind: "rect", ...inner, fill: panel },
          { kind: "path", d: lines, stroke: C.white, strokeWidth: 1, opacity: 0.14, clip: "panel" },
          { kind: "text", x: inner.x + 12, y: inner.y + 22, text: "FOUNDER SIGNAL", size: 9, font: "mono", spacing: 1.4, fill: C.white },
          { kind: "text", x: inner.x + inner.w / 2, y: inner.y + inner.h * 0.5 + size * 0.36, text: label, size, font: "display", anchor: "middle", spacing: -size * 0.04, fill: C.white },
          { kind: "text", x: inner.x + 12, y: inner.y + inner.h - 14, text: "LETTER NO.", size: 9, font: "mono", spacing: 1.4, fill: C.white },
        ],
      },
      {
        kind: "group",
        opacity: 0.6,
        transform: `rotate(${n(r.range(-18, 4))} ${n(pm.x)} ${n(pm.y)})`,
        children: [
          ...dateStamp(pm.x, pm.y, pm.r, C.ink, input),
          { kind: "path", d: waves(pm.x + pm.r + 6, w + 40, pm.y, 5, 9, 4, 28), stroke: C.ink, strokeWidth: 1.8 },
        ],
      },
      { kind: "rect", x: 0, y: 0, w, h, fill: "url(#grain)", opacity: 0.12 },
    ],
  };
}

/** Airmail: the envelope's striped border, a "Par avion" label and a dotted flight home. */
export function airmail(r: Rng, input: ArtInput): Scene {
  const { width: w, height: h } = input;
  const band = 14;
  const period = 30;
  // Diagonal stripes over the whole canvas, clipped to the border.
  let blue = "";
  let orange = "";
  let k = 0;
  for (let x = -h; x < w + period; x += period / 2, k++) {
    if (k % 2) continue;
    const d = polygonD([
      [x, h],
      [x + period * 0.3, h],
      [x + h + period * 0.3, 0],
      [x + h, 0],
    ]);
    if ((k / 2) % 2) blue += d;
    else orange += d;
  }
  const lx = w * r.range(0.1, 0.3);
  const ly = h * r.range(0.24, 0.36);
  // A dotted route looping across the page, ending at a paper plane.
  const pts: [number, number][] = [
    [-10, h * r.range(0.55, 0.7)],
    [w * r.range(0.25, 0.4), h * r.range(0.42, 0.52)],
    [w * r.range(0.55, 0.7), h * r.range(0.5, 0.62)],
    [w * r.range(0.72, 0.84), h * r.range(0.22, 0.3)],
  ];
  const [a, b, c, end] = pts as [[number, number], [number, number], [number, number], [number, number]];
  const route = `M${n(a[0])} ${n(a[1])}Q${n(b[0])} ${n(b[1] - 80)} ${n(b[0])} ${n(b[1])}T${n(c[0])} ${n(c[1])}T${n(end[0])} ${n(end[1])}`;
  const plane = polygonD([
    [end[0] + 2, end[1] - 4],
    [end[0] + 24, end[1] - 14],
    [end[0] + 12, end[1] + 6],
  ]);

  return {
    width: w,
    height: h,
    background: C.paper,
    defs: [
      {
        kind: "clip",
        id: "border",
        children: [
          { kind: "rect", x: 0, y: 0, w, h: band },
          { kind: "rect", x: 0, y: 0, w: band, h },
          { kind: "rect", x: w - band, y: 0, w: band, h },
          { kind: "rect", x: 0, y: h - band, w, h: band },
        ],
      },
      grain(r, "grain", C.ink, 70),
    ],
    nodes: [
      { kind: "path", d: blue, fill: C.blue, clip: "border" },
      { kind: "path", d: orange, fill: C.orange, clip: "border" },
      { kind: "path", d: route, stroke: C.ink, strokeWidth: 1.6, dash: "0.5 7", opacity: 0.45 },
      { kind: "path", d: plane, fill: C.orange },
      {
        kind: "group",
        transform: `rotate(${n(r.range(-9, -3))} ${n(lx)} ${n(ly)})`,
        children: [
          { kind: "rect", x: lx, y: ly, w: 224, h: 60, rx: 7, stroke: C.blue, strokeWidth: 2.4 },
          { kind: "rect", x: lx + 5, y: ly + 5, w: 214, h: 50, rx: 5, stroke: C.blue, strokeWidth: 1 },
          { kind: "text", x: lx + 112, y: ly + 30, text: "PAR AVION", size: 19, font: "display", anchor: "middle", spacing: 2, fill: C.blue },
          { kind: "text", x: lx + 112, y: ly + 46, text: "BY AIR MAIL", size: 10, font: "mono", anchor: "middle", spacing: 2.5, fill: C.blue },
        ],
      },
      { kind: "rect", x: 0, y: 0, w, h, fill: "url(#grain)", opacity: 0.12 },
    ],
  };
}
