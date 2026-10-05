# Layout 6 · Pager (chosen app layout)

Sources of the boards on the design canvas (private to the owner):
https://claude.ai/artifact/EtAgfRpJUbxYuhHncQuK9k (row "Layout 6", and P.S. 5 in the "Postscript" row).
Each `*.dc.html` is one artboard: markup plus a small state machine in the
`<script type="text/x-dc">` block. Images reference canvas uploads (`/_blob/…`);
the same photos are on Unsplash (credits in `apps/api/src/lib/letter-fixture.ts`).

| Board | What it shows |
|---|---|
| `PagerToday` | Today as full-screen pages: cover → pieces → P.S. Piece pages over a photo, dark gradient, progressive blur behind text, author chip. Pull up (140px threshold, resistance, spring back) to read in place (the app now scrolls instead; see below). |
| `PagerReader` | Reading in place: photo header 200px → white 72px bar on scroll, author card, every action in the floating pill (save, time left ring, next section, ••• tray), verdict in the pill at the end, then "Next". |
| `PagerVideo` | A video piece: play button on the still; transcript in chapters. |
| `PagerLibrary`, `PagerActivity`, `PagerPreferences` | The rest of the app under the same floating pill + big-type menu sheet. |
| `PsCountdown` | The chosen P.S. (board "P.S. 5"): a short recap, "See you Tuesday, 7:30.", "Tomorrow, more of" multi-select + "+ Your own". The recap is always there: a quick summary of the pieces written with the letter, rewritten from the user's verdicts once they give any (build plan §6.5). It runs two to four lines, and the page scrolls when it needs to. |

Decisions: no tab bar (pill + menu sheet); moving between pieces is the pill's
↑/↓ and the "Up next" card (scrolling down reads the piece); verdict asked once, at the
end of the piece, with "Skip this one" up front; full text by default.

## Changes since the boards

**Piece page flows into the article.** The pull-up gesture, the rising white
sheet and the 140px threshold are gone. Each piece is one vertical scroll: the
full-screen piece page (photo, kicker, title, author, why, tag, summary, Read /
Skip) is the top, and the article continues directly beneath it (source line,
photo credit, body / digest / video chapters, author card, end card; the
author chip and "why I picked this" aren't repeated, they're on the piece
page). The photo scrolls at 0.45× (parallax) and stretches on overscroll; with
Reduce Motion it just scrolls. While the piece page is on screen it behaves as
before: the pager pill (↑/↓, menu) and a light status bar. Once the piece
page's bottom passes under the 72px top bar, the white compact bar (back
chevron + title) fades and slides in, the status bar goes dark and the pill
becomes the reader pill (save, time left, next section, more → verdict → up
next); scrolling back above that point returns to the piece page's pill. No
remount either way. Read scrolls smoothly to the article; the bar's back
chevron scrolls back to the top. Reading progress, minutes left, sections,
`open` (first time the article is reached, or Read tapped) and `complete` /
the verdict all count from the start of the article. On a video the play
button opens YouTube and Watch scrolls to the chapters. The Library's reader
(`/items/[id]`) keeps the shrinking photo header.

**Piece page look.** Title 30/33 (was 40/42), letter-spacing −1.05. Gradient
darker at every stop, `piece` variant: 0.44 / 0.54 / 0.86 / 0.97 at
0 / 28 / 58 / 100% (Android, no blur: 0.50 / 0.64 / 0.92 / 0.99 at
0 / 28 / 55 / 100%). The progressive blur spans the whole photo: mask alpha
0.45 at the top → 0.85 at 30% → full from 55%, at blur intensity 90 (was 55). The P.S. keeps the board's
`page` gradient and its bottom-rising blur.

**Cover art.** Today's cover, the empty Today and the letter-being-made page
have a generative art band at the top (at least 60% of the screen) instead of
plain ground: one of fourteen quiet styles (mesh, routes, postmark, halftone,
riso, contour, stamp, airmail, letterhead, sketch, sky, wash, dots, ruled),
all pale tints and hairlines on near-white paper, picked at random per letter
from its id (never the previous letter's style) and seeded by it for the
details and variant, with the masthead, "Letter No. N", the headline (now
38/40, was 52/54; the empty and preparing pages match) and "greeting · date"
on light scrims (0.15–0.25) over it. The intro (a personal hook, up to ~200
characters) shows in full in the orange card; when there's a "why this mix",
a small "Why this mix ▾" control at the card's bottom right (44pt target,
expanded state announced) opens it inside the same card. See
`docs/design/backgrounds/README.md`.

**The cover intro is a personal hook.** The post office's line on the cover
was "Three things I picked for you. 18 minutes in all."; now it's one or two
short sentences tying what the reader told us (what they're into lately, their
role, topics, chosen leanings) to what's inside today's pieces, often naming
one by title, e.g. "You're trying to get off hourly billing. “Price the
outcome” is a designer who did it, including the first client who said no."
Without a model it's "You said you're into “…”: start with “…”, then two more
on hiring and sales. 18 minutes in all." Build plan §6.5.

**Icons instead of numbers in the contents.** Each row of the cover's contents
leads with an icon for what the piece is about (pricing tag, person-plus for
hiring, sparkles for AI, …) on its own, with no tile behind it, in the 28×28
space where the boards had "01", "02", "03". The icon is picked
by the enrichment model from a fixed list (`pieceIconKeys`); items it hasn't
picked for get one from their tags, topic and title, else a document (article)
or play (video) glyph. Ionicons outline glyphs in blue (#2B4BFF) at 23px; decorative, so
screen readers still hear "Piece N: title, M minutes".

Not on the boards: while a letter is being made now (the first letter right
after onboarding, or a test letter), Today shows it being put together in the
empty Today's style ("Searching the web for you" → "Reading what I found" →
"Writing your letter"), updating on its own, and opens the letter when it's
sent; if it ends with nothing to send, Today says so and offers "Try again".
Onboarding no longer has the platforms step or the five quick picks (see
`docs/design/onboarding-mockups/README.md`).

**Cover: board "Home A" (canvas section "Home · tweaks (Oct 5)").** The headline is
Bricolage 500 (was 700) at 38/40; article titles in the contents are Instrument
Sans 500 (was 600) at 15/19.5, each with the reader's author chip (`AuthorChip`,
unchanged) under it, opening the same author sheet as the piece page; minutes
stay on the right.
