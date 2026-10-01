import { readEnv } from "@fs/config";
import type { PipelineDeps } from "../pipeline/deps.ts";
import { dispatch } from "../pipeline/dispatch.ts";
import type { QueueName } from "../pipeline/messages.ts";
import { buildPipelineDeps } from "./build-deps.ts";
import { sqsQueues } from "./queues.ts";

let depsPromise: Promise<PipelineDeps> | undefined;

/** Built once per cold start (secrets, DB pool). */
export function lambdaDeps(): Promise<PipelineDeps> {
  if (!depsPromise) {
    const env = readEnv();
    depsPromise = buildPipelineDeps(
      env,
      sqsQueues({ "fetch-source": env.QUEUE_URL_FETCH_SOURCE, extract: env.QUEUE_URL_EXTRACT, enrich: env.QUEUE_URL_ENRICH }),
    );
    depsPromise.catch(() => (depsPromise = undefined));
  }
  return depsPromise;
}

interface SqsEvent {
  Records: { messageId: string; body: string }[];
}

/**
 * An SQS-triggered handler. Failed messages are reported individually
 * (ReportBatchItemFailures), so SQS retries only those and sends them to the
 * DLQ after maxReceiveCount.
 */
export function sqsHandler(queue: QueueName) {
  return async (event: SqsEvent) => {
    const deps = await lambdaDeps();
    const batchItemFailures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      try {
        await dispatch(deps, queue, JSON.parse(record.body));
      } catch (err) {
        console.error(JSON.stringify({ level: "error", queue, messageId: record.messageId, message: (err as Error).message, stack: (err as Error).stack }));
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}
