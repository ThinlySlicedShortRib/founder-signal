// Creates mock founder accounts for trying the app end to end, each with a
// profile, topics, a schedule and a few real feeds. Safe to re-run: existing
// accounts are refreshed, not duplicated. Local development only.
//   pnpm --filter @fs/workers seed:personas
// The running workers (`pnpm dev:workers`) fetch the new feeds on their next sweep.
import { randomUUID } from "node:crypto";
import { DELIVERY_PRESETS, nextRunAt } from "@fs/core";
import { readEnv } from "@fs/config";
import { addUserSource, schema } from "@fs/db";
import { detectSource, SourceDetectionError } from "@fs/ingest";
import type { DeliveryPreset } from "@fs/schema";
import { and, eq, inArray } from "drizzle-orm";
import { buildPipelineDeps } from "../lib/build-deps.ts";
import { memoryQueues } from "../lib/queues.ts";

const { profile, schedule, source, topicWeight, user } = schema;

interface Persona {
  email: string;
  name: string;
  /** Null leaves the account brand new, for walking through onboarding. */
  role: string | null;
  lately: string | null;
  platforms: string[];
  topics: string[];
  preset: DeliveryPreset;
  timeZone: string;
  feeds: string[];
}

const PERSONAS: Persona[] = [
  {
    email: "maya@founder-signal.local",
    name: "Maya Chen",
    role: "B2B SaaS founder, Series A",
    lately: "Moving upmarket to enterprise and hiring our first sales team",
    platforms: ["substack", "linkedin"],
    topics: ["pricing", "enterprise sales", "hiring", "fundraising"],
    preset: "weekday_mornings",
    timeZone: "Asia/Taipei",
    feeds: ["https://www.lennysnewsletter.com/feed", "https://tomtunguz.com/index.xml"],
  },
  {
    email: "raj@founder-signal.local",
    name: "Raj Patel",
    role: "Technical founder building AI developer tools",
    lately: "Figuring out how to price usage-based AI features and get our first 100 users",
    platforms: ["x", "youtube"],
    topics: ["developer tools", "AI", "open source", "first customers"],
    preset: "evenings",
    timeZone: "Asia/Singapore",
    feeds: ["https://simonwillison.net/atom/everything/", "https://jvns.ca/atom.xml"],
  },
  {
    email: "lena@founder-signal.local",
    name: "Lena Okafor",
    role: "Consumer marketplace founder, pre-seed",
    lately: "Solving the cold-start problem on the supply side",
    platforms: ["x", "substack"],
    topics: ["marketplaces", "growth", "network effects", "fundraising"],
    preset: "sunday_mornings",
    timeZone: "Australia/Sydney",
    feeds: ["https://andrewchen.com/feed/", "https://www.notboring.co/feed"],
  },
  {
    email: "sam@founder-signal.local",
    name: "Sam Rivera",
    role: "Solo bootstrapper running a productized service",
    lately: "Turning consulting work into a product and getting off hourly billing",
    platforms: ["youtube"],
    topics: ["bootstrapping", "productized services", "SEO", "business models"],
    preset: "lunch",
    timeZone: "Asia/Taipei",
    feeds: ["https://seths.blog/feed", "https://longform.asmartbear.com/index.xml"],
  },
  {
    email: "new@founder-signal.local",
    name: "New Founder",
    role: null,
    lately: null,
    platforms: [],
    topics: [],
    preset: "weekday_mornings",
    timeZone: "Asia/Taipei",
    feeds: [],
  },
];

const mq = memoryQueues();
const deps = await buildPipelineDeps(readEnv(), mq.queues);
const { db } = deps;

try {
  for (const p of PERSONAS) {
    await db.insert(user).values({ id: randomUUID(), name: p.name, email: p.email, emailVerified: true }).onConflictDoNothing({ target: user.email });
    const [u] = await db.select({ id: user.id }).from(user).where(eq(user.email, p.email));
    const userId = u!.id;

    if (!p.role) {
      console.log(`${p.email}: brand new (not onboarded)`);
      continue;
    }

    const now = new Date();
    await db
      .insert(profile)
      .values({ userId, role: p.role, lately: p.lately, platforms: p.platforms, onboardedAt: now })
      .onConflictDoUpdate({ target: profile.userId, set: { role: p.role, lately: p.lately, platforms: p.platforms, onboardedAt: now } });

    await db.delete(topicWeight).where(and(eq(topicWeight.userId, userId), eq(topicWeight.origin, "explicit")));
    await db.insert(topicWeight).values(p.topics.map((topic) => ({ userId, topic, origin: "explicit" as const })));

    const rule = { ...DELIVERY_PRESETS[p.preset], timeZone: p.timeZone };
    const values = { preset: p.preset, ...rule, nextRunAt: nextRunAt(rule, now) };
    await db.insert(schedule).values({ userId, ...values }).onConflictDoUpdate({ target: schedule.userId, set: values });

    const sourceIds: string[] = [];
    for (const url of p.feeds) {
      try {
        const detected = await detectSource(url, { fetch: deps.fetch, youtube: deps.youtube });
        sourceIds.push(await addUserSource(db, { userId, mode: "more_like_this", detected }));
      } catch (err) {
        if (!(err instanceof SourceDetectionError)) throw err;
        console.log(`  ✗ ${url}: ${err.message}`);
      }
    }
    // Due now, so the running workers fetch them on their next sweep.
    if (sourceIds.length) await db.update(source).set({ nextFetchAt: now }).where(inArray(source.id, sourceIds));

    console.log(`${p.email}: ${p.role}; ${p.topics.length} topics, ${sourceIds.length}/${p.feeds.length} feeds, ${p.preset} (${p.timeZone})`);
  }
} finally {
  await deps.close();
}
