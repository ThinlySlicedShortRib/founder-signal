import { C } from "./colors.ts";
import { contour, halftone, mesh } from "./fields.ts";
import { airmail, postmark, stamp } from "./post.ts";
import { type Rng, rng } from "./random.ts";
import type { Scene } from "./scene.ts";
import { riso, routes } from "./shapes.ts";

/**
 * The cover art's styles. Each one is a pure function from a seed and a size
 * to a scene; the day picks the style and the seed (the letter's id, or the
 * day before there's a letter) the details, so a letter always has the same
 * picture and the next day's looks different.
 */

export type StyleId = "mesh" | "routes" | "postmark" | "halftone" | "riso" | "contour" | "stamp" | "airmail";

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

/** The app's muted grey and blue are a shade too light for coloured art; these are the next ones darker. */
const LIGHT: ArtText = { primary: C.ink, secondary: C.promptInk, accent: C.blueInk };

export const STYLES: Record<StyleId, ArtStyle> = {
  mesh: { id: "mesh", name: "Morning mesh", tone: "light", base: C.ground, text: LIGHT, scrim: 0.35, draw: mesh },
  routes: { id: "routes", name: "Routes", tone: "dark", base: C.ink, text: { primary: C.white, secondary: C.mist, accent: C.peach }, scrim: 0.7, draw: routes },
  postmark: { id: "postmark", name: "Cancelled", tone: "light", base: C.ground, text: LIGHT, scrim: 0.5, draw: postmark },
  halftone: { id: "halftone", name: "Halftone", tone: "dark", base: C.blue, text: { primary: C.white, secondary: C.white, accent: C.white }, scrim: 0.85, draw: halftone },
  riso: { id: "riso", name: "Riso", tone: "light", base: C.paper, text: LIGHT, scrim: 0.65, draw: riso },
  contour: { id: "contour", name: "Survey", tone: "dark", base: C.blueInk, text: { primary: C.white, secondary: C.mist, accent: C.peach }, scrim: 0.8, draw: contour },
  stamp: { id: "stamp", name: "Stamp", tone: "light", base: C.blueCard, text: LIGHT, scrim: 0.7, draw: stamp },
  airmail: { id: "airmail", name: "Airmail", tone: "light", base: C.paper, text: LIGHT, scrim: 0.6, draw: airmail },
};

/** One a day, in this order, so two days running never share a style (and light and dark alternate where they can). */
export const STYLE_ORDER: StyleId[] = ["mesh", "routes", "postmark", "halftone", "riso", "contour", "stamp", "airmail"];

/** Days since 1970-01-01 for a YYYY-MM-DD. */
export function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

export function styleForDay(date: string): StyleId {
  return STYLE_ORDER[dayNumber(date) % STYLE_ORDER.length]!;
}

/** The scene for a style, seed and size. Same input, same picture. */
export function drawArt(style: StyleId, input: ArtInput): Scene {
  const w = Math.max(1, Math.round(input.width));
  const h = Math.max(1, Math.round(input.height));
  return STYLES[style].draw(rng(`${style}:${input.seed}`), { ...input, width: w, height: h });
}
