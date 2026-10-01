import { z } from "zod";

/** Queue names match the SQS queues in infra (build plan §4, `queues`). */
export const queueNames = ["fetch-source", "extract", "enrich"] as const;
export type QueueName = (typeof queueNames)[number];

export const messageSchemas = {
  "fetch-source": z.object({ sourceId: z.uuid() }),
  extract: z.object({ itemId: z.uuid() }),
  enrich: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("submit") }),
    z.object({ kind: z.literal("poll"), batchId: z.uuid() }),
  ]),
} satisfies Record<QueueName, z.ZodType>;

export type Message<Q extends QueueName> = z.infer<(typeof messageSchemas)[Q]>;
