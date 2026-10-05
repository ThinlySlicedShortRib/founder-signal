/**
 * Writes every cover art style to docs/design/backgrounds as SVG, three seeds
 * each (so the variants show), on a 390×844 phone with sample cover text laid out like CoverPage
 * (approximately: the text is wrapped by an estimate, not measured).
 *
 *   pnpm --filter @fs/mobile backgrounds
 */
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { C } from "../src/components/art/colors.ts";
import { HERO } from "../src/components/art/layout.ts";
import { type Scene, toSvg } from "../src/components/art/scene.ts";
import { drawArt, STYLE_ORDER, STYLES, type StyleId } from "../src/components/art/styles.ts";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/design/backgrounds");
const [W, H, TOP] = [390, 844, 47];
const HERO_H = Math.round(H * HERO.share);
const SAMPLES = [
  { seed: "sample-1", date: "2026-10-05", number: 12, headline: "Price it before you build it" },
  { seed: "sample-2", date: "2026-10-06", number: 128, headline: "The quiet weeks are the work" },
  { seed: "sample-3", date: "2026-10-07", number: 7, headline: "Ship the boring version first" },
];
const PIECES = ["What a first price tells you", "Selling to the first ten", "Founders on saying no", "A teardown of one onboarding"];
const FONTS = { display: "Bricolage Grotesque", displayWeight: 700, mono: "JetBrains Mono", monoWeight: 500 };
const HEAD = `<style>@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700&amp;family=Instrument+Sans:wght@400;600&amp;family=JetBrains+Mono:wght@500&amp;display=swap');</style>`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Greedy wrap by an average glyph width. */
function wrap(text: string, size: number, width: number, glyph: number): string[] {
  const max = Math.floor(width / (size * glyph));
  const lines: string[] = [];
  for (const word of text.split(" ")) {
    const last = lines.at(-1);
    if (last !== undefined && (last + " " + word).length <= max) lines[lines.length - 1] = last + " " + word;
    else lines.push(word);
  }
  return lines;
}

function text(x: number, y: number, s: string, size: number, family: string, fill: string, extra = ""): string {
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`;
}

/** The cover's text and the scrims behind it, over the art band; the brief and contents below. */
function cover(scene: Scene, style: StyleId, s: (typeof SAMPLES)[number]): string {
  const st = STYLES[style];
  const t = st.text;
  const bg = scene.background;
  const a = st.scrim;
  const lines = wrap(s.headline, 38, W - 40, 0.5);
  const blockH = 15 + 14 + lines.length * 40 + 12 + 22 + HERO.bottomPad;
  const blockTop = HERO_H - blockH;
  const mastBottom = TOP + HERO.mastHeight;
  let out =
    `<defs><linearGradient id="st" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg}" stop-opacity="${a}"/><stop offset="1" stop-color="${bg}" stop-opacity="0"/></linearGradient>` +
    `<linearGradient id="sb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg}" stop-opacity="0"/><stop offset="1" stop-color="${bg}" stop-opacity="${a}"/></linearGradient></defs>` +
    `<rect y="0" width="${W}" height="${mastBottom}" fill="${bg}" opacity="${a}"/><rect y="${mastBottom}" width="${W}" height="${HERO.fade}" fill="url(#st)"/>` +
    `<rect y="${blockTop - HERO.fade}" width="${W}" height="${HERO.fade}" fill="url(#sb)"/><rect y="${blockTop}" width="${W}" height="${HERO_H - blockTop}" fill="${bg}" opacity="${a}"/>`;
  // Masthead and progress bars.
  out += text(20, TOP + 26, `FOUNDER SIGNAL · NO. ${s.number}`, 11, "JetBrains Mono", t.secondary, `letter-spacing="0.88"`);
  for (let i = 0; i < 6; i++) out += `<rect x="${W - 20 - (6 - i) * 22 + 4}" y="${TOP + 20}" width="18" height="4" rx="2" fill="${st.tone === "dark" ? "#FFFFFF" : C.ink}" opacity="${i === 0 ? 1 : 0.25}"/>`;
  // Kicker, headline, greeting and date.
  let y = blockTop + 15;
  out += text(20, y, `LETTER NO. ${s.number} · ARRIVED MON 7:02 AM`, 11, "JetBrains Mono", t.accent, `letter-spacing="0.88"`);
  y += 14;
  for (const line of lines) {
    y += 40;
    out += text(20, y - 9, line, 38, "Bricolage Grotesque", t.primary, `font-weight="700" letter-spacing="-1.14"`);
  }
  y += 22;
  out += `<text x="20" y="${y}" font-family="Instrument Sans" font-size="16" fill="${t.primary}"><tspan font-weight="600">Good morning</tspan><tspan fill="${t.secondary}"> · Monday, October 5</tspan></text>`;
  // Below the art: the brief and the contents.
  y = HERO_H + 18;
  out += `<rect x="20" y="${y}" width="${W - 40}" height="68" rx="16" fill="#FFF4EE"/><circle cx="42" cy="${y + 23}" r="8" fill="${C.orange}"/>`;
  out += text(60, y + 28, "Four pieces on pricing early, and one on", 15, "Instrument Sans", "#3A2418") + text(60, y + 50, "saying no to the wrong customers… More", 15, "Instrument Sans", "#3A2418");
  y += 86;
  PIECES.forEach((p, i) => {
    out += `<rect x="20" y="${y}" width="${W - 40}" height="1" fill="${C.ink}" opacity="0.12"/>`;
    out += `<rect x="20" y="${y + 14}" width="28" height="28" rx="8" fill="${[C.blueCard, C.peach, "#ECEEF2"][i % 3]}"/>`;
    out += text(26, y + 33, `0${i + 1}`, 12, "JetBrains Mono", C.ink) + text(60, y + 33, p, 15, "Instrument Sans", C.ink, `font-weight="600"`) + text(W - 20, y + 33, `${4 + i} min`, 13, "Instrument Sans", C.muted, `text-anchor="end"`);
    y += 56;
  });
  // The pill.
  out += `<rect x="${W / 2 - 120}" y="${H - 34 - 54}" width="240" height="54" rx="27" fill="${C.ink}"/>`;
  return `<rect y="${HERO_H}" width="${W}" height="${H - HERO_H}" fill="${C.ground}"/>` + out;
}

mkdirSync(OUT, { recursive: true });
// Clear the old samples (styles come and go).
for (const f of readdirSync(OUT)) if (/^[a-z]+-\d\.svg$/.test(f)) unlinkSync(resolve(OUT, f));
for (const style of STYLE_ORDER) {
  SAMPLES.forEach((s, i) => {
    const scene = drawArt(style, { width: W, height: HERO_H, seed: s.seed, date: s.date, number: s.number });
    writeFileSync(resolve(OUT, `${style}-${i + 1}.svg`), toSvg(scene, FONTS, { head: HEAD, inner: cover(scene, style, s), height: H }));
  });
}
console.log(`Wrote ${STYLE_ORDER.length * SAMPLES.length} samples to ${OUT}`);
