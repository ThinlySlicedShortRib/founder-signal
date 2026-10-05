import { C, GROUNDS, LINES } from "./colors.ts";
import type { Rng } from "./random.ts";
import { type ArtDef, type ArtNode, circleD, dotNodes, grain, n, type Scene, smoothD } from "./scene.ts";
import type { ArtInput } from "./styles.ts";

/**
 * Fields: art that covers the band softly (washes, lines, dots). Everything
 * is a tint on a near-white ground, so the cover reads as a quiet page and
 * the text on it doesn't need much of a scrim.
 */

/** Morning mesh: three or four pale blobs of the brand tints melting into each other, with a little grain. */
export function mesh(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const big = Math.max(w, h);
  const palettes: [string, string, string][] = [
    [C.blueCard, C.blueTint, C.peach],
    [C.peach, C.orangeTint, C.blueTint],
    [C.blueTint, C.blueCard, C.orangeTint],
    [C.blueCard, C.peach, C.blueTint],
  ];
  const [a, b, c] = r.pick(palettes);
  const blobs: [string, number][] = [
    [a, 0.8],
    [b, 0.9],
    [c, 0.6],
  ];
  // Now and then a breath of blue, very faint.
  if (r.chance(0.5)) blobs.push([C.blueMid, 0.12]);
  const defs: ArtDef[] = [];
  const nodes: ArtNode[] = [];
  blobs.forEach(([color, alpha], i) => {
    const accent = i >= 3;
    const cx = r.range(-0.15, 1.15) * w;
    const cy = r.range(-0.15, accent ? 0.45 : 0.7) * h;
    const rad = big * (accent ? r.range(0.22, 0.32) : r.range(0.4, 0.62));
    defs.push({
      kind: "radial",
      id: `b${i}`,
      cx,
      cy,
      r: rad,
      stops: [
        { offset: 0, color, opacity: alpha },
        { offset: 0.55, color, opacity: alpha * 0.45 },
        { offset: 1, color, opacity: 0 },
      ],
    });
    nodes.push({ kind: "circle", cx, cy, r: rad, fill: `url(#b${i})` });
  });
  defs.push(grain(r, "grain", C.ink, 50));
  nodes.push({ kind: "rect", x: 0, y: 0, w, h, fill: "url(#grain)", opacity: 0.05 });
  return { width: w, height: h, background: r.pick([C.ground, C.ground, C.fog]), defs, nodes };
}

/** Survey: hairline contour lines around one hill, every fifth a touch firmer, sometimes one in a faint orange. */
export function contour(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const cx = r.range(0.45, 0.9) * w;
  const cy = r.range(0.12, 0.38) * h;
  const step = Math.max(w, h) * r.range(0.06, 0.08);
  const harmonics = [2, 3, 5].map((j) => ({ j, a: (step * r.range(0.6, 1.4)) / Math.sqrt(j), phase: r.range(0, Math.PI * 2) }));
  const drift = [r.range(-0.25, 0.25) * step, r.range(0.05, 0.3) * step];
  const reach = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
  // The lines stop short of the far corners: open paper around the hill.
  const rings = Math.min(14, Math.ceil((reach * 0.8) / step));
  const line = r.pick(LINES);
  const orange = r.chance(0.5) ? r.int(3, Math.max(3, rings - 2)) : -1;
  const nodes: ArtNode[] = [];
  const groups = { thin: "", index: "" };
  for (let k = 1; k <= rings; k++) {
    const g = k / rings;
    const ox = cx + drift[0]! * k;
    const oy = cy + drift[1]! * k;
    const pts: [number, number][] = [];
    for (let i = 0; i < 36; i++) {
      const t = (i / 36) * Math.PI * 2;
      const rad = k * step + harmonics.reduce((s, { j, a, phase }) => s + a * Math.sin(j * t + phase + k * 0.06), 0) * g * 1.6;
      pts.push([ox + Math.cos(t) * rad, oy + Math.sin(t) * rad]);
    }
    const d = smoothD(pts, true);
    if (k === orange) nodes.push({ kind: "path", d, stroke: C.orange, strokeWidth: 0.9, opacity: 0.35 });
    else if (k % 5 === 0) groups.index += d;
    else groups.thin += d;
  }
  nodes.unshift({ kind: "path", d: groups.thin, stroke: line, strokeWidth: 0.7, opacity: 0.4 });
  if (groups.index) nodes.unshift({ kind: "path", d: groups.index, stroke: line, strokeWidth: 1, opacity: 0.65 });
  // The summit.
  nodes.push({ kind: "path", d: circleD(cx, cy, 1.6), fill: line, opacity: 0.8 });
  return { width: w, height: h, background: r.pick(GROUNDS), defs: [], nodes };
}

/** Halftone: a soft sun of fine pale dots growing out of one corner, the rest of the page left clear. */
export function halftone(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const big = Math.max(w, h);
  const corner = r.pick<[number, number]>([
    [0.85, 0.08],
    [0.15, 0.1],
    [0.7, 0.3],
    [1, 0.45],
  ]);
  const sun = { x: (corner[0] + r.range(-0.08, 0.08)) * w, y: (corner[1] + r.range(-0.05, 0.05)) * h, r: big * r.range(0.42, 0.58) };
  const ink = r.pick([C.blueMid, C.blueMid, C.orange]);
  const alpha = ink === C.orange ? 0.22 : 0.32;
  const s = r.pick([13, 15]);
  const angle = (r.range(0, 30) * Math.PI) / 180;
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const dots: [number, number, number][] = [];
  const span = Math.ceil(big / s) + 2;
  for (let i = -span; i <= span; i++) {
    for (let j = -span; j <= span; j++) {
      const x = sun.x + (i * cos - j * sin) * s;
      const y = sun.y + (i * sin + j * cos) * s;
      if (x < -s || y < -s || x > w + s || y > h + s) continue;
      const f = Math.max(0, 1 - Math.hypot(x - sun.x, y - sun.y) / sun.r);
      const rad = s * 0.3 * f ** 1.3;
      if (rad > 0.7) dots.push([x, y, rad]);
    }
  }
  return { width: w, height: h, background: r.pick([C.ground, C.fog]), defs: [], nodes: dotNodes(dots, ink, alpha) };
}

/** Dot grid: an even grid of tiny dots, fading out from one edge into plain paper. */
export function dots(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const s = r.pick([16, 18, 20]);
  const ink = r.pick(LINES);
  const staggered = r.chance(0.35);
  // Where the dots are strongest, and how far they reach.
  const from = r.pick<[number, number]>([
    [1, 0],
    [0, 0],
    [0.5, -0.2],
    [1, 0.5],
  ]);
  const [fx, fy] = [from[0] * w, from[1] * h];
  const reach = Math.max(w, h) * r.range(0.7, 0.95);
  const bands = [0.7, 0.5, 0.32, 0.16];
  const byBand: [number, number, number][][] = bands.map(() => []);
  for (let row = 0, y = s / 2; y < h; y += s, row++) {
    for (let x = s / 2 + (staggered && row % 2 ? s / 2 : 0); x < w; x += s) {
      const f = Math.hypot(x - fx, y - fy) / reach;
      if (f >= 1) continue;
      byBand[Math.min(bands.length - 1, Math.floor(f * bands.length))]!.push([x, y, 1]);
    }
  }
  const nodes = byBand.flatMap((pts, i) => (pts.length ? dotNodes(pts, ink, bands[i]!) : []));
  return { width: w, height: h, background: r.pick(GROUNDS), defs: [], nodes };
}

/** Wash: a soft two-tint gradient across the page with a fine drafting grid over it. */
export function wash(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const [a, b] = r.pick<[string, string]>([
    [C.blueTint, C.orangeTint],
    [C.blueCard, C.blueTint],
    [C.orangeTint, C.blueTint],
    [C.peach, C.fog],
  ]);
  const size = r.pick([20, 24, 32]);
  const ink = r.pick(LINES);
  const diagonal = r.chance(0.5);
  const defs: ArtDef[] = [
    {
      kind: "linear",
      id: "wash",
      x1: diagonal ? 0 : w / 2,
      y1: 0,
      x2: diagonal ? w : w / 2,
      y2: h,
      stops: [
        { offset: 0, color: a, opacity: 0.9 },
        { offset: 0.55, color: a, opacity: 0.25 },
        { offset: 1, color: b, opacity: 0.8 },
      ],
    },
    { kind: "pattern", id: "grid", size, children: [{ kind: "path", d: `M0 0.5H${size}M0.5 0V${size}`, stroke: ink, strokeWidth: 0.6 }] },
  ];
  const nodes: ArtNode[] = [
    { kind: "rect", x: 0, y: 0, w, h, fill: "url(#wash)" },
    { kind: "rect", x: 0, y: 0, w, h, fill: "url(#grid)", opacity: 0.3 },
  ];
  // Sometimes one finer, firmer rule, like a fold.
  if (r.chance(0.5)) {
    const y = Math.round(h * r.range(0.3, 0.5) / size) * size + 0.5;
    nodes.push({ kind: "path", d: `M0 ${n(y)}H${w}`, stroke: ink, strokeWidth: 0.6, opacity: 0.5 });
  }
  return { width: w, height: h, background: C.ground, defs, nodes };
}

/** Quiet sky: a two-tint sky over a hairline horizon, with a small sun or a crescent moon. */
export function sky(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const [top, bottom] = r.pick<[string, string]>([
    [C.blueTint, C.peach],
    [C.blueCard, C.orangeTint],
    [C.fog, C.blueTint],
    [C.orangeTint, C.blueTint],
  ]);
  // Below the masthead and above the text: the horizon, and the sun or moon over it.
  const horizon = h * r.range(0.48, 0.56);
  const body = { x: w * r.range(0.6, 0.85), y: Math.max(130, horizon - h * r.range(0.14, 0.24)), r: r.range(9, 14) };
  const moon = r.chance(0.45);
  const nodes: ArtNode[] = [{ kind: "rect", x: 0, y: 0, w, h, fill: "url(#sky)" }];
  if (moon) {
    // A crescent: the disc less a slightly offset disc.
    const k = body.r * 0.62;
    nodes.push({
      kind: "path",
      d: `M${n(body.x)} ${n(body.y - body.r)}A${n(body.r)} ${n(body.r)} 0 1 0 ${n(body.x)} ${n(body.y + body.r)}A${n(k + body.r * 0.2)} ${n(body.r)} 0 1 1 ${n(body.x)} ${n(body.y - body.r)}Z`,
      fill: C.white,
      stroke: C.blueMid,
      strokeWidth: 0.6,
      opacity: 0.9,
    });
  } else {
    nodes.push({ kind: "circle", cx: body.x, cy: body.y, r: body.r * 2.4, fill: C.white, opacity: 0.35 }, { kind: "circle", cx: body.x, cy: body.y, r: body.r, fill: C.orange, opacity: 0.18 });
  }
  // The horizon, and one or two long, thin clouds.
  nodes.push({ kind: "path", d: `M0 ${n(horizon)}H${w}`, stroke: C.pencil, strokeWidth: 0.7, opacity: 0.6 });
  let clouds = "";
  for (let i = r.int(1, 2); i > 0; i--) {
    const y = h * r.range(0.26, 0.42);
    const x = w * r.range(-0.1, 0.5);
    clouds += `M${n(x)} ${n(y)}h${n(w * r.range(0.25, 0.45))}`;
  }
  nodes.push({ kind: "path", d: clouds, stroke: C.white, strokeWidth: 1.4, opacity: 0.7 });
  return {
    width: w,
    height: h,
    background: top,
    defs: [
      {
        kind: "linear",
        id: "sky",
        x1: 0,
        y1: 0,
        x2: 0,
        y2: h,
        stops: [
          { offset: 0, color: top },
          { offset: 0.6, color: bottom, opacity: 0.75 },
          { offset: 1, color: C.ground },
        ],
      },
    ],
    nodes,
  };
}
