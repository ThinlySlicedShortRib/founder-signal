import { C } from "./colors.ts";
import { contour, dots, halftone, mesh, sky, wash } from "./fields.ts";
import { airmail, letterhead, postmark, ruled, stamp } from "./post.ts";
import { type Rng, rng } from "./random.ts";
import type { Scene } from "./scene.ts";
import { riso, routes, sketch } from "./shapes.ts";

/**
 * The cover art's styles. Each one is a pure function from a seed and a size
 * to a scene. The seed (the letter's id, or the day before there's a letter)
 * picks the style at random (`pickStyle`) and then its details and variant,
 * so a letter always has the same picture and the next one looks different.
 */

export type StyleId =
  | "mesh"
  | "routes"
  | "postmark"
  | "halftone"
  | "riso"
  | "contour"
  | "stamp"
  | "airmail"
  | "letterhead"
  | "sketch"
  | "sky"
  | "wash"
  | "dots"
  | "ruled";

export type ArtInput = {
  width: number;
  height: number;
  /** What the details are drawn from: the letter's id, or the day. */
  seed: string;
  /** The letter's day, YYYY-MM-DD (the postmarks print it). */
  date: string;
  /** The letter's number, if there is one yet. */
  number: number | null;
};

/** The text that sits on the art. Light styles take ink, dark ones white. */
export type ArtText = { primary: string; secondary: string; accent: string };

export type ArtStyle = {
  id: StyleId;
  name: string;
  /** What's behind the status bar and the text: "light" art takes dark text. */
  tone: "light" | "dark";
  /** The colour before the art has drawn (the art's own background, or close to it). */
  base: string;
  text: ArtText;
  /**
   * How opaque the scrim (the scene's background colour) is behind text on
   * the art. The smallest value that keeps every text colour at 4.5:1 over
   * any colour the style can draw, checked by art.test.ts.
   */
  scrim: number;
  draw: (r: Rng, input: ArtInput) => Scene;
};

/** The app's muted grey and blue are a shade too light for art; these are the next ones darker. */
const LIGHT: ArtText = { primary: C.ink, secondary: C.promptInk, accent: C.blueInk };

/** Every style is light now (quiet tints on near-white paper); `tone` stays for the status bar and any dark style later. */
const style = (id: StyleId, name: string, base: string, scrim: number, draw: ArtStyle["draw"]): ArtStyle => ({ id, name, tone: "light", base, text: LIGHT, scrim, draw });

export const STYLES: Record<StyleId, ArtStyle> = {
  mesh: style("mesh", "Morning mesh", C.ground, 0.15, mesh),
  routes: style("routes", "Routes", C.paper, 0.3, routes),
  postmark: style("postmark", "Cancelled", C.ground, 0.2, postmark),
  halftone: style("halftone", "Halftone", C.ground, 0.15, halftone),
  riso: style("riso", "Riso", C.paper, 0.15, riso),
  contour: style("contour", "Survey", C.ground, 0.2, contour),
  stamp: style("stamp", "Stamp", C.ground, 0.25, stamp),
  airmail: style("airmail", "Airmail", C.paper, 0.3, airmail),
  letterhead: style("letterhead", "Letterhead", C.paper, 0.25, letterhead),
  sketch: style("sketch", "Line drawing", C.ground, 0.3, sketch),
  sky: style("sky", "Quiet sky", C.blueTint, 0.25, sky),
  wash: style("wash", "Wash and grid", C.ground, 0.15, wash),
  dots: style("dots", "Dot grid", C.ground, 0.15, dots),
  ruled: style("ruled", "Ruled paper", C.ground, 0.15, ruled),
};

/**
 * Every style, in two alternating sets (even and odd places). Letter N draws
 * from one set and letter N+1 from the other, so two letters running never
 * share a style.
 */
export const STYLE_ORDER: StyleId[] = ["mesh", "routes", "postmark", "halftone", "riso", "contour", "stamp", "airmail", "letterhead", "sketch", "sky", "wash", "dots", "ruled"];

/** The set a letter's place in the sequence draws from. */
export function styleSet(sequence: number): StyleId[] {
  const parity = ((sequence % 2) + 2) % 2;
  return STYLE_ORDER.filter((_, i) => i % 2 === parity);
}

/** Days since 1970-01-01 for a YYYY-MM-DD. */
export function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/**
 * The style for a cover, at random but stable: the seed (a letter's id, or
 * the day before there's a letter) picks it from the set for its place in
 * the sequence, the letter's number or, without one (test letters, the empty
 * and preparing pages), the day. Consecutive letters, and consecutive days,
 * always land in different sets, so the cover never repeats the last one's style.
 */
export function pickStyle({ seed, date, sequence }: { seed: string; date: string; sequence?: number | null }): StyleId {
  return rng(`style:${seed}`).pick(styleSet(sequence ?? dayNumber(date)));
}

/** The scene for a style, seed and size. Same input, same picture. */
export function drawArt(style: StyleId, input: ArtInput): Scene {
  const w = Math.max(1, Math.round(input.width));
  const h = Math.max(1, Math.round(input.height));
  return STYLES[style].draw(rng(`${style}:${input.seed}`), { ...input, width: w, height: h });
}
