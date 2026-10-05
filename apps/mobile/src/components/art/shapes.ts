import { C, multiply } from "./colors.ts";
import type { Rng } from "./random.ts";
import { type ArtDef, type ArtNode, circleD, grain, n, polygonD, type Scene } from "./scene.ts";
import type { ArtInput } from "./styles.ts";

type Shape = { d: string; box: [number, number, number, number] };

/** Big flat primitives for the riso print. */
function primitive(r: Rng, cx: number, cy: number, size: number): Shape {
  const s = size / 2;
  const box: Shape["box"] = [cx - s, cy - s, cx + s, cy + s];
  switch (r.int(0, 4)) {
    case 0:
      return { d: circleD(cx, cy, s), box };
    case 1: {
      // Half disc, flat side at a random quarter turn.
      const t = (r.int(0, 3) * Math.PI) / 2;
      const [dx, dy] = [Math.cos(t) * s, Math.sin(t) * s];
      return { d: `M${n(cx - dx)} ${n(cy - dy)}A${n(s)} ${n(s)} 0 0 1 ${n(cx + dx)} ${n(cy + dy)}Z`, box };
    }
    case 2: {
      // Arch: a rectangle with a round top.
      const aw = s * 0.75;
      return { d: `M${n(cx - aw)} ${n(cy + s)}V${n(cy - s + aw)}A${n(aw)} ${n(aw)} 0 0 1 ${n(cx + aw)} ${n(cy - s + aw)}V${n(cy + s)}Z`, box };
    }
    case 3:
      return {
        d: polygonD([
          [cx - s, cy + s * 0.85],
          [cx + s, cy + s * 0.85],
          [cx + r.range(-0.4, 0.4) * s, cy - s],
        ]),
        box,
      };
    default: {
      const t = (r.range(-20, 20) * Math.PI) / 180;
      const corner = (x: number, y: number): [number, number] => [cx + x * Math.cos(t) - y * Math.sin(t), cy + x * Math.sin(t) + y * Math.cos(t)];
      const [hw, hh] = [s * 0.95, s * 0.6];
      return { d: polygonD([corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)]), box };
    }
  }
}

const overlaps = (a: Shape, b: Shape) => a.box[0] < b.box[2] && b.box[0] < a.box[2] && a.box[1] < b.box[3] && b.box[1] < a.box[3];

/** Riso: big blue and orange shapes overprinted, darker where the inks cross, with the paper's speckle. */
export function riso(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const inks = r.chance(0.5) ? [C.blue, C.orange] : [C.orange, C.blue];
  const count = r.int(3, 4);
  const shapes = Array.from({ length: count }, (_, i) => {
    const size = w * r.range(0.42, 0.78);
    return { ...primitive(r, r.range(0.05, 0.95) * w, r.range(0.12, 0.62) * h, size), ink: inks[i % 2]! };
  });
  const defs: ArtDef[] = shapes.map((s, i) => ({ kind: "clip", id: `s${i}`, children: [{ kind: "path", d: s.d }] }));
  const nodes: ArtNode[] = shapes.map((s) => ({ kind: "path", d: s.d, fill: multiply(s.ink, C.paper) }));
  // Overprint: each later shape again, inside each earlier one it touches, in the multiplied ink.
  shapes.forEach((b, j) =>
    shapes.slice(0, j).forEach((a, i) => {
      if (overlaps(a, b)) nodes.push({ kind: "path", d: b.d, fill: multiply(multiply(a.ink, b.ink), C.paper), clip: `s${i}` });
    }),
  );
  // Paper showing through the ink, then a little toner dust.
  defs.push(grain(r, "speck", C.paper, 110), grain(r, "dust", C.ink, 40));
  nodes.push({ kind: "rect", x: 0, y: 0, w, h, fill: "url(#speck)", opacity: 0.7 }, { kind: "rect", x: 0, y: 0, w, h, fill: "url(#dust)", opacity: 0.18 });
  return { width: w, height: h, background: C.paper, defs, nodes };
}

/** Routes: towns as points on a dark map, dotted routes between them and one letter on its way. */
export function routes(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const pts: [number, number][] = [];
  for (let tries = 0; pts.length < 8 && tries < 200; tries++) {
    const p: [number, number] = [r.range(0.06, 0.94) * w, r.range(0.1, 0.66) * h];
    if (pts.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > Math.min(w, h) * 0.2)) pts.push(p);
  }
  // Each town to its two nearest neighbours.
  const edges = new Set<string>();
  pts.forEach((p, i) => {
    const near = pts
      .map((q, j) => ({ j, dist: Math.hypot(q[0] - p[0], q[1] - p[1]) }))
      .filter((x) => x.j !== i)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 2);
    near.forEach(({ j }) => edges.add(i < j ? `${i}-${j}` : `${j}-${i}`));
  });
  const arc = (a: [number, number], b: [number, number], bend: number) => {
    const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    return `M${n(a[0])} ${n(a[1])}Q${n(mx - dy * bend)} ${n(my + dx * bend)} ${n(b[0])} ${n(b[1])}`;
  };
  let dotted = "";
  for (const e of edges) {
    const [i, j] = e.split("-").map(Number) as [number, number];
    dotted += arc(pts[i]!, pts[j]!, r.range(0.12, 0.28) * r.pick([-1, 1]));
  }
  // The letter's journey: from the first town through its nearest neighbours.
  const journey: number[] = [0];
  while (journey.length < Math.min(4, pts.length)) {
    const last = pts[journey.at(-1)!]!;
    const next = pts
      .map((q, j) => ({ j, dist: Math.hypot(q[0] - last[0], q[1] - last[1]) }))
      .filter((x) => !journey.includes(x.j))
      .sort((a, b) => a.dist - b.dist)[0]!;
    journey.push(next.j);
  }
  const path = journey
    .slice(1)
    .map((j, k) => arc(pts[journey[k]!]!, pts[j]!, 0.18))
    .join("");
  const end = pts[journey.at(-1)!]!;
  let stars = "";
  for (let i = 0; i < 46; i++) stars += circleD(r.range(0, w), r.range(0, h), r.range(0.5, 1.1));
  // Faint lines of latitude.
  let lat = "";
  for (let i = 1; i <= 4; i++) lat += `M${-20} ${n(h * 0.18 * i)}Q${n(w / 2)} ${n(h * 0.18 * i - 50)} ${n(w + 20)} ${n(h * 0.18 * i)}`;

  return {
    width: w,
    height: h,
    background: C.ink,
    defs: [],
    nodes: [
      { kind: "path", d: lat, stroke: C.white, strokeWidth: 1, opacity: 0.07 },
      { kind: "path", d: stars, fill: C.white, opacity: 0.28 },
      { kind: "path", d: dotted, stroke: C.blueMid, strokeWidth: 1.6, dash: "0.1 6", opacity: 0.7 },
      { kind: "path", d: path, stroke: C.orange, strokeWidth: 2 },
      { kind: "path", d: pts.map(([x, y]) => circleD(x, y, 7)).join(""), stroke: C.white, strokeWidth: 1, opacity: 0.22 },
      { kind: "path", d: pts.map(([x, y]) => circleD(x, y, 2.6)).join(""), fill: C.white },
      // The letter: a small envelope at the end of the journey.
      { kind: "rect", x: end[0] - 9, y: end[1] - 22, w: 18, h: 12, rx: 1.5, fill: C.ground },
      { kind: "path", d: `M${n(end[0] - 8)} ${n(end[1] - 21)}L${n(end[0])} ${n(end[1] - 15)}L${n(end[0] + 8)} ${n(end[1] - 21)}`, stroke: C.ink, strokeWidth: 1.2 },
    ],
  };
}
