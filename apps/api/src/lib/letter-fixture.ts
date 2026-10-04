import type { ItemView, LetterView, SectionSummary } from "@fs/schema";

/**
 * TODO(M3): stand-in data so the app can be built against the real routes
 * before the letter engine exists. It's the content from the design canvas
 * (Layout 6). Delete this file once /letters and /items are backed by the
 * database; nothing else should import it.
 */

const unsplash = (id: string) => `https://images.unsplash.com/${id}?fm=jpg&q=72&w=1200&fit=crop`;

export const FIXTURE_ITEM_IDS = [
  "6f1c1d2e-4a0b-4c7e-9a51-0b6f5d2a1c01",
  "6f1c1d2e-4a0b-4c7e-9a51-0b6f5d2a1c02",
  "6f1c1d2e-4a0b-4c7e-9a51-0b6f5d2a1c03",
] as const;
export const FIXTURE_LETTER_ID = "8d2e6b1a-3c4f-4e5a-8b7c-1d2e3f4a5b04";

export function fixtureLetter(nextLetterAt: string | null): LetterView {
  return {
    id: FIXTURE_LETTER_ID,
    number: 4,
    status: "sent",
    deliveredAt: "2026-10-05T06:30:00.000Z",
    localDate: "2026-10-05",
    headline: "Pricing and hiring, for a founder",
    intro: "Three things I picked for you. 33 minutes in all.",
    totalMinutes: 33,
    whyThisMix: null,
    isTest: false,
    pieces: [
      {
        itemId: FIXTURE_ITEM_IDS[0], position: 1, kind: "article",
        title: "The fee is the product: how membership pricing works", topic: "Pricing", minutes: 6,
        whyPicked: "Because you said “how Costco makes money”.", tag: null,
        summary: "Why the shop runs near cost and the renewal pays the bills.",
        sourceName: "Membership Economics", originalUrl: "https://example.com/the-fee-is-the-product",
        image: { url: unsplash("photo-1631856954655-966f97d809de"), source: "stock", credit: "Oxana Melis on Unsplash", creditUrl: "https://unsplash.com/photos/a-store-aisle-filled-with-lots-of-items-loDPKt_srQ0" },
        author: {
          key: "example:dana-whitfield", name: "Dana Whitfield", initials: "DW", role: "Writes Membership Economics",
          headline: "Ran pricing at a warehouse club for 8 years",
          short: "Spent eight years on pricing at a warehouse club, now writes about businesses that live on renewals.",
          bio: "Dana ran pricing at a warehouse club for eight years before starting two membership businesses of her own. She now writes a weekly newsletter on subscription and membership pricing, with a habit of publishing the spreadsheets behind each piece.",
          stats: [{ value: "8 yrs", label: "pricing at a warehouse club" }, { value: "2", label: "companies founded" }, { value: "40k", label: "newsletter readers" }],
          knownFor: ["Taking membership models apart, fee by fee", "Publishing the spreadsheets behind each piece", "Arguing that renewals, not margins, are the product"],
          siteUrl: "https://example.com", provenance: "Example author (fixture data).", yourReading: [], following: false,
        },
        feedbackCode: "PR21", verdict: null, skipped: false, completed: false, saved: false,
      },
      {
        itemId: FIXTURE_ITEM_IDS[1], position: 2, kind: "article",
        title: "How we priced our first B2B contract", topic: "Pricing", minutes: 9,
        whyPicked: null, tag: "Via X",
        summary: "One founder's spreadsheet, the number they picked, and what they'd change.",
        sourceName: "A founder's blog", originalUrl: "https://example.com/first-b2b-contract",
        image: { url: unsplash("photo-1540397106260-e24a507a08ea"), source: "stock", credit: "Matthew Fournier on Unsplash", creditUrl: "https://unsplash.com/photos/a-laptop-computer-sitting-on-top-of-a-desk-5NM32v14n6M" },
        author: {
          key: "example:priya-raman", name: "Priya Raman", initials: "PR", role: "Founder, clinic scheduling software",
          headline: "3 companies founded · $5M ARR at the last one",
          short: "A three-time founder who writes up every pricing decision in public, numbers included.",
          bio: "Priya has founded three B2B software companies; the last reached $5M in annual recurring revenue before it was acquired. She writes up every pricing and sales decision in public, including the ones that went wrong.",
          stats: [{ value: "3", label: "companies founded" }, { value: "$5M", label: "ARR at her last company" }, { value: "1", label: "acquisition" }],
          knownFor: ["Pricing write-ups with the real numbers", "Selling to clinics and other small practices", "Being honest about underpricing"],
          siteUrl: "https://example.com", provenance: "Example author (fixture data).", yourReading: [], following: false,
        },
        feedbackCode: "HB34", verdict: null, skipped: false, completed: false, saved: false,
      },
      {
        itemId: FIXTURE_ITEM_IDS[2], position: 3, kind: "video",
        title: "Hiring your first engineer without a recruiter", topic: "Hiring", minutes: 18,
        whyPicked: null, tag: "New source",
        summary: "Where to look, what to ask, and how to close in two weeks.",
        sourceName: "[YouTube channel]", originalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        image: { url: unsplash("photo-1758519289366-b90c073df4a7"), source: "stock", credit: "Vitaly Gariev on Unsplash", creditUrl: "https://unsplash.com/photos/two-men-in-suits-talking-at-a-table-TMHUqbpkJdo" },
        author: {
          key: "example:marcus-hale", name: "Marcus Hale", initials: "MH", role: "Engineering lead turned founder",
          headline: "First engineer at 2 startups · 40+ engineers hired",
          short: "Was first engineer at two startups and has hired more than forty engineers without a recruiter.",
          bio: "Marcus was the first engineer at two startups, then led engineering as both grew past fifty people. He makes videos about hiring for founders without a recruiting team.",
          stats: [{ value: "2", label: "startups as first engineer" }, { value: "40+", label: "engineers hired" }, { value: "120k", label: "subscribers" }],
          knownFor: ["Hiring without recruiters", "Practical interview loops for small teams"],
          siteUrl: null, provenance: "Example author (fixture data).", yourReading: [], following: false,
        },
        feedbackCode: "KN57", verdict: null, skipped: false, completed: false, saved: false,
      },
    ],
    postscript: {
      recap: null,
      nextLetterAt,
      leanings: ["Pricing, with numbers", "Short reads", "Sales playbooks", "Something new"],
      chosenLeanings: [],
    },
  };
}

export function fixtureItem(id: string): ItemView | null {
  const i = FIXTURE_ITEM_IDS.indexOf(id as (typeof FIXTURE_ITEM_IDS)[number]);
  if (i < 0) return null;
  const piece = fixtureLetter(null).pieces[i]!;
  const rights = { display: "full_text" as const, retainText: true, offlineAllowed: true, licenseNote: null };
  if (piece.kind === "video") {
    return {
      id, kind: "video", title: piece.title, sourceName: piece.sourceName, originalUrl: piece.originalUrl, minutes: piece.minutes, rights,
      blocks: null, sections: [], digest: null, unavailableReason: null,
      video: {
        youtubeId: "dQw4w9WgXcQ", durationSeconds: 1083,
        chapters: [
          { startSeconds: 0, title: "Why skip the recruiter", text: "Your first engineer sets the bar for every hire after. You want to meet them yourself." },
          { startSeconds: 252, title: "Where to look", text: "Open source contributors, people who've emailed you about the product, and former colleagues of your best advisors." },
          { startSeconds: 570, title: "What to ask", text: "Ask them to walk you through the last thing they shipped that they were proud of." },
          { startSeconds: 845, title: "Closing in two weeks", text: "Move fast, make the offer in person, and say why you want them specifically." },
        ],
      },
    };
  }
  return {
    id, kind: "article", title: piece.title, sourceName: piece.sourceName, originalUrl: piece.originalUrl, minutes: piece.minutes, rights,
    blocks: [
      { type: "paragraph", text: "A membership store makes most of its profit from the fee, not from what's on the shelves. Prices stay close to cost, so members keep coming back, and coming back is what renews the fee." },
      { type: "paragraph", text: "That flips the usual question. Instead of asking how much margin each sale can carry, it asks what makes someone renew. Mostly, it's trust that the price is fair." },
      { type: "heading", level: 2, text: "What it means for a SaaS founder" },
      { type: "paragraph", text: "If you charge a fee with usage on top, the fee is the relationship. Keep usage pricing boring and predictable, and spend your effort making the renewal feel obvious." },
      { type: "paragraph", text: "The best renewal pitch is a year of not being surprised. Every surprise on an invoice is a reason to reconsider the whole relationship." },
    ],
    sections: [
      { id: "s1", title: null, startBlock: 0, endBlock: 2 },
      { id: "s2", title: "What it means for a SaaS founder", startBlock: 2, endBlock: 5 },
    ],
    digest: null, video: null, unavailableReason: null,
  };
}

export function fixtureSummary(sectionId: string): SectionSummary {
  return { sectionId, claim: "The fee is the relationship.", evidence: "Renewals carry the profit; prices sit near cost.", forYou: "Keep usage pricing predictable and make renewal the obvious choice." };
}
