# Onboarding mockups

Clickable prototypes for the onboarding flow, explored on 2026-10-02/03.
They live on a design canvas artifact (private to the owner):
https://claude.ai/artifact/EtAgfRpJUbxYuhHncQuK9k

These files are the canvas's source (`canvas.json` is its layout; each
`*.dc.html` is one artboard). They're kept here so the work survives the
session; the artifact is the place to view and play them.

## Where we landed

**`FillInSwipe.dc.html` (version 13) is the chosen direction:**

1. **Import from your AI first** (ChatGPT, Claude or Gemini): we show exactly
   what the prompt asks for and what it tells the assistant to leave out
   (health, finances, family and relationships, other people's details,
   confidential work, passwords and keys), the user pastes the answer back,
   we drop anything personal that slipped through, and they untick anything
   they don't want kept. The raw paste is never stored.
2. **A fill-in sentence, one blank at a time** ("I'm a ___. Lately I've been
   into ___. Send me more on ___. I follow people on ___. Send it ___."),
   pre-filled from the import when there is one. "Lately I've been into" is
   an open, free-text question.
3. **A live letter preview** on top (light blue card, status pill with post
   office copy and icons, headline, line items with format icon and length,
   a quiet P.S. in the agent's voice). Design: `PreviewCardList.dc.html`.
4. **Five quick picks after onboarding:** swipe right or left; each right
   swipe asks "What did you like about it?" (multi-select plus free text).
   Card design: `SwipeQuoteType.dc.html` (pull quote on a soft tint).

Palette: white ground, light blue, light orange and a neutral grey; blue for
actions and icons, orange only for the agent's voice. Type: Bricolage
Grotesque (headings), Instrument Sans (body), JetBrains Mono (labels).

The other artboards are the explored alternatives (rounds 1–7 on the canvas).
