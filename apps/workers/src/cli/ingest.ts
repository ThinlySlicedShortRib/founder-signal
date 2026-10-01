// Adds sources for a user and runs ingestion to completion, then prints the items.
//   pnpm --filter @fs/workers ingest <email> <url> [url…]
// This is the M1 exit check: real sources → items with rights flags.
import { randomUUID } from "node:crypto";
import { readEnv } from "@fs/config";
import { addUserSource, schema } from "@fs/db";
import { detectSource, SourceDetectionError } from "@fs/ingest";
import { and, eq, inArray } from "drizzle-orm";
import { buildPipelineDeps } from "../lib/build-deps.ts";
import { drain } from "../lib/local.ts";
import { memoryQueues } from "../lib/queues.ts";
import { sweep } from "../pipeline/sweep.ts";

const { contentItem, contentVersion, enrichmentBatch, source, user, userSource } = schema;

const [email, ...urls] = process.argv.slice(2);
if (!email || !urls.length) {
  console.error("Usage: pnpm --filter @fs/workers ingest <email> <url> [url…]");
  process.exit(1);
}

const mq = memoryQueues();
const deps = await buildPipelineDeps(readEnv(), mq.queues);
const { db } = deps;
const quiet = () => {};
deps.log = quiet;

try {
  await db.insert(user).values({ id: randomUUID(), name: email.split("@")[0]!, email }).onConflictDoNothing({ target: user.email });
  const [u] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));

  const sourceIds: string[] = [];
  for (const url of urls) {
    try {
      const detected = await detectSource(url, { fetch: deps.fetch, youtube: deps.youtube });
      sourceIds.push(await addUserSource(db, { userId: u!.id, mode: "more_like_this", detected }));
      console.log(`+ ${detected.type.padEnd(15)} ${detected.title}  (${detected.canonicalKey})`);
    } catch (err) {
      if (!(err instanceof SourceDetectionError)) throw err;
      console.log(`✗ ${url}: ${err.message}`);
    }
  }
  if (!sourceIds.length) process.exit(1);

  // Make just-added sources due now even if they were fetched recently by someone else.
  await db.update(source).set({ nextFetchAt: new Date() }).where(and(inArray(source.id, sourceIds), eq(source.type, "feed")));

  console.log("\nFetching and extracting…");
  await sweep(deps);
  await drain(deps, mq);

  if (deps.enricher) {
    console.log("Enriching (Message Batches usually finish within minutes; Ctrl+C to stop waiting)…");
    await sweep(deps);
    await drain(deps, mq);
    for (;;) {
      const open = await db.select({ id: enrichmentBatch.id }).from(enrichmentBatch).where(eq(enrichmentBatch.status, "submitted"));
      if (!open.length) break;
      await new Promise((r) => setTimeout(r, 20_000));
      for (const { id } of open) await mq.queues.send("enrich", { kind: "poll", batchId: id });
      await drain(deps, mq);
    }
  }

  const rows = await db
    .select({
      status: contentItem.status,
      reason: contentItem.statusReason,
      type: contentItem.type,
      title: contentItem.title,
      words: contentItem.wordCount,
      tags: contentItem.tags,
      quality: contentItem.qualityLabel,
      rights: contentVersion.rightsSnapshot,
      blocksKey: contentVersion.blocksKey,
      sourceTitle: source.title,
    })
    .from(contentItem)
    .innerJoin(source, eq(source.id, contentItem.sourceId))
    .innerJoin(userSource, and(eq(userSource.sourceId, source.id), eq(userSource.userId, u!.id)))
    .leftJoin(contentVersion, eq(contentVersion.itemId, contentItem.id))
    .where(inArray(source.id, sourceIds))
    .orderBy(source.title, contentItem.publishedAt);

  let current = "";
  for (const r of rows) {
    if (r.sourceTitle !== current) console.log(`\n■ ${(current = r.sourceTitle)}`);
    const rights = r.rights as { display?: string; offlineAllowed?: boolean } | null;
    const flags = rights ? `${rights.display}${rights.offlineAllowed ? ", offline" : ""}${r.blocksKey ? ", stored" : ""}` : "—";
    const detail = r.reason ? `(${r.reason})` : `${r.words ?? 0} words${r.tags?.length ? ` · ${r.tags.join(", ")}` : ""}${r.quality ? ` · ${r.quality}` : ""}`;
    console.log(`  ${r.status.padEnd(13)} ${r.type === "video" ? "▶ " : ""}${(r.title ?? "(untitled)").slice(0, 60).padEnd(62)} ${flags.padEnd(28)} ${detail}`);
  }
  console.log(`\n${rows.length} items.`);
} finally {
  await deps.close?.();
}
