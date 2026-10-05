/** The cover's art band, shared by ArtHero and the docs script so the samples match the phone. */
export const HERO = {
  /** The band is at least this share of the window's height. */
  share: 0.6,
  /** Below the top inset: the masthead row (14 above, the mono line, 15 below), all on the top scrim. */
  mastHeight: 44,
  /** The scrims' soft edges. */
  fade: 72,
  /** Under the text block, at the band's bottom. */
  bottomPad: 26,
} as const;
