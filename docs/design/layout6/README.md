# Layout 6 · Pager (chosen app layout)

Sources of the boards on the design canvas (private to the owner):
https://claude.ai/artifact/EtAgfRpJUbxYuhHncQuK9k (row "Layout 6", and P.S. 5 in the "Postscript" row).
Each `*.dc.html` is one artboard: markup plus a small state machine in the
`<script type="text/x-dc">` block. Images reference canvas uploads (`/_blob/…`);
the same photos are on Unsplash (credits in `apps/api/src/lib/letter-fixture.ts`).

| Board | What it shows |
|---|---|
| `PagerToday` | Today as full-screen pages: cover → pieces → P.S. Piece pages over a photo, dark gradient, progressive blur behind text, author chip. Pull up (140px threshold, resistance, spring back) to read in place. |
| `PagerReader` | Reading in place: photo header 200px → white 72px bar on scroll, author card, every action in the floating pill (save, time left ring, next section, ••• tray), verdict in the pill at the end, then "Next". |
| `PagerVideo` | A video piece: play button on the still; transcript in chapters. |
| `PagerLibrary`, `PagerActivity`, `PagerPreferences` | The rest of the app under the same floating pill + big-type menu sheet. |
| `PsCountdown` | The chosen P.S. (board "P.S. 5"): two-line recap, "See you Tuesday, 7:30.", "Tomorrow, more of" multi-select + "+ Your own". |

Decisions: no tab bar (pill + menu sheet); moving between pieces is the pill's
↑/↓ and the "Up next" card (swipe up means "read"); verdict asked once, at the
end of the piece, with "Skip this one" up front; full text by default.
