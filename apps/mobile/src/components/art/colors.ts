/**
 * The brand colours the art draws with (the same values as `palette` in
 * components/onboarding/kit.tsx, repeated here so this folder's pure code
 * runs in node), and the colour maths for the contrast checks.
 */

export const C = {
  ground: "#FBFBFA",
  ink: "#121316",
  white: "#FFFFFF",
  muted: "#5B5F68",
  promptInk: "#3A3D44",
  blue: "#2B4BFF",
  blueInk: "#1E2F99",
  blueMid: "#8FA1FF",
  blueCard: "#DCE3FF",
  blueTint: "#EEF2FF",
  orange: "#FF5A1F",
  peach: "#FFE3D6",
  orangeTint: "#FFF1EC",
  /** Art only: a warm uncoated stock (riso, routes, letterhead and others). */
  paper: "#F6F2EA",
  /** Art only: a cool, faintly blue stock. */
  fog: "#F4F6FB",
  /** Art only: a soft graphite for line work; text over it keeps 4.5:1 behind each style's scrim. */
  pencil: "#9599A2",
  /** Art only: the blue line work, a step darker than `blueMid` so hairlines read clearly. */
  lineBlue: "#7A8FF6",
  /** Art only: text on dark art (no style is dark today; kept for one that is). */
  mist: "#D5DAEA",
} as const;

/** The grounds the art is drawn on: all near-white, so the cover stays airy. */
export const GROUNDS = [C.ground, C.paper, C.fog] as const;

/**
 * Line work is drawn in these tints (not ink at a low opacity), so a hairline
 * can be crisp and still sit far below the text in contrast.
 */
export const LINES = [C.lineBlue, C.pencil] as const;

export type Rgb = [number, number, number];

export function hex(color: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) throw new Error(`Not a #RRGGBB colour: ${color}`);
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function toHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** `top` at `alpha` over `bottom` (source-over). */
export function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return [0, 1, 2].map((i) => top[i]! * alpha + bottom[i]! * (1 - alpha)) as Rgb;
}

/** Multiply blend, the overprint of two riso inks. */
export function multiply(a: string, b: string): string {
  const [x, y] = [hex(a), hex(b)];
  return toHex([0, 1, 2].map((i) => (x[i]! * y[i]!) / 255) as Rgb);
}

/** `#RRGGBB` at an alpha, as rgba() for gradients outside SVG (expo-linear-gradient). */
export function rgba(color: string, alpha: number): string {
  const [r, g, b] = hex(color);
  return `rgba(${r},${g},${b},${alpha})`;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio. */
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
