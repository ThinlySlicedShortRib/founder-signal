import Anthropic from "@anthropic-ai/sdk";
import {
  anthropicAuthorEnricher,
  anthropicEnrichmentBatches,
  anthropicLetterWriter,
  type AuthorEnricher,
  bedrockTitanEmbedder,
  claudeCliAuthorEnricher,
  claudeCliLetterWriter,
  ENRICHMENT_MODEL,
  ENRICHMENT_PROMPT_VERSION,
  type EnrichmentBatches,
  fallbackLetterWriter,
  LETTER_PROMPT_VERSION,
  LETTER_WRITER_MODEL,
  type LetterWriter,
  AUTHOR_ENRICHMENT_MODEL,
} from "@fs/ai";
import {
  type Env,
  letterWriterMode,
  resolveAnthropicApiKey,
  resolveContentDir,
  resolveDatabaseConfig,
  resolveSupadataApiKey,
  resolveUnsplashAccessKey,
  resolveYouTubeApiKey,
} from "@fs/config";
import { createDb } from "@fs/db";
import { createSafeFetcher, supadataProvider, youTubeDataClient } from "@fs/ingest";
import { unsplashStockPhotos } from "../letters/images.ts";
import type { PipelineDeps } from "../pipeline/deps.ts";
import { fsContentStore, s3ContentStore } from "./content-store.ts";
import type { Queues } from "./queues.ts";

/** Wires the pipeline from the environment. Shared by the Lambdas and the local runner. */
export async function buildPipelineDeps(env: Env, queues: Queues): Promise<PipelineDeps & { close(): Promise<void> }> {
  const [dbConfig, youTubeKey, supadataKey, unsplashKey] = await Promise.all([
    resolveDatabaseConfig(env),
    resolveYouTubeApiKey(env),
    resolveSupadataApiKey(env),
    resolveUnsplashAccessKey(env),
  ]);
  const { db, pool } = createDb(dbConfig);

  const enricher =
    env.ENRICHMENT === "anthropic"
      ? { batches: lazyEnrichmentBatches(env), embedder: bedrockTitanEmbedder({ modelId: env.EMBEDDING_MODEL_ID }) }
      : null;

  const mode = letterWriterMode(env);
  return {
    db,
    queues,
    store: env.CONTENT_BUCKET ? s3ContentStore(env.CONTENT_BUCKET) : fsContentStore(resolveContentDir(env)),
    fetch: createSafeFetcher(),
    youtube: youTubeKey ? youTubeDataClient({ apiKey: youTubeKey }) : null,
    transcripts: supadataKey ? supadataProvider({ apiKey: supadataKey }) : null,
    enricher,
    letterWriter:
      mode === "claude-cli" ? claudeCliLetterWriter({ command: env.CLAUDE_CLI_PATH }) : mode === "anthropic" ? lazyLetterWriter(env) : fallbackLetterWriter,
    authorEnricher:
      mode === "claude-cli" ? claudeCliAuthorEnricher({ command: env.CLAUDE_CLI_PATH }) : mode === "anthropic" ? lazyAuthorEnricher(env) : null,
    stockPhotos: unsplashKey ? unsplashStockPhotos({ accessKey: unsplashKey, db }) : null,
    close: () => pool.end(),
  };
}

/**
 * The Anthropic key is resolved on first use, so a key that hasn't been set
 * yet only fails that call (retried, or written from excerpts), not every
 * worker's cold start.
 */
function lazyClient(env: Env) {
  let client: Promise<Anthropic> | undefined;
  return () => {
    client ??= resolveAnthropicApiKey(env).then((apiKey) => new Anthropic({ apiKey }));
    client.catch(() => (client = undefined));
    return client;
  };
}

function lazyEnrichmentBatches(env: Env): EnrichmentBatches {
  const client = lazyClient(env);
  return {
    model: ENRICHMENT_MODEL,
    promptVersion: ENRICHMENT_PROMPT_VERSION,
    submit: async (inputs) => anthropicEnrichmentBatches(await client()).submit(inputs),
    results: async (id) => anthropicEnrichmentBatches(await client()).results(id),
  };
}

function lazyLetterWriter(env: Env): LetterWriter {
  const client = lazyClient(env);
  return {
    method: "anthropic",
    model: LETTER_WRITER_MODEL,
    promptVersion: LETTER_PROMPT_VERSION,
    write: async (input) => anthropicLetterWriter(await client()).write(input),
  };
}

function lazyAuthorEnricher(env: Env): AuthorEnricher {
  const client = lazyClient(env);
  return {
    method: "anthropic",
    model: AUTHOR_ENRICHMENT_MODEL,
    enrich: async (query) => anthropicAuthorEnricher(await client()).enrich(query),
  };
}
