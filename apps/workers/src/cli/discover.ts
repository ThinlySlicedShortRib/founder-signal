// Runs open web discovery for a user now, then prints what it found (build plan §6.3a).
//   pnpm --filter @fs/workers discover <email>
// The sweep only starts discovery a few hours before a scheduled letter; this is for trying it,
// e.g. before sending a test letter from the app.
import { randomUUID } from "node:crypto";
import { readEnv } from "@fs/config";
import { schema } from "@fs/db";
import { eq } from "drizzle-orm";
import { discover } from "../discovery/discover.ts";
import { buildPipelineDeps } from "../lib/build-deps.ts";
import { drain } from "../lib/local.ts";
import { memoryQueues } from "../lib/queues.ts";

const { contentItem, discoveryQuery, discoveryRun, publisher, user, userDiscovery } = schema;

const [email] = process.argv.slice(2);
if (!email) {
  console.error("Usage: pnpm --filter @fs/workers discover <email>");
  process.exit(1);
}

const mq = memoryQueues();
const deps = await buildPipelineDeps(readEnv(), mq.queues);
const { db } = deps;
deps.log = () => {};

try {
  if (!deps.discovery) {
    console.error("Discovery is off (DISCOVERY=none).");
    process.exit(1);
  }
  const [u] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!u) {
    console.error(`No user ${email}.`);
    process.exit(1);
  }

  const [run] = await db
    .insert(discoveryRun)
    .values({ userId: u.id, occurrenceId: `manual#${randomUUID()}`, letterDueAt: new Date() })
    .returning();
  console.log(`Searching (${deps.discovery.search.method})…`);
  await discover(deps, { runId: run!.id });
  console.log("Extracting what it found…");
  await drain(deps, mq);

  const queries = await db.select().from(discoveryQuery).where(eq(discoveryQuery.runId, run!.id)).orderBy(discoveryQuery.position);
  for (const q of queries) {
    console.log(`\n■ ${q.queryText}  [${q.status}${q.resultCount !== null ? `, ${q.resultCount} results, ${q.acceptedCount} new` : ""}]`);
    const found = await db
      .select({ status: contentItem.status, reason: contentItem.statusReason, title: contentItem.title, url: contentItem.canonicalUrl, why: userDiscovery.reason, publisher: publisher.status })
      .from(userDiscovery)
      .innerJoin(contentItem, eq(contentItem.id, userDiscovery.itemId))
      .innerJoin(publisher, eq(publisher.id, contentItem.publisherId))
      .where(eq(userDiscovery.queryId, q.id));
    for (const f of found) {
      console.log(`  ${f.status.padEnd(13)} ${(f.title ?? f.url).slice(0, 70).padEnd(72)} ${f.reason ? `(${f.reason})` : ""}`);
      console.log(`  ${"".padEnd(13)} ↳ ${f.why}`);
    }
  }
  const [done] = await db.select().from(discoveryRun).where(eq(discoveryRun.id, run!.id));
  console.log(`\n${done!.itemsLinked} pages linked, ${done!.itemsQueued} new; ${done!.searchesRun} billed searches, ${done!.cacheHits} from cache (queries: ${done!.queryMethod}).`);
} finally {
  await deps.close?.();
}
