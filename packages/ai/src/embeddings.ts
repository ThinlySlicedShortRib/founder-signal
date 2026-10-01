import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";

/**
 * Item embeddings stay on AWS (build plan §1): Anthropic has no embeddings
 * model. Titan Text Embeddings v2 at 1024 dimensions, normalized for cosine
 * distance in pgvector.
 */

export const EMBEDDING_DIMENSIONS = 1024;

export interface Embedder {
  readonly modelId: string;
  embed(text: string): Promise<number[]>;
}

/** Titan v2 accepts up to 8,192 tokens; this keeps well inside it. */
const MAX_EMBED_CHARS = 20_000;

const titanResponse = z.object({ embedding: z.array(z.number()) });

export function bedrockTitanEmbedder({
  modelId = "amazon.titan-embed-text-v2:0",
  client = new BedrockRuntimeClient({}),
}: { modelId?: string; client?: BedrockRuntimeClient } = {}): Embedder {
  return {
    modelId,
    async embed(text) {
      const res = await client.send(
        new InvokeModelCommand({
          modelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({ inputText: text.slice(0, MAX_EMBED_CHARS), dimensions: EMBEDDING_DIMENSIONS, normalize: true }),
        }),
      );
      const { embedding } = titanResponse.parse(JSON.parse(new TextDecoder().decode(res.body)));
      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Expected ${EMBEDDING_DIMENSIONS} dimensions from ${modelId}, got ${embedding.length}`);
      }
      return embedding;
    },
  };
}

/** What gets embedded for an item: its title, tags and opening text. */
export function embeddingText({ title, tags, text }: { title: string | null; tags: string[]; text: string }): string {
  return [title, tags.length ? `Topics: ${tags.join(", ")}` : null, text].filter(Boolean).join("\n\n");
}
