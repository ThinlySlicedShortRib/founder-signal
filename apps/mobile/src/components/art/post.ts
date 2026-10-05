import { C, GROUNDS, LINES } from "./colors.ts";
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
function perforated(x: number, y: number, w: number, h: number, paper: string, ground: string, hole = 2.6, pitch = 9): ArtNode[] {
  let d = "";
  const [nx, ny] = [Math.max(1, Math.round(w / pitch)), Math.max(1, Math.round(h / pitch))];
  for (let i = 0; i <= nx; i++) d += circleD(x + (i * w) / nx, y, hole) + circleD(x + (i * w) / nx, y + h, hole);
  for (let i = 1; i < ny; i++) d += circleD(x, y + (i * h) / ny, hole) + circleD(x + w, y + (i * h) / ny, hole);
  return [
    { kind: "rect", x, y, w, h, fill: paper },
    { kind: "path", d, fill: ground },
  ];
}

/** A round date stamp in hairlines: two rings, the post office's name, the date and the letter's number. */
function dateStamp(cx: number, cy: number, rad: number, color: string, input: ArtInput): ArtNode[] {
  return [
    { kind: "circle", cx, cy, r: rad, stroke: color, strokeWidth: 1.2 },
    { kind: "circle", cx, cy, r: rad * 0.8, stroke: color, strokeWidth: 0.6 },
    { kind: "text", x: cx, y: cy - rad * 0.36, text: "FOUNDER SIGNAL", size: rad * 0.12, font: "mono", anchor: "middle", spacing: 1.2, fill: color },
    { kind: "text", x: cx, y: cy + rad * 0.1, text: stampDate(input.date), size: rad * 0.2, font: "mono", anchor: "middle", fill: color },
    { kind: "text", x: cx, y: cy + rad * 0.5, text: `NO. ${numeral(input)}`, size: rad * 0.13, font: "mono", anchor: "middle", spacing: 1.2, fill: color },
  ];
}

/** Cancelled: a faint round postmark with the letter's date and number, its waves trailing over a small pale stamp. */
export function postmark(r: Rng, input: ArtInput): Scene {
  const { width: w, height: h } = input;
  const ground = r.pick(GROUNDS);
  const ink = r.pick(LINES);
  const rad = Math.min(w, h) * r.range(0.14, 0.17);
  const cx = r.range(0.22, 0.36) * w;
  const cy = r.range(0.3, 0.4) * h;
  const turn = r.range(-12, 6);
  // The stamp the postmark cancels, top right, under the waves.
  const sw = w * 0.15;
  const sx = w * r.range(0.68, 0.74);
  const sy = cy - rad * r.range(1, 1.4);
  const stampTurn = r.range(-5, 5);
  const panel = r.pick([C.blueCard, C.peach, C.blueTint]);
  const dashes = Array.from({ length: 4 }, () => `${r.int(40, 140)} ${r.int(2, 5)} ${r.int(20, 90)} ${r.int(2, 4)}`);
  const wave = waves(cx + rad + 8, w + 40, cy, 4, 9, 3.5, 30).split("M").filter(Boolean);

  return {
    width: w,
    height: h,
    background: ground,
    defs: [grain(r, "grain", C.ink, 50)],
    nodes: [
      {
        kind: "group",
        transform: `rotate(${n(stampTurn)} ${n(sx + sw / 2)} ${n(sy + sw * 0.6)})`,
        children: [
          ...perforated(sx, sy, sw, sw * 1.2, C.white, ground),
          { kind: "rect", x: sx + 6, y: sy + 6, w: sw - 12, h: sw * 1.2 - 12, fill: panel },
          { kind: "text", x: sx + sw / 2, y: sy + sw * 0.76, text: numeral(input), size: sw * 0.36, font: "display", anchor: "middle", fill: ink, opacity: 0.8 },
        ],
      },
      {
        kind: "group",
        transform: `rotate(${n(turn)} ${n(cx)} ${n(cy)})`,
        opacity: 0.8,
        children: [
          ...dateStamp(cx, cy, rad, ink, input),
          ...wave.map((d, i): ArtNode => ({ kind: "path", d: "M" + d, stroke: ink, strokeWidth: 1, dash: dashes[i] })),
        ],
      },
      { kind: "rect", x: 0, y: 0, w, h, fill: "url(#grain)", opacity: 0.05 },
    ],
  };
}

/** Stamp: one perforated stamp in pale tints carrying the letter's number, lightly cancelled at a corner. */
export function stamp(r: Rng, input: ArtInput): Scene {
  const { width: w, height: h } = input;
  const [ground, panel] = r.pick<[string, string]>([
    [C.ground, C.blueCard],
    [C.paper, C.peach],
    [C.fog, C.blueTint],
    [C.paper, C.blueCard],
  ]);
  const ink = r.pick(LINES);
  const sw = Math.min(w * 0.36, h * 0.3);
  const sh = sw * 1.2;
  const sx = w * r.range(0.45, 0.6) - sw / 2;
  // Clear of the masthead (at least 110pt down).
  const sy = Math.max(110, h * r.range(0.18, 0.24));
  const turn = r.pick([-1, 1]) * r.range(2, 5);
  const label = numeral(input);
  const inner = { x: sx + 10, y: sy + 10, w: sw - 20, h: sh - 20 };
  const size = Math.min(inner.h * 0.5, (inner.w * 1.3) / Math.max(1.6, label.length));
  // Engraving: fine diagonal lines across the panel, clipped to it.
  let lines = "";
  for (let t = -inner.h; t < inner.w; t += 8) lines += `M${n(inner.x + t)} ${n(inner.y + inner.h)}l${n(inner.h)} ${n(-inner.h)}`;
  const pm = { x: sx + sw * r.range(0.82, 0.95), y: sy + sh * r.range(0.74, 0.88), r: sw * 0.24 };

  return {
    width: w,
    height: h,
    background: ground,
    defs: [
      { kind: "clip", id: "panel", children: [{ kind: "rect", ...inner }] },
      grain(r, "grain", C.ink, 50),
    ],
    nodes: [
      {
        kind: "group",
        transform: `rotate(${n(turn)} ${n(sx + sw / 2)} ${n(sy + sh / 2)})`,
        children: [
          { kind: "rect", x: sx + 3, y: sy + 5, w: sw, h: sh, fill: C.ink, opacity: 0.04 },
          ...perforated(sx, sy, sw, sh, C.white, ground),
          { kind: "rect", ...inner, fill: panel },
          { kind: "path", d: lines, stroke: C.white, strokeWidth: 0.8, opacity: 0.35, clip: "panel" },
          { kind: "text", x: inner.x + 10, y: inner.y + 18, text: "FOUNDER SIGNAL", size: 7.5, font: "mono", spacing: 1.2, fill: ink },
          { kind: "text", x: inner.x + inner.w / 2, y: inner.y + inner.h * 0.52 + size * 0.36, text: label, size, font: "display", anchor: "middle", spacing: -size * 0.04, fill: ink, opacity: 0.6 },
          { kind: "text", x: inner.x + 10, y: inner.y + inner.h - 11, text: "LETTER NO.", size: 7.5, font: "mono", spacing: 1.2, fill: ink },
        ],
      },
      {
        kind: "group",
        opacity: 0.6,
        transform: `rotate(${n(r.range(-18, 4))} ${n(pm.x)} ${n(pm.y)})`,
        children: [
          ...dateStamp(pm.x, pm.y, pm.r, ink, input),
          { kind: "path", d: waves(pm.x + pm.r + 6, w + 40, pm.y, 3, 8, 3, 28), stroke: ink, strokeWidth: 1 },
        ],
      },
      { kind: "rect", x: 0, y: 0, w, h, fill: "url(#grain)", opacity: 0.05 },
    ],
  };
}

/** Airmail: a thin, pale striped border, a hairline "Par avion" label and a dotted flight ending in a small paper plane. */
export function airmail(r: Rng, input: ArtInput): Scene {
  const { width: w, height: h } = input;
  const band = r.pick([6, 8]);
  const period = 24;
  // Diagonal stripes over the whole canvas, clipped to the border.
  let blue = "";
  let warm = "";
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
    else warm += d;
  }
  const ink = r.pick([C.blueMid, C.blueMid, C.pencil]);
  const lx = w * r.range(0.1, 0.28);
  const ly = h * r.range(0.24, 0.34);
  // A dotted route looping across the page, ending at a paper plane.
  const pts: [number, number][] = [
    [-10, h * r.range(0.55, 0.7)],
    [w * r.range(0.25, 0.4), h * r.range(0.42, 0.52)],
    [w * r.range(0.55, 0.7), h * r.range(0.5, 0.62)],
    [w * r.range(0.72, 0.84), h * r.range(0.16, 0.24)],
  ];
  const [a, b, c, end] = pts as [[number, number], [number, number], [number, number], [number, number]];
  const route = `M${n(a[0])} ${n(a[1])}Q${n(b[0])} ${n(b[1] - 80)} ${n(b[0])} ${n(b[1])}T${n(c[0])} ${n(c[1])}T${n(end[0])} ${n(end[1])}`;
  const plane = polygonD([
    [end[0] + 2, end[1] - 3],
    [end[0] + 18, end[1] - 10],
    [end[0] + 9, end[1] + 4],
  ]);
  const border = r.chance(0.7);
  const ground = r.pick([C.paper, C.ground]);

  return {
    width: w,
    height: h,
    background: ground,
    defs: [grain(r, "grain", C.ink, 50)],
    nodes: [
      // The stripes, then the page over them inside the border (a multi-shape clip doesn't render everywhere).
      ...(border
        ? ([
            { kind: "path", d: blue, fill: C.blueMid, opacity: 0.4 },
            { kind: "path", d: warm, fill: C.orange, opacity: 0.25 },
            { kind: "rect", x: band, y: band, w: w - band * 2, h: h - band * 2, fill: ground },
          ] as ArtNode[])
        : []),
      { kind: "path", d: route, stroke: ink, strokeWidth: 1, dash: "0.5 6", opacity: 0.7 },
      { kind: "path", d: plane, fill: C.white, stroke: ink, strokeWidth: 0.8 },
      {
        kind: "group",
        opacity: 0.9,
        transform: `rotate(${n(r.range(-8, -3))} ${n(lx)} ${n(ly)})`,
        children: [
          { kind: "rect", x: lx, y: ly, w: 168, h: 46, rx: 5, stroke: ink, strokeWidth: 1 },
          { kind: "rect", x: lx + 4, y: ly + 4, w: 160, h: 38, rx: 3.5, stroke: ink, strokeWidth: 0.5 },
          { kind: "text", x: lx + 84, y: ly + 23, text: "PAR AVION", size: 14, font: "display", anchor: "middle", spacing: 2, fill: ink },
          { kind: "text", x: lx + 84, y: ly + 35, text: "BY AIR MAIL", size: 7.5, font: "mono", anchor: "middle", spacing: 2.2, fill: ink },
        ],
      },
      { kind: "rect", x: 0, y: 0, w, h, fill: "url(#grain)", opacity: 0.05 },
    ],
  };
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

/** Ruled paper: faint ruled lines (or squares) with a margin rule clear of the text, at the left edge or the right. */
export function ruled(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const ground = r.pick(GROUNDS);
  const gap = r.pick([24, 28, 32]);
  const squared = r.chance(0.3);
  // The first line below the masthead.
  const top = 112 + gap * r.int(0, 2);
  // The text starts 20pt in, so the margin sits outside it: 12pt in, or 28pt from the right (doubled, sometimes).
  const margin = r.pick([12, w - 28]);
  const double = r.chance(0.35);
  let lines = "";
  for (let y = top; y < h; y += gap) lines += `M0 ${n(y + 0.5)}H${w}`;
  if (squared) for (let x = gap / 2; x < w; x += gap) lines += `M${n(x + 0.5)} 0V${h}`;
  const nodes: ArtNode[] = [
    { kind: "path", d: lines, stroke: C.blueMid, strokeWidth: 0.7, opacity: squared ? 0.2 : 0.3 },
    { kind: "path", d: `M${n(margin)} 0V${h}` + (double ? `M${n(margin + (margin < w / 2 ? -4 : 4))} 0V${h}` : ""), stroke: C.orange, strokeWidth: 0.7, opacity: 0.3 },
  ];
  return { width: w, height: h, background: ground, defs: [grain(r, "grain", C.ink, 40)], nodes: [...nodes, { kind: "rect", x: 0, y: 0, w, h, fill: "url(#grain)", opacity: 0.04 }] };
}
