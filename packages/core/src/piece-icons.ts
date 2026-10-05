import { type PieceIcon, parsePieceIcon } from "@fs/schema";
import { normalizeText } from "./text-match.ts";

/**
 * The contents-list icon when enrichment didn't pick one (enrichment off
 * locally, or items enriched before icons existed): keywords in the item's
 * tags, then the piece's topic, then its title. The first source with a match
 * decides, and within it the earliest rule; nothing matches → "video" or
 * "article".
 */

/**
 * Ordered: more specific rules first ("cold email" is email, not sales;
 * "pricing" beats "saas"). A keyword matches whole words, plural included;
 * one ending in `*` matches any word starting with it.
 */
const RULES: [PieceIcon, string[]][] = [
  ["pitch", ["pitch deck", "pitching", "pitch"]],
  ["equity", ["cap table", "equity", "dilution", "vesting", "stock option", "esop"]],
  ["fundraising", ["fundrais*", "raising money", "raise money", "venture capital", "vc", "vcs", "investor", "angel", "seed round", "series a", "series b", "term sheet", "safe note"]],
  ["acquisitions", ["acquisition", "acquir*", "exit", "m&a", "selling your company", "sell your company", "merger"]],
  ["pricing", ["pricing", "price", "prices", "packaging", "discount", "monetiz*"]],
  ["email", ["cold email", "email", "newsletter", "inbox", "outreach"]],
  ["seo", ["seo", "search engine", "search traffic", "keyword"]],
  ["social", ["social media", "twitter", "linkedin", "tiktok", "instagram", "youtube channel", "audience", "creator"]],
  ["content", ["content marketing", "blogging", "blog", "publishing"]],
  ["brand", ["brand", "storytelling", "reputation"]],
  ["hiring", ["hiring", "hire", "hired", "recruit*", "interviewing candidates", "talent"]],
  ["sales", ["sales", "selling", "sell", "deal flow", "closing deals", "pipeline", "outbound", "account executive", "b2b sales"]],
  ["retention", ["retention", "churn", "activation", "onboarding users", "user onboarding"]],
  ["launch", ["launch*", "go-to-market", "gtm", "first users", "first customers", "product hunt"]],
  ["growth", ["growth", "scaling", "scale", "scaled", "acquisition channel", "virality", "viral", "plg"]],
  ["marketing", ["marketing", "positioning", "advertis*", "ads", "copywriting", "messaging"]],
  ["remote", ["remote", "distributed team", "async"]],
  ["team", ["team", "culture", "management", "managing", "manager", "compensation", "employees", "cofounder", "co-founder"]],
  ["leadership", ["leadership", "leader", "ceo", "decision"]],
  ["ai", ["ai", "artificial intelligence", "llm", "gpt", "machine learning", "ml", "agent", "chatgpt", "claude", "generative"]],
  ["no-code", ["no-code", "nocode", "low-code", "lowcode"]],
  ["automation", ["automat*", "workflow", "internal tool", "zapier"]],
  ["open-source", ["open source", "open-source", "oss"]],
  ["infrastructure", ["infrastructure", "cloud", "devops", "hosting", "server", "kubernetes", "aws"]],
  ["mobile", ["mobile", "ios", "android", "app store"]],
  ["hardware", ["hardware", "physical product", "manufactur*", "supply chain"]],
  ["security", ["security", "privacy", "fraud", "hacked", "hacker", "breach"]],
  ["engineering", ["engineering", "engineer", "software", "coding", "code", "programming", "developer", "architecture", "technical debt"]],
  ["data", ["data", "analytics", "database", "sql"]],
  ["metrics", ["metric", "kpi", "dashboard", "north star", "measur*", "cohort"]],
  ["finance", ["financ*", "cash flow", "cash", "accounting", "unit economics", "profit", "margin", "revenue", "tax", "budget", "burn rate", "runway"]],
  ["design", ["design", "ux", "ui", "user experience", "typography"]],
  ["legal", ["legal", "lawyer", "contract", "incorporat*", "compliance", "trademark", "gdpr", "regulation"]],
  ["customers", ["customer research", "customer interview", "user research", "customer", "user interview", "jobs to be done", "jtbd"]],
  ["support", ["support", "customer success", "helpdesk"]],
  ["product", ["product", "roadmap", "feature", "product-market fit", "pmf", "mvp"]],
  ["marketplace", ["marketplace", "two-sided", "platform"]],
  ["ecommerce", ["ecommerce", "e-commerce", "shopify", "online store", "dtc", "d2c", "direct-to-consumer", "amazon seller"]],
  ["saas", ["saas", "subscription", "b2b software", "recurring revenue", "mrr", "arr"]],
  ["services", ["agency", "agencies", "consulting", "consultant", "freelanc*", "productized service", "services"]],
  ["bootstrapping", ["bootstrap*", "self-funded", "indie hacker", "indie"]],
  ["small-business", ["small business", "local business", "side project", "solopreneur", "solo founder", "lifestyle business"]],
  ["partnerships", ["partner*", "business development", "bizdev", "channel partner"]],
  ["international", ["international", "global expansion", "expansion", "abroad", "localization", "emerging market"]],
  ["economy", ["econom*", "market trends", "recession", "inflation", "interest rate", "industry"]],
  ["competition", ["competit*", "moat"]],
  ["strategy", ["strateg*", "planning", "long-term", "vision"]],
  ["operations", ["operations", "ops", "process", "systems", "logistics", "operating"]],
  ["health", ["health", "burnout", "stress", "wellbeing", "well-being", "mental", "anxiety", "sleep", "exercise"]],
  ["productivity", ["productivity", "focus", "time management", "habit", "routine", "deep work"]],
  ["writing", ["writing", "writer", "communication", "memo"]],
  ["learning", ["learning", "books", "book", "reading", "education", "course"]],
  ["failure", ["fail*", "postmortem", "post-mortem", "mistake", "lessons learned", "shutdown", "shut down"]],
  ["ideas", ["idea", "validat*", "problem discovery"]],
  ["research", ["research*", "study", "studies", "experiment*", "survey", "data shows"]],
  ["story", ["founder story", "my journey", "journey", "how i built", "how we built", "story", "stories"]],
  ["podcast", ["podcast", "interview", "conversation", "episode"]],
  ["community", ["community", "communities", "forum", "events", "meetup", "discord"]],
];

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = (w: string) => (w.endsWith("*") ? escape(w.slice(0, -1)) : `${escape(w)}(?:s|es)?(?![a-z0-9])`);
const MATCHERS: [PieceIcon, RegExp][] = RULES.map(([icon, words]) => [icon, new RegExp(`(?:^|[^a-z0-9])(?:${words.map(pattern).join("|")})`)]);

/** The first icon whose keywords appear in `text`, or null. */
export function iconForText(text: string | null | undefined): PieceIcon | null {
  if (!text) return null;
  const t = normalizeText(text);
  for (const [icon, re] of MATCHERS) if (re.test(t)) return icon;
  return null;
}

export interface PieceIconInput {
  kind: "article" | "video";
  /** Enrichment's topic tags, most specific first. */
  tags?: readonly string[] | null;
  /** The piece's topic in the letter. */
  topic?: string | null;
  title?: string | null;
}

/** A deterministic icon for an item that has none from enrichment. */
export function fallbackPieceIcon(input: PieceIconInput): PieceIcon {
  for (const tag of input.tags ?? []) {
    const icon = iconForText(tag);
    if (icon) return icon;
  }
  return iconForText(input.topic) ?? iconForText(input.title) ?? (input.kind === "video" ? "video" : "article");
}

/** The stored icon if it's still one of ours (the allowlist may shrink), else the fallback. */
export function resolvePieceIcon(stored: unknown, input: PieceIconInput): PieceIcon {
  return parsePieceIcon(stored) ?? fallbackPieceIcon(input);
}
