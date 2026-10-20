import { z } from "zod";

/**
 * Contracts shared by the API, workers and the Expo app.
 * Keep this package free of Node-only imports: the mobile app bundles it.
 */

/** Error codes returned as `{ code, message }` (build plan §7). */
export const errorCodes = [
  "UNAUTHORIZED",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "SOURCE_UNAVAILABLE",
  "FULL_TEXT_UNLICENSED",
  "TRANSCRIPT_MISSING",
  "GENERATION_FAILED",
  /** An optional integration (e.g. Connect YouTube) isn't set up on this server. */
  "NOT_CONFIGURED",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

export const apiErrorSchema = z.object({
  code: z.enum(errorCodes),
  message: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** One error report from the mobile app, sent to POST /client-logs. */
export const clientLogEntrySchema = z.object({
  level: z.enum(["error", "warn", "info"]),
  message: z.string().max(2_000),
  stack: z.string().max(16_000).optional(),
  /** Where it happened, e.g. the route path or a component name. */
  context: z.string().max(200).optional(),
  fatal: z.boolean().default(false),
  occurredAt: z.iso.datetime(),
  app: z.object({
    version: z.string().max(50),
    updateId: z.string().max(100).nullish(),
    platform: z.enum(["ios", "android", "web"]),
    osVersion: z.string().max(50).optional(),
  }),
});
export type ClientLogEntry = z.infer<typeof clientLogEntrySchema>;

export const clientLogBatchSchema = z.object({
  entries: z.array(clientLogEntrySchema).min(1).max(50),
});
export type ClientLogBatch = z.infer<typeof clientLogBatchSchema>;

// ── Content (build plan §6.3) ───────────────────────────────────────────────

/** Extracted article content, rendered natively by the Reader's BlockRenderer. */
export const blockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), level: z.number().int().min(1).max(6), text: z.string() }),
  z.object({ type: z.literal("paragraph"), text: z.string() }),
  z.object({ type: z.literal("quote"), text: z.string() }),
  z.object({ type: z.literal("list"), ordered: z.boolean(), items: z.array(z.string()) }),
  z.object({ type: z.literal("image"), src: z.url(), alt: z.string().optional(), caption: z.string().optional() }),
  z.object({ type: z.literal("caption"), text: z.string() }),
  z.object({ type: z.literal("table"), header: z.array(z.string()).optional(), rows: z.array(z.array(z.string())) }),
]);
export type Block = z.infer<typeof blockSchema>;

/** A contiguous run of blocks, `[startBlock, endBlock)`. Section summaries are keyed by `id`. */
export const sectionSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  startBlock: z.number().int().min(0),
  endBlock: z.number().int().min(0),
});
export type Section = z.infer<typeof sectionSchema>;

export const rightsDisplays = ["full_text", "excerpt_only", "link_only"] as const;
export type RightsDisplay = (typeof rightsDisplays)[number];

export const rightsSchema = z.object({
  display: z.enum(rightsDisplays),
  retainText: z.boolean(),
  offlineAllowed: z.boolean(),
  licenseNote: z.string().nullable().optional(),
});
export type Rights = z.infer<typeof rightsSchema>;

/** Why an item has no usable body. Nothing is ever generated from a title alone. */
export const unavailableReasons = [
  "paywalled",
  "access_denied",
  "not_found",
  "not_html",
  "too_short",
  "fetch_failed",
  "blocked_address",
  "transcript_missing",
] as const;
export type UnavailableReason = (typeof unavailableReasons)[number];

// ── Sources (build plan §7: /me/sources) ────────────────────────────────────

export const sourceModes = ["more_like_this", "follow_closely", "occasional"] as const;
export type SourceMode = (typeof sourceModes)[number];

export const sourceTypes = ["feed", "url", "youtube_channel", "newsletter"] as const;
export type SourceType = (typeof sourceTypes)[number];

export const addSourceInputSchema = z.object({
  url: z.string().trim().min(1).max(2_000),
  mode: z.enum(sourceModes).default("more_like_this"),
});
export type AddSourceInput = z.infer<typeof addSourceInputSchema>;

export const updateSourceInputSchema = z
  .object({ mode: z.enum(sourceModes), blocked: z.boolean() })
  .partial()
  .refine((v) => v.mode !== undefined || v.blocked !== undefined, "Nothing to update");
export type UpdateSourceInput = z.infer<typeof updateSourceInputSchema>;

export const sourceViewSchema = z.object({
  id: z.uuid(),
  type: z.enum(sourceTypes),
  title: z.string(),
  creator: z.string().nullable(),
  url: z.string(),
  mode: z.enum(sourceModes),
  blocked: z.boolean(),
  publisher: z.object({ id: z.uuid(), name: z.string(), status: z.string() }),
  rights: rightsSchema,
  lastFetchStatus: z.string().nullable(),
  lastFetchedAt: z.iso.datetime().nullable(),
  itemCount: z.number().int(),
});
export type SourceView = z.infer<typeof sourceViewSchema>;

// ── Imports (docs/imports/README.md: /me/imports) ───────────────────────────

/** Where an import's list came from. */
export const importMethods = ["opml", "youtube", "substack", "bluesky", "mastodon", "newsletter"] as const;
export type ImportMethod = (typeof importMethods)[number];

/** The platforms imported from a handle (no sign-in). */
export const handlePlatforms = ["substack", "bluesky", "mastodon"] as const;
export type HandlePlatform = (typeof handlePlatforms)[number];

/** At most this many sources are offered from one import; the rest are dropped (and counted). */
export const MAX_IMPORT_CANDIDATES = 300;
/** OPML uploads are refused above this size (bytes of text). */
export const MAX_OPML_BYTES = 2 * 1024 * 1024;

export const importOpmlInputSchema = z.object({
  opml: z.string().min(1).max(MAX_OPML_BYTES),
  /** The uploaded file's name, shown in the import's history. */
  filename: z.string().trim().max(200).optional(),
});
export type ImportOpmlInput = z.infer<typeof importOpmlInputSchema>;

export const importHandleInputSchema = z.object({
  platform: z.enum(handlePlatforms),
  handle: z.string().trim().min(1).max(300),
});
export type ImportHandleInput = z.infer<typeof importHandleInputSchema>;

/**
 * One thing found by an import. `ready` candidates know their feed (or
 * channel) and are added as they are; `site` ones only know a website, and
 * its feed is looked for when they're added.
 */
export const importCandidateSchema = z.object({
  /** Stable within the import; what the confirm call sends back. */
  key: z.string(),
  kind: z.enum(["feed", "youtube_channel"]),
  title: z.string(),
  /** A second line: the site's host, an @handle, an OPML folder's site. */
  detail: z.string().nullable(),
  /** Groups the checklist: an OPML folder, "People you follow", "Their websites". */
  group: z.string().nullable(),
  /** The feed URL, the website (for `site`), or the channel's YouTube URL. */
  url: z.string(),
  check: z.enum(["ready", "site"]),
  /** Already one of the user's sources. */
  following: z.boolean(),
});
export type ImportCandidate = z.infer<typeof importCandidateSchema>;

export const importViewSchema = z.object({
  id: z.uuid(),
  method: z.enum(importMethods),
  /** The handle, the file name, or the YouTube account's name. */
  label: z.string(),
  createdAt: z.iso.datetime(),
  candidates: z.array(importCandidateSchema),
  /** Entries left out (over the cap, or with nothing to follow), explained. */
  notes: z.array(z.string()),
  addedCount: z.number().int(),
});
export type ImportView = z.infer<typeof importViewSchema>;

export const confirmImportInputSchema = z.object({
  keys: z.array(z.string().max(2_100)).min(1).max(MAX_IMPORT_CANDIDATES),
  mode: z.enum(sourceModes).default("more_like_this"),
});
export type ConfirmImportInput = z.infer<typeof confirmImportInputSchema>;

export const confirmImportResultSchema = z.object({
  added: z.number().int(),
  /** Selected but already followed: left as they were. */
  alreadyFollowing: z.number().int(),
  failed: z.array(z.object({ key: z.string(), title: z.string(), message: z.string() })),
});
export type ConfirmImportResult = z.infer<typeof confirmImportResultSchema>;

/** Where Connect YouTube sends the browser back to once it's done. */
export const youTubeConnectInputSchema = z.object({ returnTo: z.string().url().max(500) });

// ── Newsletters by email (docs/imports/README.md: /me/newsletters) ──────────

/** Raw messages above this are refused (bytes of MIME, headers included). */
export const MAX_INBOUND_EMAIL_BYTES = 5 * 1024 * 1024;

export const newsletterAddressSchema = z.object({
  /** The full address to forward to, e.g. `n-k3j9…@in.example.com`. */
  email: z.string(),
  createdAt: z.iso.datetime(),
});
export type NewsletterAddress = z.infer<typeof newsletterAddressSchema>;

/** A Gmail or Outlook "confirm forwarding" message that arrived at the address. */
export const forwardingConfirmationSchema = z.object({
  id: z.uuid(),
  provider: z.enum(["gmail", "outlook"]),
  /** Gmail's confirmation code, to paste into Gmail's settings. */
  code: z.string().nullable(),
  /** The provider's confirmation link (https, on its own host). */
  url: z.string().nullable(),
  /** The mailbox that asked to forward here. */
  requestedBy: z.string().nullable(),
  receivedAt: z.iso.datetime(),
});
export type ForwardingConfirmation = z.infer<typeof forwardingConfirmationSchema>;

/** A sender whose newsletters arrived: one `newsletter` source. */
export const newsletterSenderSchema = z.object({
  sourceId: z.uuid(),
  title: z.string(),
  /** The sender's address or list. */
  sender: z.string(),
  publisher: z.string(),
  itemCount: z.number().int(),
  lastReceivedAt: z.iso.datetime().nullable(),
  /** False once the user stopped following it (its emails are then ignored). */
  following: z.boolean(),
});
export type NewsletterSender = z.infer<typeof newsletterSenderSchema>;

export const newslettersViewSchema = z.object({
  address: newsletterAddressSchema,
  /** Recent forwarding confirmations (last 7 days), newest first. */
  confirmations: z.array(forwardingConfirmationSchema),
  senders: z.array(newsletterSenderSchema),
  /** Messages received in the last 30 days that didn't become pieces (no content, stopped following, …). */
  skipped: z.number().int(),
});
export type NewslettersView = z.infer<typeof newslettersViewSchema>;

// ── Publishers (build plan §6.3a, §7: /me/publishers) ───────────────────────

export const publisherStatuses = ["candidate", "trial", "trusted", "blocked"] as const;
export type PublisherStatus = (typeof publisherStatuses)[number];

/** Follow a discovered publisher (its feed becomes one of the user's sources) and/or block it for this user. */
export const updatePublisherInputSchema = z
  .object({ following: z.boolean(), blocked: z.boolean() })
  .partial()
  .refine((v) => v.following !== undefined || v.blocked !== undefined, "Nothing to update");
export type UpdatePublisherInput = z.infer<typeof updatePublisherInputSchema>;

export const publisherViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Its domain (or `youtube:<channelId>`). */
  key: z.string(),
  /** Its standing in the shared catalog; `blocked` here means blocked for everyone. */
  status: z.enum(publisherStatuses),
  origin: z.enum(["user_added", "discovered"]),
  /** It has a feed, so it can be followed. */
  followable: z.boolean(),
  following: z.boolean(),
  /** Blocked for this user, by them or by their votes. */
  blocked: z.boolean(),
  /** Pieces discovery found for this user from it, and when it last did. */
  found: z.number().int(),
  lastFoundAt: z.iso.datetime().nullable(),
});
export type PublisherView = z.infer<typeof publisherViewSchema>;

// ── Profile and onboarding (build plan §7: /me/preferences, /me/schedule) ───

/**
 * Suggested answers for the fill-in sentence. Every field also takes the
 * user's own words, so these are starting points, not the allowed values.
 */
export const roles = ["founder", "startup operator", "consultant", "founder-to-be", "investor"] as const;
export type Role = (typeof roles)[number];

/** "Send me more on ___." Suggested topics; users add their own as tags. */
export const topics = [
  "business models",
  "pricing",
  "open source",
  "developer tools",
  "first customers",
  "sales",
  "hiring",
  "fundraising",
  "AI tools",
  "distribution",
] as const;
export type Topic = (typeof topics)[number];

/** "I follow people on ___." The places that can be connected; users can name others. */
export const readingPlatforms = ["youtube", "x", "substack"] as const;
export type ReadingPlatform = (typeof readingPlatforms)[number];

/** The assistants a profile can be imported from. */
export const assistants = ["chatgpt", "claude", "gemini"] as const;
export type Assistant = (typeof assistants)[number];

/** A free-text answer: a role, a topic tag, a place someone reads. */
const shortText = (max: number) => z.string().trim().min(1).max(max);

/** Lines of an imported profile, by the heading the import prompt asks for. */
export const profileFactKinds = ["work", "building", "curious", "recurring", "source"] as const;
export type ProfileFactKind = (typeof profileFactKinds)[number];

/** A newsletter, site, channel or person the note says the user reads. */
export const namedSourceSchema = z.object({
  name: shortText(120),
  /** Only when the note gives one; never guessed. */
  url: z.string().trim().max(2_000).nullable().default(null),
});
export type NamedSource = z.infer<typeof namedSourceSchema>;

/** The parts of the onboarding form one fact fills. Unticking the fact removes them. */
export const factFillsSchema = z.object({
  role: shortText(80).nullable().default(null),
  lately: shortText(300).nullable().default(null),
  topics: z.array(shortText(60)).max(8).default([]),
  platforms: z.array(z.enum(readingPlatforms)).max(readingPlatforms.length).default([]),
  sources: z.array(namedSourceSchema).max(10).default([]),
});
export type FactFills = z.infer<typeof factFillsSchema>;

export const profileFactSchema = z.object({
  kind: z.enum(profileFactKinds),
  text: z.string().trim().min(1).max(300),
  fills: factFillsSchema.default({ role: null, lately: null, topics: [], platforms: [], sources: [] }),
});
export type ProfileFact = z.infer<typeof profileFactSchema>;

/** What an import left out of the form because it looked personal. Only the category is shown. */
export const sensitiveCategories = ["health", "finances", "family", "other_people", "confidential", "credentials"] as const;
export type SensitiveCategory = (typeof sensitiveCategories)[number];

export const importProfileInputSchema = z.object({
  assistant: z.enum(assistants),
  /** The assistant's answer, pasted. Saved with the import so the user can come back to it. */
  text: z.string().trim().min(1).max(20_000),
});
export type ImportProfileInput = z.infer<typeof importProfileInputSchema>;

/** The structured reading of an import: facts to review, each carrying the answers it fills. */
export const importProfileResultSchema = z.object({
  importId: z.uuid(),
  facts: z.array(profileFactSchema),
  dropped: z.array(z.object({ category: z.enum(sensitiveCategories) })),
});
export type ImportProfileResult = z.infer<typeof importProfileResultSchema>;

/** The last import, so the paste is there when the user comes back. */
export const savedImportSchema = z.object({
  id: z.uuid(),
  assistant: z.enum(assistants),
  text: z.string(),
  result: importProfileResultSchema,
  createdAt: z.iso.datetime(),
});
export type SavedImport = z.infer<typeof savedImportSchema>;

export const updateProfileInputSchema = z
  .object({
    role: shortText(80).nullable(),
    /** "Lately I've been into ___": free text, or null when skipped. */
    lately: z.string().trim().max(500).nullable(),
    /** Suggested topics and the user's own tags. */
    topics: z.array(shortText(60)).max(30),
    /** Connectable platforms by ID, or anywhere else in the user's words. */
    platforms: z.array(shortText(40)).max(10),
    /** The facts the user kept from an import, replacing any earlier ones. */
    imported: z
      .object({ importId: z.uuid().nullable().default(null), assistant: z.enum(assistants), facts: z.array(profileFactSchema).max(30) })
      .nullable(),
  })
  .partial();
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;

/** "Send it ___." Each preset is a set of weekdays and a local time. */
export const deliveryPresets = ["weekday_mornings", "lunch", "sunday_mornings", "evenings"] as const;
export type DeliveryPreset = (typeof deliveryPresets)[number];

export const updateScheduleInputSchema = z.object({
  preset: z.enum(deliveryPresets),
  /** IANA time zone of the device, e.g. "Europe/London". */
  timeZone: z.string().min(1).max(64),
});
export type UpdateScheduleInput = z.infer<typeof updateScheduleInputSchema>;

export const scheduleViewSchema = z.object({
  preset: z.enum(deliveryPresets).nullable(),
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: z.array(z.number().int().min(0).max(6)),
  /** "HH:MM", in `timeZone`. */
  localTime: z.string(),
  timeZone: z.string(),
  paused: z.boolean(),
  nextRunAt: z.iso.datetime().nullable(),
});
export type ScheduleView = z.infer<typeof scheduleViewSchema>;

export const profileViewSchema = z.object({
  role: z.string().nullable(),
  lately: z.string().nullable(),
  topics: z.array(z.string()),
  platforms: z.array(z.string()),
  imported: z.object({ importId: z.uuid().nullable(), assistant: z.enum(assistants), facts: z.array(profileFactSchema) }).nullable(),
  schedule: scheduleViewSchema.nullable(),
  onboardedAt: z.iso.datetime().nullable(),
});
export type ProfileView = z.infer<typeof profileViewSchema>;

// ── Reviews (build plan §7: PUT /items/:id/review) ──────────────────────────

export const reviewVotes = ["interested", "not_interested"] as const;
export type ReviewVote = (typeof reviewVotes)[number];

/** "What did you like about it?" */
export const likeReasons = ["topic", "creator", "practical", "numbers", "depth", "concise", "fresh_take", "video"] as const;
export type LikeReason = (typeof likeReasons)[number];

/** "What wasn't right?" */
export const dislikeReasons = ["not_my_topic", "too_basic", "too_long", "already_knew", "not_credible", "too_promotional"] as const;
export type DislikeReason = (typeof dislikeReasons)[number];

/** Where a stored review came from. `onboarding` was the calibration swipes (since removed); older reviews keep it. */
export const reviewOrigins = ["in_app", "onboarding", "imported"] as const;
export type ReviewOrigin = (typeof reviewOrigins)[number];
/** The origins a client can still send. */
export const writableReviewOrigins = ["in_app", "imported"] as const;

export const putReviewInputSchema = z.object({
  vote: z.enum(reviewVotes),
  reasons: z.array(z.enum([...likeReasons, ...dislikeReasons])).max(likeReasons.length + dislikeReasons.length).default([]),
  freeText: z.string().trim().max(1_000).nullable().default(null),
  origin: z.enum(writableReviewOrigins).default("in_app"),
});
export type PutReviewInput = z.infer<typeof putReviewInputSchema>;


// ── Letters (build plan §6.1–6.7, §7: /letters, /items/:id) ─────────────────
// The app's reading experience (Layout 6 on the design canvas) is built on these.

/**
 * The icon beside a piece in the letter's contents, chosen per item at
 * enrichment (or by `fallbackPieceIcon` in @fs/core). Keys are semantic and
 * stable; the app maps each to a glyph, so the glyph set can change without
 * touching stored data. The meanings go into the enrichment prompt.
 */
export const pieceIconKeys = [
  "article",
  "video",
  "podcast",
  "pricing",
  "sales",
  "fundraising",
  "pitch",
  "equity",
  "finance",
  "metrics",
  "data",
  "hiring",
  "team",
  "leadership",
  "product",
  "launch",
  "growth",
  "retention",
  "marketing",
  "brand",
  "content",
  "seo",
  "social",
  "email",
  "community",
  "customers",
  "support",
  "engineering",
  "ai",
  "automation",
  "no-code",
  "infrastructure",
  "open-source",
  "mobile",
  "hardware",
  "design",
  "legal",
  "security",
  "operations",
  "strategy",
  "competition",
  "marketplace",
  "ecommerce",
  "saas",
  "services",
  "small-business",
  "bootstrapping",
  "acquisitions",
  "partnerships",
  "international",
  "economy",
  "remote",
  "health",
  "productivity",
  "writing",
  "learning",
  "story",
  "failure",
  "ideas",
  "research",
] as const;
export type PieceIcon = (typeof pieceIconKeys)[number];
export const pieceIconSchema = z.enum(pieceIconKeys);

/** What each icon stands for, as the enrichment model is told. */
export const pieceIconMeanings: Record<PieceIcon, string> = {
  article: "a general article that fits nothing more specific",
  video: "a general video that fits nothing more specific",
  podcast: "podcasts, interviews and conversations",
  pricing: "pricing, packaging, plans and discounts",
  sales: "selling, closing deals, sales teams and pipelines",
  fundraising: "raising money from investors, VCs and angels",
  pitch: "pitch decks and pitching",
  equity: "equity, cap tables, dilution and ownership",
  finance: "cash flow, accounting, unit economics, profitability and taxes",
  metrics: "KPIs, dashboards and measuring the business",
  data: "data, analytics tooling and databases",
  hiring: "hiring, recruiting and interviewing candidates",
  team: "team culture, managing people and compensation",
  leadership: "leadership, the CEO role and decision making",
  product: "product management, roadmaps and product-market fit",
  launch: "launching, go-to-market and getting the first users",
  growth: "growth, scaling and acquisition channels",
  retention: "retention, churn, activation and onboarding users",
  marketing: "marketing in general, positioning and advertising",
  brand: "brand, storytelling and reputation",
  content: "content marketing, blogging and publishing",
  seo: "SEO and search traffic",
  social: "social media, audience building and creators",
  email: "email, newsletters and cold outreach",
  community: "communities, forums and events",
  customers: "customer research, interviews and understanding users",
  support: "customer support and customer success",
  engineering: "software engineering, coding and technical architecture",
  ai: "AI, machine learning and LLMs",
  automation: "automation, workflows and internal tools",
  "no-code": "no-code and low-code building",
  infrastructure: "cloud, hosting, servers and devops",
  "open-source": "open source",
  mobile: "mobile apps",
  hardware: "hardware and physical products",
  design: "design, UX and visual craft",
  legal: "legal matters, contracts, incorporation and compliance",
  security: "security, privacy and fraud",
  operations: "operations, processes and running the business day to day",
  strategy: "strategy, moats and long-term planning",
  competition: "competitors and competitive dynamics",
  marketplace: "marketplaces and platforms with two sides",
  ecommerce: "e-commerce, online stores and DTC brands",
  saas: "SaaS and subscription businesses",
  services: "agencies, consulting, freelancing and productized services",
  "small-business": "small and local businesses, side projects",
  bootstrapping: "bootstrapping and self-funded companies",
  acquisitions: "acquisitions, exits and selling a company",
  partnerships: "partnerships, channels and business development",
  international: "international expansion and working across countries",
  economy: "the economy, markets, industry trends and news",
  remote: "remote work and distributed teams",
  health: "founder health, burnout, stress and wellbeing",
  productivity: "productivity, focus and time management",
  writing: "writing and communication",
  learning: "learning, books and self-education",
  story: "a founder's own story or journey",
  failure: "failures, postmortems, mistakes and lessons learned",
  ideas: "startup ideas, validation and finding problems",
  research: "research, studies and experiments",
};

/** The key if it's one of ours (trimmed, any case), else null. */
export function parsePieceIcon(value: unknown): PieceIcon | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return (pieceIconKeys as readonly string[]).includes(key) ? (key as PieceIcon) : null;
}

/** The picture behind a piece page: the article's own lead image, else a stock photo for its topic. */
export const pieceImageSchema = z.object({
  url: z.url(),
  source: z.enum(["article", "stock"]),
  /** Required for stock photos (e.g. "Oxana Melis on Unsplash"); shown somewhere quiet, not on the photo. */
  credit: z.string().nullable(),
  creditUrl: z.url().nullable(),
});
export type PieceImage = z.infer<typeof pieceImageSchema>;

/** A number about the author, only ever from a source we can name. */
export const authorStatSchema = z.object({
  value: z.string().max(12),
  label: z.string().max(60),
});

export const authorCardSchema = z.object({
  /** Stable across letters, for following: e.g. "priyaraman.com" or "youtube:UC…". */
  key: z.string(),
  name: z.string(),
  initials: z.string().max(3),
  /** e.g. "Founder, clinic scheduling software". */
  role: z.string().nullable(),
  /** One line for the piece page, e.g. "3 companies founded · $5M ARR at the last one". */
  headline: z.string().nullable(),
  /** One sentence for the reader's card. */
  short: z.string().nullable(),
  /** A short paragraph for the dialog. */
  bio: z.string().nullable(),
  stats: z.array(authorStatSchema).max(3),
  knownFor: z.array(z.string()).max(4),
  siteUrl: z.url().nullable(),
  /** Where the details came from and when, e.g. "From her blog and Crunchbase, checked Oct 3". */
  provenance: z.string().nullable(),
  /** Other pieces by them this user has read or saved. */
  yourReading: z.array(z.object({ itemId: z.uuid(), title: z.string(), note: z.string() })).max(5),
  following: z.boolean(),
});
export type AuthorCard = z.infer<typeof authorCardSchema>;

export const letterPieceSchema = z.object({
  /** The content item; stable across letters. */
  itemId: z.uuid(),
  position: z.number().int().min(1),
  kind: z.enum(["article", "video"]),
  title: z.string(),
  topic: z.string(),
  minutes: z.number().int().min(1),
  /** "Why I picked this", tied to the user's own words where possible. Null when there's nothing specific to say. */
  whyPicked: z.string().nullable(),
  /** A short tag such as "New source" or "Via X". */
  tag: z.string().nullable(),
  /** One or two sentences under the title on the piece page. */
  summary: z.string(),
  sourceName: z.string(),
  /** Null for a newsletter that arrived by email with no web version. */
  originalUrl: z.url().nullable(),
  image: pieceImageSchema.nullable(),
  /** The icon in the contents list: the one picked at enrichment, else one from the topic and title. */
  icon: pieceIconSchema,
  author: authorCardSchema.nullable(),
  /** `[A-Z]{2}[0-9]{2}`, unique within the letter (§6.7). */
  feedbackCode: z.string(),
  // The user's state for this piece.
  verdict: z.enum(reviewVotes).nullable(),
  skipped: z.boolean(),
  completed: z.boolean(),
  saved: z.boolean(),
});
export type LetterPiece = z.infer<typeof letterPieceSchema>;

export const postscriptSchema = z.object({
  /** A quick recap of the pieces, rewritten from the user's verdicts once they give any; null only while the letter has no pieces yet. */
  recap: z.string().nullable(),
  /** When the next letter arrives (from the schedule), null if paused or unscheduled. */
  nextLetterAt: z.iso.datetime().nullable(),
  /** "Tomorrow, more of": short options written from today's feedback and the brief. */
  leanings: z.array(z.string().max(40)).max(6),
  /** What the user picked, including their own words. */
  chosenLeanings: z.array(z.string().max(80)).max(10),
});
export type Postscript = z.infer<typeof postscriptSchema>;

export const letterStatuses = [
  "scheduled",
  "collecting",
  "ranking",
  "generating",
  "verifying",
  "ready",
  "sending",
  "sent",
  "short_sent",
  "skipped_no_candidates",
  "failed",
] as const;
export type LetterStatus = (typeof letterStatuses)[number];

export const letterViewSchema = z.object({
  id: z.uuid(),
  /** "Letter No. 4": counts this user's delivered letters. */
  number: z.number().int().min(1),
  status: z.enum(letterStatuses),
  /** When it was (or will be) delivered, and the user's local date for it. */
  deliveredAt: z.iso.datetime().nullable(),
  localDate: z.string(),
  /** e.g. "Pricing and hiring, for a founder". */
  headline: z.string(),
  /** The post office's hook on the cover: one or two sentences tying the reader to today's pieces. */
  intro: z.string(),
  totalMinutes: z.number().int(),
  /** Explains a change in the mix, e.g. after a reasoned dislike (§6.4). */
  whyThisMix: z.string().nullable(),
  pieces: z.array(letterPieceSchema),
  postscript: postscriptSchema,
  isTest: z.boolean(),
});
export type LetterView = z.infer<typeof letterViewSchema>;

/**
 * Where a letter made on demand (the first letter, a test letter) has got to,
 * for Today to show while the user waits: `searching` the web for them
 * (§6.3a), `reading` what it found, `writing` the letter; then `sent`, or it
 * ended `empty` (nothing to pick from) or `failed`.
 */
export const letterStages = ["searching", "reading", "writing", "sent", "empty", "failed"] as const;
export type LetterStage = (typeof letterStages)[number];

export const letterProgressSchema = z.object({
  id: z.uuid(),
  stage: z.enum(letterStages),
  isTest: z.boolean(),
});
export type LetterProgress = z.infer<typeof letterProgressSchema>;

export const letterSummarySchema = letterViewSchema.pick({ id: true, number: true, headline: true, localDate: true, totalMinutes: true, isTest: true }).extend({
  pieceCount: z.number().int(),
});
export type LetterSummary = z.infer<typeof letterSummarySchema>;

/** A chapter of a video's transcript, with where it starts. */
export const chapterSchema = z.object({
  startSeconds: z.number().int().min(0),
  title: z.string(),
  text: z.string(),
});

/** What the reader shows for one piece: full text as blocks, or a video's transcript. */
export const itemViewSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["article", "video"]),
  title: z.string(),
  sourceName: z.string(),
  /** Null for a newsletter that arrived by email with no web version. */
  originalUrl: z.url().nullable(),
  minutes: z.number().int().nullable(),
  rights: rightsSchema,
  /** Null when the rights rule doesn't allow showing the text (then `digest` is used) or it couldn't be extracted. */
  blocks: z.array(blockSchema).nullable(),
  sections: z.array(sectionSchema),
  /** A short plain-text digest, for link-only or excerpt-only rights. */
  digest: z.string().nullable(),
  /** For videos: the YouTube ID, and chapters if there's a transcript. */
  video: z.object({ youtubeId: z.string(), durationSeconds: z.number().int().nullable(), chapters: z.array(chapterSchema).nullable() }).nullable(),
  unavailableReason: z.enum(unavailableReasons).nullable(),
});
export type ItemView = z.infer<typeof itemViewSchema>;

/** "Summarize this section" (§6.5): claim / evidence / what it means for you. */
export const sectionSummarySchema = z.object({
  sectionId: z.string(),
  claim: z.string(),
  evidence: z.string(),
  forYou: z.string(),
});
export type SectionSummary = z.infer<typeof sectionSummarySchema>;

/**
 * The podcast experiment: a piece as a short audio episode, made once and
 * shared. The app asks for one, then polls while it's `queued`, `scripting`
 * or `voicing`.
 */
export const episodeStatuses = ["queued", "scripting", "voicing", "ready", "failed"] as const;
export const episodeViewSchema = z.object({
  id: z.uuid(),
  status: z.enum(episodeStatuses),
  /** `conversation` (two hosts), `narration` (one voice) or `reading` (the piece's own opening, when the script failed its checks). */
  format: z.enum(["conversation", "narration", "reading"]),
  /** Absolute, or a path on the API (local development) that the app prefixes with the API's URL. Set when ready. */
  audioUrl: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  chapters: z.array(z.object({ title: z.string(), startSeconds: z.number() })),
  /** How far along making it is, 0 → 1 (1 once ready): the script to 0.25, voicing to 0.95, then encoding. */
  progress: z.number().min(0).max(1),
  /** While it's being made: seconds since the worker started on it (null while queued, and once it's done). With `progress`, the app's estimate of the time left. */
  elapsedSeconds: z.number().min(0).nullable(),
});
export type EpisodeView = z.infer<typeof episodeViewSchema>;

/** Reading events (§6.6). `localDay` is set on the device when it happens and never recomputed. */
export const interactionTypes = ["open", "complete", "uncomplete", "save", "unsave", "summary_expand", "skip"] as const;
export const interactionSchema = z.object({
  eventId: z.uuid(),
  type: z.enum(interactionTypes),
  itemId: z.uuid(),
  letterId: z.uuid().nullable(),
  occurredAt: z.iso.datetime(),
  localDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export const eventsInputSchema = z.object({ events: z.array(interactionSchema).min(1).max(100) });
export type Interaction = z.infer<typeof interactionSchema>;

export const leaningsInputSchema = z.object({ chosen: z.array(z.string().trim().min(1).max(80)).max(10) });

export const followAuthorInputSchema = z.object({ following: z.boolean() });

/** Library: pieces the user saved, newest first. */
export const savedPieceSchema = z.object({
  itemId: z.uuid(),
  kind: z.enum(["article", "video"]),
  title: z.string(),
  topic: z.string().nullable(),
  minutes: z.number().int().nullable(),
  sourceName: z.string(),
  image: pieceImageSchema.nullable(),
  icon: pieceIconSchema,
  savedAt: z.iso.datetime(),
  /** Readable offline (rights allow it and the blocks are cached on the device). */
  offline: z.boolean(),
});
export type SavedPiece = z.infer<typeof savedPieceSchema>;

/** Activity (§6.6): one entry per day of the month, from the user's own local days. */
export const activityMonthSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  activeDays: z.number().int(),
  days: z.array(z.object({ day: z.string(), level: z.number().int().min(0).max(3), read: z.number().int(), reviewed: z.number().int() })),
});
export type ActivityMonth = z.infer<typeof activityMonthSchema>;

// ── Dev tools (local API only: /dev) ────────────────────────────────────────

/** The full letter state machine, including `skipped`, which the app never shows but the dev screen does. */
export const devLetterStatuses = [...letterStatuses, "skipped"] as const;
export const discoveryRunStatuses = ["pending", "running", "done", "failed"] as const;
export const discoveryQueryStatuses = ["pending", "searched", "cached", "skipped_stale", "skipped_recent", "skipped_cap", "duplicate", "failed"] as const;
export const contentStatuses = ["pending", "extracted", "metadata_only", "enriched", "failed"] as const;

/**
 * Discovery runs the dev screen asks for have occurrence `dev#<id>`; the local
 * worker runs them (they're never queued). A test letter made with
 * `discoverFirst` is `test#<same id>` and waits, unstarted, until that run ends.
 */
export const DEV_RUN_PREFIX = "dev#";

/** Local mock accounts (`pnpm --filter @fs/workers seed:personas`); the dev sign-in shortcut only signs in as these. */
export const DEV_ACCOUNT_DOMAIN = "@founder-signal.local";

export const devSignInInputSchema = z.object({
  /** A local mock account; defaults to the dev account. */
  email: z
    .email()
    .transform((e) => e.toLowerCase())
    .refine((e) => e.endsWith(DEV_ACCOUNT_DOMAIN), `Only ${DEV_ACCOUNT_DOMAIN} accounts`)
    .optional(),
});

export const devAccountSchema = z.object({
  email: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  onboarded: z.boolean(),
});
export type DevAccount = z.infer<typeof devAccountSchema>;
export const TEST_LETTER_PREFIX = "test#";

export const devLetterInputSchema = z.object({
  /** Run discovery first; the letter starts once the run has finished (or failed). */
  discoverFirst: z.boolean().optional(),
});
export type DevLetterInput = z.infer<typeof devLetterInputSchema>;

export const devForgetLettersInputSchema = z.object({
  /** Also delete the user's reviews, so reviewed pieces become candidates again too. */
  includeReviews: z.boolean().optional(),
});
export type DevForgetLettersInput = z.infer<typeof devForgetLettersInputSchema>;

export const devLetterSchema = z.object({
  id: z.uuid(),
  number: z.number().int().nullable(),
  status: z.enum(devLetterStatuses),
  isTest: z.boolean(),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable(),
  failureReason: z.string().nullable(),
  pieceCount: z.number().int(),
  /** How its copy was written ("anthropic", "claude-cli", "fallback"), once generated. */
  generation: z.object({ method: z.string(), model: z.string().nullable() }).nullable(),
  /** Held until a discovery run finishes: created with `discoverFirst`, or held by collection for too few candidates. */
  waitingOnDiscovery: z.boolean(),
  /**
   * How its candidates were collected (§6.2): each escalation step that ran
   * ("own", "widened", "shared_pool", "discovery") with the candidate count
   * after it. Null before collection.
   */
  collection: z
    .object({
      wanted: z.number().int(),
      steps: z.array(z.object({ step: z.string(), total: z.number().int(), added: z.number().int() })),
      candidates: z.number().int(),
      shared: z.number().int(),
      heldForDiscovery: z.boolean(),
      extraSubstitutes: z.number().int(),
    })
    .nullable(),
  /** Why it has fewer pieces than planned, when it does. */
  shortReason: z.string().nullable(),
});
export type DevLetter = z.infer<typeof devLetterSchema>;

export const devFoundPageSchema = z.object({
  itemId: z.uuid(),
  /** The page's title once extracted, otherwise its URL. */
  title: z.string(),
  url: z.string(),
  publisher: z.string(),
  status: z.enum(contentStatuses),
  statusReason: z.string().nullable(),
});
export type DevFoundPage = z.infer<typeof devFoundPageSchema>;

export const devDiscoveryRunSchema = z.object({
  id: z.uuid(),
  occurrenceId: z.string(),
  status: z.enum(discoveryRunStatuses),
  queryMethod: z.string().nullable(),
  queriesGenerated: z.number().int(),
  searchesRun: z.number().int(),
  cacheHits: z.number().int(),
  itemsLinked: z.number().int(),
  itemsQueued: z.number().int(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  queries: z.array(
    z.object({
      id: z.uuid(),
      text: z.string(),
      origin: z.string(),
      status: z.enum(discoveryQueryStatuses),
      resultCount: z.number().int().nullable(),
      acceptedCount: z.number().int().nullable(),
      found: z.array(devFoundPageSchema),
    }),
  ),
});
export type DevDiscoveryRun = z.infer<typeof devDiscoveryRunSchema>;

/** GET /dev/state: one snapshot of the signed-in user's data and what the pipeline did with it. */
export const devStateSchema = z.object({
  user: z.object({ id: z.string(), email: z.string() }),
  profile: z
    .object({
      role: z.string().nullable(),
      lately: z.string().nullable(),
      onboardedAt: z.iso.datetime().nullable(),
      version: z.number().int(),
      topics: z.array(z.object({ topic: z.string(), origin: z.enum(["explicit", "learned"]), weight: z.number() })),
    })
    .nullable(),
  latestImport: z
    .object({
      assistant: z.string(),
      createdAt: z.iso.datetime(),
      method: z.string(),
      model: z.string().nullable(),
      /** The first ~200 characters of the pasted note. */
      excerpt: z.string(),
    })
    .nullable(),
  schedule: scheduleViewSchema.omit({ preset: true }).extend({ preset: z.string().nullable(), skipNext: z.boolean() }).nullable(),
  counts: z.object({
    followedSources: z.number().int(),
    /** Items from followed sources, by status. */
    sourceItems: z.partialRecord(z.enum(contentStatuses), z.number().int()),
    discoveredItems: z.number().int(),
    reviews: z.number().int(),
    interactions: z.number().int(),
    letters: z.number().int(),
  }),
  letters: z.array(devLetterSchema),
  discoveryRuns: z.array(devDiscoveryRunSchema),
  /** The latest thing a worker did for this user (a letter step, a discovery run, a source fetch). */
  lastWorkerActivityAt: z.iso.datetime().nullable(),
});
export type DevState = z.infer<typeof devStateSchema>;
