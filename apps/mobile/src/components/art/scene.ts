/**
 * The art's scene: a few SVG primitives as plain data, and `toSvg` to turn a
 * scene into an SVG string. The app renders that string with react-native-svg
 * (SvgXml); the docs script writes the same string to a file, so what's
 * reviewed in docs/design/backgrounds is what the phone draws.
 */

type Paint = {
  /** A colour ("#RRGGBB") or a def ("url(#id)"). */
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  dash?: string;
  /** A clip def's id. */
  clip?: string;
  transform?: string;
};

export type ArtNode =
  | ({ kind: "rect"; x: number; y: number; w: number; h: number; rx?: number } & Paint)
  | ({ kind: "circle"; cx: number; cy: number; r: number } & Paint)
  | ({ kind: "path"; d: string } & Paint)
  | ({ kind: "text"; x: number; y: number; text: string; size: number; font: "display" | "mono"; anchor?: "start" | "middle" | "end"; spacing?: number } & Paint)
  | { kind: "group"; children: ArtNode[]; opacity?: number; transform?: string; clip?: string };

export type Stop = { offset: number; color: string; opacity?: number };

export type ArtDef =
  | { kind: "radial"; id: string; cx: number; cy: number; r: number; stops: Stop[] }
  | { kind: "linear"; id: string; x1: number; y1: number; x2: number; y2: number; stops: Stop[] }
  | { kind: "pattern"; id: string; size: number; children: ArtNode[] }
  | { kind: "clip"; id: string; children: ArtNode[] };

export type Scene = { width: number; height: number; background: string; defs: ArtDef[]; nodes: ArtNode[] };

/** Font families for text nodes: the app's loaded font names, or CSS families for a browser. */
export type SceneFonts = { display: string; mono: string; displayWeight?: number; monoWeight?: number };

// ── Geometry helpers ─────────────────────────────────────────────────────────

/** One decimal is plenty on a phone and keeps the strings short. */
export const n = (v: number) => String(Math.round(v * 10) / 10);

/** A circle as a sub-path, so hundreds of dots can share one <path>. */
export function circleD(cx: number, cy: number, r: number): string {
  return `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0`;
}

export function polygonD(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${n(x)} ${n(y)}`).join("") + "Z";
}

/** A smooth curve through points (Catmull-Rom as cubic Béziers). */
export function smoothD(points: [number, number][], closed: boolean): string {
  const p = points;
  const len = p.length;
  const at = (i: number) => (closed ? p[(i + len) % len]! : p[Math.max(0, Math.min(len - 1, i))]!);
  let d = `M${n(p[0]![0])} ${n(p[0]![1])}`;
  const segs = closed ? len : len - 1;
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${n(c1[0]!)} ${n(c1[1]!)} ${n(c2[0]!)} ${n(c2[1]!)} ${n(p2[0])} ${n(p2[1])}`;
  }
  return closed ? d + "Z" : d;
}

/**
 * Many dots of a few sizes: each size is one path of near-zero-length strokes
 * with round caps (12 characters a dot instead of ~40 for arcs), so a
 * halftone screen of a thousand dots stays a handful of elements.
 */
export function dotNodes(dots: [number, number, number][], color: string, opacity: number): ArtNode[] {
  const bySize = new Map<number, string>();
  for (const [x, y, r] of dots) {
    const size = Math.round(r * 2) / 2;
    bySize.set(size, (bySize.get(size) ?? "") + `M${Math.round(x)} ${Math.round(y)}h.01`);
  }
  return [...bySize].map(([size, d]) => ({ kind: "path", d, stroke: color, strokeWidth: size * 2, opacity }));
}

/** Film grain / paper tooth: a small tile of specks, repeated by the renderer (not per pixel). */
export function grain(r: { next(): number }, id: string, color: string, specks = 70, size = 56): ArtDef {
  let d = "";
  for (let i = 0; i < specks; i++) {
    const s = 0.6 + r.next() * 0.9;
    d += `M${n(r.next() * size)} ${n(r.next() * size)}h${n(s)}v${n(s)}h${n(-s)}Z`;
  }
  return { kind: "pattern", id, size, children: [{ kind: "path", d, fill: color }] };
}

// ── SVG output ───────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function paintAttrs(p: Paint): string {
  let a = "";
  a += ` fill="${p.fill ?? "none"}"`;
  if (p.stroke) a += ` stroke="${p.stroke}" stroke-width="${n(p.strokeWidth ?? 1)}" stroke-linecap="round" stroke-linejoin="round"`;
  if (p.dash) a += ` stroke-dasharray="${p.dash}"`;
  if (p.opacity !== undefined && p.opacity < 1) a += ` opacity="${n2(p.opacity)}"`;
  if (p.clip) a += ` clip-path="url(#${p.clip})"`;
  if (p.transform) a += ` transform="${p.transform}"`;
  return a;
}

const n2 = (v: number) => String(Math.round(v * 100) / 100);

function nodeSvg(node: ArtNode, fonts: SceneFonts): string {
  switch (node.kind) {
    case "rect":
      return `<rect x="${n(node.x)}" y="${n(node.y)}" width="${n(node.w)}" height="${n(node.h)}"${node.rx ? ` rx="${n(node.rx)}"` : ""}${paintAttrs(node)}/>`;
    case "circle":
      return `<circle cx="${n(node.cx)}" cy="${n(node.cy)}" r="${n(node.r)}"${paintAttrs(node)}/>`;
    case "path":
      return `<path d="${node.d}"${paintAttrs(node)}/>`;
    case "text": {
      const family = node.font === "display" ? fonts.display : fonts.mono;
      const weight = node.font === "display" ? fonts.displayWeight : fonts.monoWeight;
      return (
        `<text x="${n(node.x)}" y="${n(node.y)}" font-family="${family}"${weight ? ` font-weight="${weight}"` : ""} font-size="${n(node.size)}"` +
        `${node.anchor ? ` text-anchor="${node.anchor}"` : ""}${node.spacing ? ` letter-spacing="${n(node.spacing)}"` : ""}${paintAttrs(node)}>${esc(node.text)}</text>`
      );
    }
    case "group":
      return `<g${node.opacity !== undefined ? ` opacity="${n2(node.opacity)}"` : ""}${node.transform ? ` transform="${node.transform}"` : ""}${node.clip ? ` clip-path="url(#${node.clip})"` : ""}>${node.children.map((c) => nodeSvg(c, fonts)).join("")}</g>`;
  }
}

function stopsSvg(stops: Stop[]): string {
  return stops.map((s) => `<stop offset="${n2(s.offset)}" stop-color="${s.color}" stop-opacity="${n2(s.opacity ?? 1)}"/>`).join("");
}

function defSvg(def: ArtDef, fonts: SceneFonts): string {
  switch (def.kind) {
    case "radial":
      return `<radialGradient id="${def.id}" gradientUnits="userSpaceOnUse" cx="${n(def.cx)}" cy="${n(def.cy)}" r="${n(def.r)}">${stopsSvg(def.stops)}</radialGradient>`;
    case "linear":
      return `<linearGradient id="${def.id}" gradientUnits="userSpaceOnUse" x1="${n(def.x1)}" y1="${n(def.y1)}" x2="${n(def.x2)}" y2="${n(def.y2)}">${stopsSvg(def.stops)}</linearGradient>`;
    case "pattern":
      return `<pattern id="${def.id}" patternUnits="userSpaceOnUse" width="${def.size}" height="${def.size}">${def.children.map((c) => nodeSvg(c, fonts)).join("")}</pattern>`;
    case "clip":
      return `<clipPath id="${def.id}">${def.children.map((c) => nodeSvg(c, fonts)).join("")}</clipPath>`;
  }
}

/** The scene as an SVG document. `inner` adds markup on top (the docs script's sample text). */
export function toSvg(scene: Scene, fonts: SceneFonts, extra?: { head?: string; inner?: string; height?: number }): string {
  const h = extra?.height ?? scene.height;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${h}" viewBox="0 0 ${scene.width} ${h}">` +
    (extra?.head ?? "") +
    `<defs>${scene.defs.map((d) => defSvg(d, fonts)).join("")}</defs>` +
    `<rect width="${scene.width}" height="${scene.height}" fill="${scene.background}"/>` +
    scene.nodes.map((node) => nodeSvg(node, fonts)).join("") +
    (extra?.inner ?? "") +
    `</svg>`
  );
}

/** How many SVG elements a scene draws (pattern tiles count once): kept small so the phone renders it fast. */
export function elementCount(scene: Scene): number {
  const count = (nodes: ArtNode[]): number => nodes.reduce((sum, node) => sum + 1 + (node.kind === "group" ? count(node.children) : 0), 0);
  return 1 + count(scene.nodes) + scene.defs.reduce((sum, d) => sum + 1 + ("children" in d ? count(d.children) : d.stops.length), 0);
}
