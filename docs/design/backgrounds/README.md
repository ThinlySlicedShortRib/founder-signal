# Cover art (Today's backgrounds)

Today's cover, the empty Today and the "being put together" page sit on a
generative art band instead of a wall of text. The art is vector
(react-native-svg), drawn in code from a seed, so it's tiny, crisp, needs no
network and a letter always has the same picture.

Code: `apps/mobile/src/components/art/`. The generators are pure TypeScript
(no React Native), so node runs them for the tests and for these samples.

## Seeding

- **Style: the day.** `styleForDay(localDate)` walks `STYLE_ORDER` one style a
  day, so two days running never share a style and light and dark mostly
  alternate.
- **Details: the seed.** A letter's cover is seeded by its id; the empty Today
  and the preparing page (no letter yet) by the day. The same seed and size
  always draw the same scene (`drawArt`), a different letter on the same day
  gets the same style with different details.
- The postmark and stamp print the letter's date and number (the day of the
  month before there's a number).

## Styles

| Style | Id | Tone | Scrim | What it is |
|---|---|---|---|---|
| Morning mesh | `mesh` | light | 0.35 | Soft radial blobs of blue card, peach, blue mid and a little orange melting into each other, with film grain. |
| Routes | `routes` | dark | 0.70 | Towns as dots on ink, dotted routes between them, one orange journey ending at a small envelope; faint stars and latitude lines. |
| Cancelled | `postmark` | light | 0.50 | A round date stamp (Founder Signal, the date, No. N) in blue, its wavy cancellation lines running over a small orange stamp. |
| Halftone | `halftone` | dark | 0.85 | A big soft sun in pale dots on blue, and an orange ring screened at another angle. |
| Riso | `riso` | light | 0.65 | Three or four big flat shapes in blue and orange on warm paper, darker where the inks overprint (multiply), with paper speckle. |
| Survey | `contour` | dark | 0.80 | Topographic contour lines around one hill on blue ink, every fifth heavier, one in orange. |
| Stamp | `stamp` | light | 0.70 | One big perforated stamp carrying the letter's number, cancelled at a corner, on blue card or peach. |
| Airmail | `airmail` | light | 0.60 | The envelope's blue and orange striped border, a "Par avion" label and a dotted flight ending in a paper plane. |

## Text and contrast

Text on the art uses each style's colours: light styles take ink, the prompt
grey (#3A3D44) and blue ink (#1E2F99) (the app's muted grey and blue are a
shade too light on coloured art); dark styles take white, mist (#D5DAEA) and
peach (halftone: white only). The masthead row and the text block sit on a
scrim of the art's own background colour at the style's scrim opacity, with a
72px soft edge.

The scrim values are checked, not guessed: `contrast.ts` takes every colour a
scene can paint (fills, strokes, gradient stops, grain, at their strongest
opacity), layers them up to two deep over the background, puts the scrim on
top and takes the worst case. `art.test.ts` asserts every text colour keeps
**4.5:1** (body text's bar, so the 38pt headline's 3:1 is met with room) over
30 seeds × 4 screen sizes for every style, and that no scrim is heavier than
needed. That's conservative: real text mostly sits on much calmer areas.

The status bar follows the art's tone (light text over the dark styles) and
goes dark once the page has scrolled past the art.

## Performance

Each scene is at most a few dozen SVG elements (the test caps it at 60):
grain is one small repeated pattern tile, repeated dots share a path per size
(halftone is a thousand dots in about 20 elements), lines of the same weight
share a path. A scene is generated in well under a millisecond in node
(halftone and contour, the biggest, about 0.5ms) and its SVG is 4–30 KB; both
are memoised per seed and size. The preparing page's drift is a single
Reanimated transform on the whole band (off with Reduce Motion).

## Previewing

- **Dev tools → Backgrounds** (development builds): every style with three
  seeds; tap one to force it on Today until the app reloads (in memory only),
  "Daily" to go back.
- **Samples here**: `<style>-1.svg` and `<style>-2.svg`, a 390×844 phone with
  sample cover text laid out like the app (the text is wrapped by an estimate;
  the fonts load from Google Fonts when the file is opened directly in a
  browser). Regenerate with `pnpm --filter @fs/mobile backgrounds`.
- **Screenshots** of the web build: `screens/today-<style>.png` (each style
  forced on a real letter) and `screens/dev-backgrounds.png`.

Tests: `pnpm --filter @fs/mobile test` (node's own test runner).
