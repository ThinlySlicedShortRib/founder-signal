import { C } from "./colors.ts";
import type { Rng } from "./random.ts";
import { type ArtDef, type ArtNode, circleD, dotNodes, grain, type Scene, smoothD } from "./scene.ts";
import type { ArtInput } from "./styles.ts";

/** Morning mesh: soft blobs of the brand tints melting into each other, with film grain. */
export function mesh(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const big = Math.max(w, h);
  const blobs: [string, number][] = [
    [C.blueCard, 1],
    [C.peach, 1],
    [r.pick([C.blueTint, C.orangeTint]), 1],
    [C.blueMid, 0.62],
    [C.orange, 0.42],
  ];
  const defs: ArtDef[] = [];
  const nodes: ArtNode[] = [];
  blobs.forEach(([color, alpha], i) => {
    const accent = i >= 3;
    const cx = r.range(-0.1, 1.1) * w;
    const cy = r.range(accent ? 0.1 : -0.1, accent ? 0.6 : 0.9) * h;
    const rad = big * (accent ? r.range(0.28, 0.42) : r.range(0.45, 0.7));
    defs.push({
      kind: "radial",
      id: `b${i}`,
      cx,
      cy,
      r: rad,
      stops: [
        { offset: 0, color, opacity: alpha },
        { offset: 0.5, color, opacity: alpha * 0.55 },
        { offset: 1, color, opacity: 0 },
      ],
    });
    nodes.push({ kind: "circle", cx, cy, r: rad, fill: `url(#b${i})` });
  });
  defs.push(grain(r, "grain", C.ink, 80));
  nodes.push({ kind: "rect", x: 0, y: 0, w, h, fill: "url(#grain)", opacity: 0.16 });
  return { width: w, height: h, background: C.ground, defs, nodes };
}

/** Survey: topographic contour lines around one hill, every fifth line heavier, one in orange. */
export function contour(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const cx = r.range(0.5, 0.85) * w;
  const cy = r.range(0.18, 0.42) * h;
  const step = Math.max(w, h) * 0.05;
  const harmonics = [2, 3, 5].map((j) => ({ j, a: (step * r.range(0.8, 1.7)) / Math.sqrt(j), phase: r.range(0, Math.PI * 2) }));
  const drift = [r.range(-0.25, 0.25) * step, r.range(0.05, 0.3) * step];
  const reach = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) + step * 2;
  const rings = Math.min(22, Math.ceil(reach / step));
  const orange = r.int(5, 11);
  const nodes: ArtNode[] = [];
  // Lines of the same weight share a path.
  const groups = { thin: "", index: "" };
  for (let k = 1; k <= rings; k++) {
    const g = k / rings;
    const ox = cx + drift[0]! * k;
    const oy = cy + drift[1]! * k;
    const pts: [number, number][] = [];
    for (let i = 0; i < 40; i++) {
      const t = (i / 40) * Math.PI * 2;
      const rad = k * step + harmonics.reduce((s, { j, a, phase }) => s + a * Math.sin(j * t + phase + k * 0.06), 0) * g * 1.6;
      pts.push([ox + Math.cos(t) * rad, oy + Math.sin(t) * rad]);
    }
    const d = smoothD(pts, true);
    if (k === orange) nodes.push({ kind: "path", d, stroke: C.orange, strokeWidth: 1.8 });
    else if (k % 5 === 0) groups.index += d;
    else groups.thin += d;
  }
  nodes.unshift(
    { kind: "path", d: groups.thin, stroke: C.blueMid, strokeWidth: 1, opacity: 0.4 },
    { kind: "path", d: groups.index, stroke: C.blueMid, strokeWidth: 1.6, opacity: 0.75 },
  );
  // The summit.
  nodes.push({ kind: "path", d: circleD(cx, cy, 2.5), fill: C.white, opacity: 0.85 });
  const defs = [grain(r, "grain", C.white, 60)];
  nodes.push({ kind: "rect", x: 0, y: 0, w, h, fill: "url(#grain)", opacity: 0.1 });
  return { width: w, height: h, background: C.blueInk, defs, nodes };
}

/** Halftone: a big soft sun in pale dots on blue, and an orange ring screened at another angle. */
export function halftone(r: Rng, { width: w, height: h }: ArtInput): Scene {
  const big = Math.max(w, h);
  const sun = { x: r.range(0.25, 0.85) * w, y: r.range(0.1, 0.4) * h, r: big * r.range(0.55, 0.75) };
  const ring = { x: r.range(0, 1) * w, y: r.range(0.25, 0.6) * h, r: big * r.range(0.18, 0.3), width: big * 0.12 };
  const angle = (r.range(20, 40) * Math.PI) / 180;

  // Pale dots: one grid, radius from the distance to the sun.
  const s = 16;
  const pale: [number, number, number][] = [];
  for (let y = s / 2; y < h + s; y += s) {
    for (let x = s / 2; x < w + s; x += s) {
      const f = Math.max(0, 1 - Math.hypot(x - sun.x, y - sun.y) / sun.r);
      const rad = s * 0.48 * f ** 1.1;
      if (rad > 1) pale.push([x, y, rad]);
    }
  }

  // Orange dots: a rotated grid, radius peaking on the ring.
  const s2 = 12;
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const warm: [number, number, number][] = [];
  const span = Math.ceil(big / s2) + 4;
  for (let i = -span; i <= span; i++) {
    for (let j = -span; j <= span; j++) {
      const x = ring.x + (i * cos - j * sin) * s2;
      const y = ring.y + (i * sin + j * cos) * s2;
      if (x < -s2 || y < -s2 || x > w + s2 || y > h + s2) continue;
      const f = Math.max(0, 1 - Math.abs(Math.hypot(x - ring.x, y - ring.y) - ring.r) / ring.width);
      const rad = s2 * 0.42 * f;
      if (rad > 1) warm.push([x, y, rad]);
    }
  }
  return {
    width: w,
    height: h,
    background: C.blue,
    defs: [],
    nodes: [...dotNodes(pale, C.blueCard, 0.9), ...dotNodes(warm, C.orange, 0.95)],
  };
}
