import { C, GROUNDS, LINES, multiply } from "./colors.ts";
import type { Rng } from "./random.ts";
import { type ArtDef, type ArtNode, circleD, grain, n, polygonD, type Scene, smoothD } from "./scene.ts";
import type { ArtInput } from "./styles.ts";

type Shape = { d: string; box: [number, number, number, number] };

/** Flat primitives for the riso print. */
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

/** Riso: two or three pale shapes in blue and peach overprinted on warm paper, a shade deeper where they cross. */
export function riso(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const pair = r.pick<[string, string]>([
    [C.blueCard, C.peach],
    [C.peach, C.blueCard],
    [C.blueCard, C.blueTint],
  ]);
  const count = r.int(2, 3);
  // The shapes gather on one side, leaving the other side open.
  const side = r.pick([0.3, 0.7]);
  const shapes = Array.from({ length: count }, (_, i) => {
    const size = w * r.range(0.28, 0.48);
    return { ...primitive(r, (side + r.range(-0.22, 0.22)) * w, Math.max(100 + size / 2, r.range(0.28, 0.46) * h), size), ink: pair[i % 2]! };
  });
  const ground = r.pick([C.paper, C.paper, C.ground]);
  const defs: ArtDef[] = shapes.map((s, i) => ({ kind: "clip", id: `s${i}`, children: [{ kind: "path", d: s.d }] }));
  const nodes: ArtNode[] = shapes.map((s) => ({ kind: "path", d: s.d, fill: multiply(s.ink, ground) }));
  // Overprint: each later shape again, inside each earlier one it touches, in the multiplied ink.
  shapes.forEach((b, j) =>
    shapes.slice(0, j).forEach((a, i) => {
      if (overlaps(a, b)) nodes.push({ kind: "path", d: b.d, fill: multiply(multiply(a.ink, b.ink), ground), clip: `s${i}` });
    }),
  );
  // Now and then one tiny orange dot, the only strong colour.
  if (r.chance(0.4)) nodes.push({ kind: "path", d: circleD(r.range(0.15, 0.85) * w, r.range(0.12, 0.45) * h, 4), fill: C.orange, opacity: 0.45 });
  // Paper showing through the ink.
  defs.push(grain(r, "speck", ground, 90), grain(r, "dust", C.ink, 30));
  nodes.push({ kind: "rect", x: 0, y: 0, w, h, fill: "url(#speck)", opacity: 0.6 }, { kind: "rect", x: 0, y: 0, w, h, fill: "url(#dust)", opacity: 0.05 });
  return { width: w, height: h, background: ground, defs, nodes };
}

/** A gentle arc from a to b, for the routes. */
const arc = (a: [number, number], b: [number, number], bend: number) => {
  const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  return `M${n(a[0])} ${n(a[1])}Q${n(mx - dy * bend)} ${n(my + dx * bend)} ${n(b[0])} ${n(b[1])}`;
};

/** Routes: a pale map, a few towns as fine points, dotted roads between them and one letter's journey in a hairline. */
export function routes(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const pts: [number, number][] = [];
  const towns = r.int(5, 7);
  for (let tries = 0; pts.length < towns && tries < 200; tries++) {
    const p: [number, number] = [r.range(0.08, 0.92) * w, r.range(0.12, 0.6) * h];
    if (pts.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > Math.min(w, h) * 0.22)) pts.push(p);
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
  let dotted = "";
  for (const e of edges) {
    const [i, j] = e.split("-").map(Number) as [number, number];
    dotted += arc(pts[i]!, pts[j]!, r.range(0.12, 0.28) * r.pick([-1, 1]));
  }
  // The letter's journey: from the first town through its nearest neighbours.
  const journey: number[] = [0];
  while (journey.length < Math.min(3, pts.length)) {
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
  const ink = r.pick(LINES);
  // Faint lines of latitude and, sometimes, longitude.
  let grid = "";
  for (let i = 1; i <= 4; i++) grid += `M${-20} ${n(h * 0.2 * i)}Q${n(w / 2)} ${n(h * 0.2 * i - 40)} ${n(w + 20)} ${n(h * 0.2 * i)}`;
  if (r.chance(0.5)) for (let i = 1; i <= 3; i++) grid += `M${n(w * 0.25 * i)} -20Q${n(w * 0.25 * i + (i - 2) * 30)} ${n(h / 2)} ${n(w * 0.25 * i)} ${n(h + 20)}`;

  return {
    width: w,
    height: h,
    background: r.pick([C.paper, C.fog, C.ground]),
    defs: [],
    nodes: [
      { kind: "path", d: grid, stroke: ink, strokeWidth: 0.6, opacity: 0.2 },
      { kind: "path", d: dotted, stroke: ink, strokeWidth: 1, dash: "0.1 5", opacity: 0.6 },
      { kind: "path", d: path, stroke: ink, strokeWidth: 1.1, opacity: 0.9 },
      { kind: "path", d: pts.map(([x, y]) => circleD(x, y, 1.8)).join(""), fill: ink, opacity: 0.9 },
      // The letter: a small outlined envelope at the end of the journey, and a pin of orange.
      { kind: "rect", x: end[0] - 7, y: end[1] - 18, w: 14, h: 9, rx: 1, fill: C.white, stroke: ink, strokeWidth: 0.8 },
      { kind: "path", d: `M${n(end[0] - 6.5)} ${n(end[1] - 17.5)}L${n(end[0])} ${n(end[1] - 13)}L${n(end[0] + 6.5)} ${n(end[1] - 17.5)}`, stroke: ink, strokeWidth: 0.8 },
      { kind: "path", d: circleD(end[0], end[1], 2.2), fill: C.orange, opacity: 0.5 },
    ],
  };
}

/** Line drawing: one small drawing in a single hairline (an envelope, a horizon or a fragment of map), and lots of paper. */
export function sketch(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const ink = r.pick(LINES);
  const line = { stroke: ink, strokeWidth: 1.1 };
  const subject = r.int(0, 2);
  const nodes: ArtNode[] = [];
  if (subject === 0) {
    // An envelope, slightly turned, with a small stamp and a dot of orange for the seal.
    const ew = Math.min(w * r.range(0.4, 0.5), 210);
    const eh = ew * 0.62;
    const [x, y] = [w * r.range(0.3, 0.55) - ew / 2 + w * 0.12, h * r.range(0.2, 0.3)];
    nodes.push({
      kind: "group",
      transform: `rotate(${n(r.range(-7, 5))} ${n(x + ew / 2)} ${n(y + eh / 2)})`,
      children: [
        { kind: "rect", x, y, w: ew, h: eh, rx: 2, ...line },
        { kind: "path", d: `M${n(x)} ${n(y)}L${n(x + ew / 2)} ${n(y + eh * 0.55)}L${n(x + ew)} ${n(y)}M${n(x)} ${n(y + eh)}L${n(x + ew * 0.4)} ${n(y + eh * 0.42)}M${n(x + ew)} ${n(y + eh)}L${n(x + ew * 0.6)} ${n(y + eh * 0.42)}`, ...line, strokeWidth: 0.8 },
        { kind: "rect", x: x + ew - 30, y: y + 8, w: 20, h: 24, ...line, strokeWidth: 0.8, dash: "1.5 2" },
        { kind: "path", d: circleD(x + ew / 2, y + eh * 0.55, 3.2), fill: C.orange, opacity: 0.5 },
      ],
    });
  } else if (subject === 1) {
    // A horizon: two soft hills, a small sun and a pair of birds.
    const base = h * r.range(0.42, 0.55);
    const hill = (x0: number, x1: number, peak: number): string => {
      const pts: [number, number][] = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        pts.push([x0 + (x1 - x0) * t, base - Math.sin(t * Math.PI) * peak]);
      }
      return smoothD(pts, false);
    };
    const sun = { x: w * r.range(0.55, 0.8), y: base - h * r.range(0.16, 0.24), r: r.range(10, 15) };
    const bx = w * r.range(0.2, 0.4);
    const by = Math.max(120, base - h * r.range(0.14, 0.2));
    nodes.push(
      { kind: "path", d: `M0 ${n(base)}H${w}` + hill(-w * 0.1, w * r.range(0.5, 0.65), h * r.range(0.06, 0.1)) + hill(w * r.range(0.35, 0.5), w * 1.1, h * r.range(0.04, 0.08)), ...line },
      { kind: "circle", cx: sun.x, cy: sun.y, r: sun.r, ...line },
      { kind: "path", d: `M${n(bx)} ${n(by)}q4 -4 8 0q4 -4 8 0M${n(bx + 22)} ${n(by + 8)}q3 -3 6 0q3 -3 6 0`, ...line, strokeWidth: 0.9 },
    );
  } else {
    // A fragment of map: a coastline, a dashed road and a pin.
    const coast: [number, number][] = [];
    const y0 = h * r.range(0.2, 0.32);
    for (let i = 0; i <= 9; i++) coast.push([w * (i / 9) * 1.1 - w * 0.05, y0 + h * 0.18 * (i / 9) + r.range(-1, 1) * h * 0.035]);
    const road: [number, number][] = [
      [w * r.range(0.05, 0.2), h * 0.62],
      [w * r.range(0.35, 0.5), h * r.range(0.45, 0.55)],
      [w * r.range(0.6, 0.75), h * r.range(0.4, 0.5)],
    ];
    const pin = road[2]!;
    nodes.push(
      { kind: "path", d: smoothD(coast, false), ...line },
      { kind: "path", d: smoothD(coast.map(([x, y]) => [x, y + 7] as [number, number]), false), ...line, strokeWidth: 0.6, opacity: 0.4 },
      { kind: "path", d: smoothD(road, false), ...line, strokeWidth: 0.9, dash: "4 4" },
      { kind: "path", d: `M${n(pin[0])} ${n(pin[1])}l-5 -9a5.6 5.6 0 1 1 10 0Z`, ...line, fill: C.white },
      { kind: "path", d: circleD(pin[0], pin[1] - 12, 1.8), fill: C.orange, opacity: 0.5 },
    );
  }
  return { width: w, height: h, background: r.pick(GROUNDS), defs: [grain(r, "grain", C.ink, 40)], nodes: [...nodes, { kind: "rect", x: 0, y: 0, w, h, fill: "url(#grain)", opacity: 0.04 }] };
}
