# Cover art (Today's backgrounds)

Today's cover, the empty Today and the "being put together" page sit on a
generative art band instead of a wall of text. The art is vector
(react-native-svg), drawn in code from a seed, so it's tiny, crisp, needs no
network and a letter always has the same picture.

Code: `apps/mobile/src/components/art/`. The generators are pure TypeScript
(no React Native), so node runs them for the tests and for these samples.

## Picking

- **Style: at random, per letter.** `pickStyle` draws the style from the
  seed (a letter's id; before there's a letter, the day), so a letter always
  has the same cover and different letters land on different styles at random.
- **Never the previous letter's style.** `STYLE_ORDER` is split into two
  alternating sets of seven (even and odd places). The pick draws from the set
  for the letter's number (`sequence`), so letter N and letter N+1 always come
  from different sets and can't repeat. Test letters and the pages before a
  letter (empty Today, "being put together") have no number, so they use the
  day instead, and consecutive days alternate the same way. A style can come
  back two letters later (1 in 7).
- **Details and variant: the seed.** `drawArt` seeds each style with
  `<style>:<seed>`; within a style the seed also picks the variant (ground,
  palette, composition, and for some styles the subject), so a style that
  comes back still looks new.
- The postmark, stamp and letterhead print the letter's date and/or number
  (the day of the month before there's a number).
- Dev tools can force a style on Today (in memory, development builds).

## The look

Quiet and editorial: a near-white ground (ground #FBFBFA, warm paper #F6F2EA
or cool fog #F4F6FB; the sky uses a pale brand tint), brand colours only as
tints (blue card, blue tint, peach, orange tint), line work in hairlines of a
light blue (#8FA1FF) or graphite (#A6AAB3) rather than ink, orange only as a
tiny accent (a seal, a pin, a margin rule), little or no grain, and a lot of
open paper. Elements keep clear of the masthead (top ~110pt) and mostly of the
text block at the bottom. Every style is light now (`tone: "light"`); the
dark ones (routes, halftone, contour) were redrawn as pale versions.

## Styles

Each style has a few variants, picked by the seed.

| Style | Id | Scrim | What it is (variants) |
|---|---|---|---|
| Morning mesh | `mesh` | 0.15 | Three pale blobs of brand tints melting together, sometimes a breath of blue, faint grain. (4 palettes, ground or fog.) Was: five saturated blobs including blue mid and orange. |
| Routes | `routes` | 0.25 | A pale map: 5–7 towns as fine points, dotted roads, one journey in a hairline ending at a tiny outlined envelope and an orange pin. (Blue or graphite lines, paper/fog/ground, with or without meridians.) Was: white and orange on full-bleed ink with stars. |
| Cancelled | `postmark` | 0.15 | A small hairline date stamp (Founder Signal, the date, No. N) with four dashed waves over a small pale stamp. (3 grounds, 3 stamp tints, blue or graphite.) Was: a big blue stamp over an orange stamp. |
| Halftone | `halftone` | 0.15 | A soft sun of fine pale dots growing out of one corner, the rest left clear. (4 positions, blue or faint orange dots, two screens.) Was: big dots on full-bleed blue with an orange ring. |
| Riso | `riso` | 0.15 | Two or three pale shapes (blue card, peach) overprinted on paper, gathered to one side, sometimes one tiny orange dot. (3 ink pairs, side, paper or ground.) Was: three or four big blue and orange shapes. |
| Survey | `contour` | 0.15 | Hairline contour lines around one hill, stopping short of the far corners, sometimes one line in faint orange. (Blue or graphite, 3 grounds.) Was: blue mid and orange lines on full-bleed blue ink. |
| Stamp | `stamp` | 0.15 | One smaller perforated stamp in pale tints with the letter's number, lightly cancelled at a corner. (4 ground/panel pairs, blue or graphite.) Was: a big orange or blue stamp. |
| Airmail | `airmail` | 0.15 | A thin, pale striped border (sometimes none), a hairline "Par avion" label and a dotted flight to a small outlined paper plane. Was: a bold blue and orange border and an orange plane. |
| Letterhead | `letterhead` | 0.15 | Paper with a faint watermark (a seal with "FS", or the letter's number) and a fine double rule broken by a small orange diamond. New. |
| Line drawing | `sketch` | 0.25 | One small drawing in a single hairline: an envelope with a seal, a horizon with hills, a sun and birds, or a map fragment with a coastline, a road and a pin. New. |
| Quiet sky | `sky` | 0.15 | A two-tint sky over a hairline horizon, with a small soft sun or a crescent moon and a thin cloud or two. (4 skies.) New. |
| Wash and grid | `wash` | 0.15 | A soft two-tint gradient wash with a fine drafting grid, sometimes one firmer rule like a fold. (4 washes, 3 grid sizes, straight or diagonal.) New. |
| Dot grid | `dots` | 0.15 | An even grid of tiny dots fading out from one edge into plain paper. (3 pitches, straight or staggered, 4 directions.) New. |
| Ruled paper | `ruled` | 0.15 | Faint ruled lines (or squares) starting below the masthead, with a faint orange margin rule outside the text (left edge or right, single or double). New. |

## Text and contrast

Text on the art is the same on every style: ink, the prompt grey (#3A3D44)
and blue ink (#1E2F99) (the app's muted grey and blue are a shade too light
on art). The masthead row and the text block sit on a scrim of the art's own
background colour at the style's scrim opacity, with a 72px soft edge. The
scrims went from 0.35–0.85 to 0.15–0.25: the art is quiet enough that the
scrim is mostly a softening, not a shield.

The scrim values are checked, not guessed: `contrast.ts` takes every colour a
scene can paint (fills, strokes, gradient stops, grain, at their strongest
opacity), layers them up to two deep over the background, puts the scrim on
top and takes the worst case. `art.test.ts` asserts every text colour keeps
**4.5:1** over 30 seeds × 4 screen sizes for every style, and that no scrim
is lower than needed. With the tinted hairlines most styles would pass with
no scrim at all; routes and line drawing need 0.25 (an orange accent over a
blue line, two deep). A floor of 0.15 is kept everywhere so the art softens
under the text. The tests also check the grounds stay pale, the scrims stay
at or under 0.3, and the line tints keep 4.5:1 against blue ink.

The status bar is dark over every style now (all light), and stays dark once
the page has scrolled past the art.

## Performance

Each scene is at most about two dozen SVG elements (the test caps it at 40,
and the SVG at 30 KB; it was 60 and 60 KB):
grain is one small repeated pattern tile, repeated dots share a path per size
(halftone is a thousand dots in about 20 elements), lines of the same weight
share a path. A scene is generated in about a millisecond or less in node
(halftone, the biggest, about 1ms worst case) and its SVG is 1–18 KB; both
are memoised per seed and size. The preparing page's drift is a single
Reanimated transform on the whole band (off with Reduce Motion).

## Previewing

- **Dev tools → Backgrounds** (development builds): every style with three
  seeds (so the variants show); tap one to force it on Today until the app
  reloads (in memory only), "Random per letter" to go back.
- **Samples here**: `<style>-1.svg` to `<style>-3.svg`, a 390×844 phone with
  sample cover text laid out like the app (the text is wrapped by an estimate;
  the fonts load from Google Fonts when the file is opened directly in a
  browser). Regenerate with `pnpm --filter @fs/mobile backgrounds`.
- **Screenshots** of the web build: `screens/today-<style>.png` (each style
  forced on a real letter, 390×844), `screens/dev-backgrounds.png`, and
  `screens/today-375x667-long-intro.png` (a small screen with a ~190-character
  intro in the card, injected in the browser to check the layout).

Tests: `pnpm --filter @fs/mobile test` (node's own test runner).
