import Anthropic from "@anthropic-ai/sdk";
import { anthropicEnrichmentBatches, bedrockTitanEmbedder } from "@fs/ai";
import { type Env, resolveAnthropicApiKey, resolveDatabaseConfig, resolveSupadataApiKey, resolveYouTubeApiKey } from "@fs/config";
import { createDb } from "@fs/db";
import { createSafeFetcher, supadataProvider, youTubeDataClient } from "@fs/ingest";
import type { PipelineDeps } from "../pipeline/deps.ts";
import { fsContentStore, s3ContentStore } from "./content-store.ts";
import type { Queues } from "./queues.ts";

/** Wires the pipeline from the environment. Shared by the Lambdas and the local runner. */
export async function buildPipelineDeps(env: Env, queues: Queues): Promise<PipelineDeps & { close(): Promise<void> }> {
  const [dbConfig, youTubeKey, supadataKey] = await Promise.all([
    resolveDatabaseConfig(env),
    resolveYouTubeApiKey(env),
    resolveSupadataApiKey(env),
  ]);
  const { db, pool } = createDb(dbConfig);

  const enricher =
    env.ENRICHMENT === "anthropic"
      ? {
          batches: anthropicEnrichmentBatches(new Anthropic({ apiKey: await resolveAnthropicApiKey(env) })),
          embedder: bedrockTitanEmbedder({ modelId: env.EMBEDDING_MODEL_ID }),
        }
      : null;

  return {
    db,
    queues,
    store: env.CONTENT_BUCKET ? s3ContentStore(env.CONTENT_BUCKET) : fsContentStore(env.CONTENT_DIR),
    fetch: createSafeFetcher(),
    youtube: youTubeKey ? youTubeDataClient({ apiKey: youTubeKey }) : null,
    transcripts: supadataKey ? supadataProvider({ apiKey: supadataKey }) : null,
    enricher,
    close: () => pool.end(),
  };
}
