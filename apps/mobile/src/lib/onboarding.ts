import { formFromFacts } from "@fs/core";
import type {
  Assistant,
  DeliveryPreset,
  LikeReason,
  ProfileFact,
  ReadingPlatform,
  SensitiveCategory,
  Topic,
} from "@fs/schema";

/**
 * Copy and derived values for onboarding (design: FillInSwipe, board 13 of
 * the onboarding canvas). Kept free of React so the wording lives in one place.
 */

export type Step = "import" | "role" | "lately" | "topics" | "platforms" | "time";
export const STEP_ORDER: readonly Step[] = ["import", "role", "lately", "topics", "platforms", "time"];

export interface Answers {
  importDone: boolean;
  imported: { importId: string | null; assistant: Assistant; facts: ProfileFact[] } | null;
  /** Free text; the suggested roles are just the usual answers. */
  role: string | null;
  lately: string | null;
  latelySkipped: boolean;
  /** Suggested topics and the user's own tags. */
  topics: string[];
  /** Connectable platform IDs, or anywhere else in the user's words. */
  platforms: string[];
  platformsDone: boolean;
  preset: DeliveryPreset | null;
}

export function isAnswered(a: Answers, step: Step): boolean {
  switch (step) {
    case "import":
      return a.importDone;
    case "role":
      return !!a.role;
    case "lately":
      return !!a.lately || a.latelySkipped;
    case "topics":
      return a.topics.length > 0;
    case "platforms":
      return a.platformsDone;
    case "time":
      return !!a.preset;
  }
}

/** The first unanswered blank, or null when the sentence is complete. */
export function nextStep(a: Answers): Step | null {
  return STEP_ORDER.find((s) => !isAnswered(a, s)) ?? null;
}

// ── Choices ─────────────────────────────────────────────────────────────────

export const ASSISTANTS: { value: Assistant; label: string; url: string }[] = [
  { value: "chatgpt", label: "ChatGPT", url: "https://chatgpt.com/" },
  { value: "claude", label: "Claude", url: "https://claude.ai/new" },
  { value: "gemini", label: "Gemini", url: "https://gemini.google.com/app" },
];
export const assistantLabel = (a: Assistant) => ASSISTANTS.find((x) => x.value === a)!.label;

export const PLATFORM_LABEL: Record<ReadingPlatform, string> = { youtube: "YouTube", x: "X", substack: "Substack" };
/** A platform's name, or the user's own words for somewhere else. */
export const platformLabel = (p: string) => PLATFORM_LABEL[p as ReadingPlatform] ?? p;

export const PRESETS: { value: DeliveryPreset; label: string; when: string }[] = [
  { value: "weekday_mornings", label: "weekday mornings", when: "Mon–Fri 7:30" },
  { value: "lunch", label: "at lunch", when: "Daily 12:00" },
  { value: "sunday_mornings", label: "Sunday mornings", when: "Sun 9:00" },
  { value: "evenings", label: "every evening", when: "Daily 18:00" },
];
export const presetLabel = (p: DeliveryPreset) => PRESETS.find((x) => x.value === p)!.label;

export const LATELY_EXAMPLES = [
  "How Costco makes its money on memberships, not groceries",
  "An open source project taking on a big incumbent",
  "Getting our first ten paying customers",
];

/** `phrase` finishes "especially when it's ___" on the last screen. */
export const LIKE_REASONS: { value: LikeReason; label: string; phrase: string }[] = [
  { value: "topic", label: "The topic", phrase: "right on topic" },
  { value: "creator", label: "Who made it", phrase: "from someone worth hearing" },
  { value: "practical", label: "Practical, I can use it", phrase: "practical" },
  { value: "numbers", label: "Real numbers", phrase: "backed by real numbers" },
  { value: "depth", label: "Depth", phrase: "in depth" },
  { value: "concise", label: "Short and to the point", phrase: "short and to the point" },
  { value: "fresh_take", label: "A fresh take", phrase: "a fresh take" },
  { value: "video", label: "I like videos", phrase: "on video" },
];

// ── The import prompt ───────────────────────────────────────────────────────

export const IMPORT_ASKS = ["Your work and role", "What you're building now", "Companies and projects you ask about", "Topics you keep coming back to", "Sources you've mentioned"];
export const IMPORT_AVOIDS = ["Health", "Money and finances", "Family and relationships", "Other people's details", "Confidential work, passwords, keys"];

export const IMPORT_PROMPT = `I'm setting up Founder Signal, a reading app that sends me a short letter of articles worth my time. Using our past conversations and anything you remember about me, write a short profile under these headings, one line per point:

1. Work: my role and the kind of company or project I work on.
2. Building now: what I'm working on or trying to figure out at the moment.
3. Curious about: companies, products, open-source projects and ideas I've asked about.
4. Recurring questions: topics I keep coming back to.
5. Sources: newsletters, sites, podcasts, channels or people I've mentioned reading or watching.

Leave out anything sensitive: health, money and personal finances, family and relationships, other people's names or details, anything confidential about my employer or clients, and any passwords, keys or account details. If you're not sure whether something is sensitive, leave it out. If you don't know much about me, say so instead of guessing.`;

/** For trying the flow without an assistant at hand. */
export const EXAMPLE_ANSWER = `1. Work: Founder of a two-person B2B SaaS startup.
2. Building now: A scheduling tool for clinics; chasing the first ten paying customers.
3. Curious about: Usage-based pricing; how Supabase grew as an open-source company.
4. Recurring questions: Pricing tiers, cold outreach, hiring a first engineer.
5. Sources: Lenny's Newsletter, Stratechery.
(Also mentioned a recent back injury.)`;

export const FACT_KIND_LABEL: Record<ProfileFact["kind"], string> = {
  work: "Work",
  building: "Building now",
  curious: "Curious about",
  recurring: "Keeps asking",
  source: "Reads",
};

const CATEGORY_LABEL: Record<SensitiveCategory, string> = {
  health: "a health detail",
  finances: "something about money",
  family: "something about family",
  other_people: "someone else's details",
  confidential: "something confidential",
  credentials: "a password or key",
};

export function droppedSummary(dropped: { category: SensitiveCategory }[]): string | null {
  if (!dropped.length) return null;
  const kinds = [...new Set(dropped.map((d) => CATEGORY_LABEL[d.category]))];
  const n = dropped.length;
  return `Left out ${n} line${n === 1 ? "" : "s"} that looked personal (${listText(kinds)}).`;
}

/**
 * What keeping a set of imported facts answers in the sentence: each fact
 * carries the parts of the form it fills, so unticked facts fill nothing.
 * Answers the user already gave stay unless a kept fact fills them.
 */
export function answersFromImport(facts: ProfileFact[], current: Answers): Partial<Answers> {
  const form = formFromFacts(facts);
  const merge = (a: string[], b: string[]) => [...a, ...b.filter((x) => !a.some((y) => y.toLowerCase() === x.toLowerCase()))];
  return {
    role: form.role ?? current.role,
    lately: form.lately ?? current.lately,
    topics: merge(current.topics, form.topics),
    platforms: merge(current.platforms, form.platforms),
  };
}

// ── The letter preview ──────────────────────────────────────────────────────

export type StageIcon = "envelope" | "note" | "pencil" | "tray" | "shield" | "stamp";

export interface Preview {
  icon: StageIcon;
  status: string;
  /** Null until a delivery time is chosen. */
  when: string | null;
  headline: string;
  items: { title: string; video: boolean; length: string }[];
  ghosts: number;
  ps: string;
}

const ROLE_PS: Record<string, string> = {
  founder: "P.S. A founder? I'll keep it short. You have investor emails to ignore.",
  "startup operator": "P.S. An operator. Someone has to actually make things happen.",
  consultant: "P.S. A consultant. I'll find you things worth billing for.",
  "founder-to-be": "P.S. Founder-to-be. Reading first is the right move.",
  investor: "P.S. An investor. I'll show you what founders are reading.",
};

/** The agent's aside after "Lately I've been into ___", keyed by the first topic it heard. */
const LATELY_PS: Partial<Record<Topic, string>> = {
  "business models": "P.S. A business-model nerd. Membership fees are my favourite magic trick too.",
  pricing: "P.S. Pricing. The one lever everyone's scared to pull. I'll find people who pulled it.",
  "open source": "P.S. Open source fan. I'll watch the repos and the people behind them.",
  "first customers": "P.S. First customers: the hardest ten people you'll ever meet. I'll find the playbooks.",
  sales: "P.S. Selling. I'll look for people who show their actual emails.",
  "AI tools": "P.S. AI, naturally. I'll skip the hype and keep the useful bits.",
  hiring: "P.S. Building a team. I'll find people who've done it well.",
  fundraising: "P.S. Fundraising. I'll keep it to what actually moves a round.",
  distribution: "P.S. Distribution. Building it is half; getting it seen is the other half.",
};

export interface PreviewInput {
  answers: Answers;
  step: Step | null;
  /** Sub-step of the import: choose, prompt, paste, review. */
  importStage: 0 | 1 | 2 | 3;
  assistant: Assistant;
  hasPaste: boolean;
  draftingLately: boolean;
  /** Topics heard in the lately answer, for the agent's aside. */
  heard: Topic[];
}

export function buildPreview({ answers: a, step, importStage, assistant, hasPaste, draftingLately, heard }: PreviewInput): Preview {
  const name = assistantLabel(assistant);
  const facts = a.imported?.facts ?? [];
  const work = facts.find((f) => f.kind === "work")?.text;
  const building = facts.find((f) => f.kind === "building")?.text;
  const recurring = facts.find((f) => f.kind === "recurring")?.text;
  const importedPs =
    work || building
      ? `P.S. ${capitalize([work && trimEnd(work), building && `${work ? "building " : ""}${lowerFirst(trimEnd(building))}`].filter(Boolean).join(", "))}. Busy week?`
      : null;

  let icon: StageIcon;
  let status: string;
  let ps: string;
  switch (step) {
    case "import":
      if (importStage === 3) {
        icon = "shield";
        status = "Checking for anything personal";
        ps = "P.S. I only keep what you tick. The rest goes in the shredder.";
      } else {
        icon = "note";
        status = importStage === 0 ? "Asking around at the counter" : importStage === 2 && hasPaste ? `Reading ${name}'s notes` : `Waiting for ${name}'s notes`;
        ps =
          importStage === 0
            ? "P.S. Your AI has probably been taking notes on you. Let's borrow them."
            : importStage === 1
              ? "P.S. Copy, paste, come back. I'll put the kettle on."
              : "P.S. I only keep what you tick on the next screen.";
      }
      break;
    case "role":
      icon = "envelope";
      status = a.role ? "Re-addressing the envelope" : "Finding you a fresh envelope";
      ps = a.role ? "P.S. Changed your mind? Happens at this counter all the time." : "P.S. No AI? No problem. Tell me who you are and I'll start writing.";
      break;
    case "lately":
      icon = "note";
      status = draftingLately ? "Taking notes at the counter" : "Listening at the counter";
      ps = `${a.role ? `${ROLE_PS[a.role] ?? `P.S. ${capitalize(withArticle(a.role))}. Noted.`} ` : "P.S. "}Now the fun part: what's caught your eye lately?`;
      break;
    case "topics":
      icon = "pencil";
      status = "Drafting at the post office";
      ps = (heard[0] && LATELY_PS[heard[0]]) || (a.lately ? "P.S. Noted. I'll go looking for more like that." : "P.S. Mysterious. I'll learn from what you read.");
      break;
    case "platforms":
      icon = "tray";
      status = a.platforms.length ? `Noting ${listText(a.platforms.map(platformLabel))}` : "Checking the mailroom for sources";
      ps = importedPs ? `${importedPs} Now, where do you already read?` : "P.S. Now, where do you already read? I'll start from there.";
      break;
    case "time":
      icon = "stamp";
      status = "Licking the stamp";
      ps = a.imported && recurring ? `P.S. ${name} says you keep asking about ${lowerFirst(trimEnd(recurring))}. Noted.` : "P.S. Nearly there. When do you actually read?";
      break;
    default:
      icon = "envelope";
      status = "Sealed at the counter";
      ps = "P.S. Before it goes out, five quick picks so I get your taste right.";
  }

  const lead = a.lately ? [{ title: `On ${quoteOf(a.lately)}`, video: false }] : [];
  const rest = a.topics.map((t, i) => ({
    title: capitalize(t) + (a.platforms.length ? `, via ${platformLabel(a.platforms[i % a.platforms.length]!)}` : ", from a new source"),
    video: i === 1,
  }));
  const LENGTHS = ["6 min", "18 min", "9 min"];
  const items = [...lead, ...rest].slice(0, 3).map((it, i) => ({ ...it, length: LENGTHS[i]! }));

  const heads = a.topics.slice(0, 2).map((t, i) => (i === 0 ? capitalize(t) : t));
  const headline = heads.length
    ? listText(heads) + (a.role ? `, for ${withArticle(a.role)}` : "")
    : a.role
      ? `A letter for ${withArticle(a.role)}`
      : "Your first letter";

  return {
    icon,
    status,
    // The board shows "Not scheduled" here, but beside a status it doesn't fit a phone-width card.
    when: a.preset ? PRESETS.find((p) => p.value === a.preset)!.when : null,
    headline,
    items,
    ghosts: 3 - items.length,
    ps,
  };
}

// ── The finished screen ─────────────────────────────────────────────────────

export function doneCopy({ liked, total, likedTopics, reasons, preset, nextRunAt }: {
  liked: number;
  total: number;
  likedTopics: string[];
  reasons: LikeReason[];
  preset: DeliveryPreset | null;
  nextRunAt: string | null;
}) {
  const arrives = `Arrives ${preset ? presetLabel(preset) : "soon"}${nextRunAt ? `, starting ${formatRun(nextRunAt)}` : ""}.`;
  const counts = new Map<LikeReason, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([r]) => r);
  const topLabels = top.map((r) => LIKE_REASONS.find((x) => x.value === r)!.label);
  const topPhrases = top.map((r) => LIKE_REASONS.find((x) => x.value === r)!.phrase);

  if (!liked) {
    return {
      title: "Your first letter is on its way.",
      note: `${arrives} Every letter has the same two buttons on each piece, so I'll learn as you read.`,
      reasons: topLabels,
    };
  }
  const more = likedTopics.length ? `More ${listText(likedTopics)}` : "More like those";
  return {
    title: `You'd read ${liked} of ${total}. Your first letter is on its way.`,
    note: `${more}${topPhrases.length ? `, especially when it's ${listText(topPhrases)}` : ""}. ${arrives} Shorter than your coffee, I promise.`,
    reasons: topLabels,
  };
}

function formatRun(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: "long" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}

// ── Text helpers ────────────────────────────────────────────────────────────

export function withArticle(word: string) {
  return (/^[aeiou]/i.test(word) ? "an " : "a ") + word;
}

export function listText(xs: string[]) {
  return xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

export function quoteOf(text: string) {
  const t = text.trim();
  return `“${t.length > 30 ? `${t.slice(0, 28).trim()}…` : t}”`;
}

export function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerFirst(s: string) {
  // Lowercases a leading article or ordinary word; acronyms and names ("B2B", "Supabase") stay as written.
  return /^(A|An|The)\b/.test(s) || (/^[A-Z][a-z]+\b/.test(s) && !/^[A-Z][a-z]+[A-Z]/.test(s)) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** "pricing, hiring and 3 more" */
export function topicsText(ts: string[]) {
  return ts.length > 4 ? `${ts.slice(0, 3).join(", ")} and ${ts.length - 3} more` : listText(ts);
}

function trimEnd(s: string) {
  return s.replace(/[.;,\s]+$/, "");
}
