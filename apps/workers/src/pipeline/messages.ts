import { z } from "zod";

/** Queue names match the SQS queues in infra (build plan §4, `queues`). */
export const queueNames = ["fetch-source", "extract", "enrich", "letter-step", "author", "discover", "podcast"] as const;
export type QueueName = (typeof queueNames)[number];

/** Statuses a letter-step message can expect (§6.2): the step it runs is the one after it. */
export const letterStepStatuses = ["scheduled", "collecting", "ranking", "generating"] as const;

export const messageSchemas = {
  "fetch-source": z.object({ sourceId: z.uuid() }),
  extract: z.object({ itemId: z.uuid() }),
  enrich: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("submit") }),
    z.object({ kind: z.literal("poll"), batchId: z.uuid() }),
  ]),
  "letter-step": z.object({ letterId: z.uuid(), expectedStatus: z.enum(letterStepStatuses) }),
  author: z.object({ authorKey: z.string().min(1).max(300) }),
  discover: z.object({ runId: z.uuid() }),
  podcast: z.object({ episodeId: z.uuid() }),
} satisfies Record<QueueName, z.ZodType>;

export type Message<Q extends QueueName> = z.infer<(typeof messageSchemas)[Q]>;
