import { schema } from "@fs/db";
import { sql } from "drizzle-orm";
import type { PipelineDeps } from "../pipeline/deps.ts";
import { generateEpisode } from "./generate.ts";

/**
 * Local development only: the API can't reach the dev runner's in-memory
 * queues, so episodes it queued (or whose worker died) are found in the
 * database and made here, one at a time.
 */
export async function runQueuedEpisodes(deps: PipelineDeps): Promise<number> {
  if (!deps.podcast) return 0;
  const { episode } = schema;
  const due = await deps.db.execute<{ id: string }>(sql`
    select id from ${episode}
    where status = 'queued' or (status in ('scripting', 'voicing') and started_at < now() - interval '20 minutes')
    order by created_at
    limit 5`);
  for (const { id } of due.rows) await generateEpisode(deps, { episodeId: id });
  return due.rows.length;
}
