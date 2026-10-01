import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { Message, QueueName } from "../pipeline/messages.ts";

export interface Queues {
  send<Q extends QueueName>(queue: Q, message: Message<Q>, options?: { delaySeconds?: number }): Promise<void>;
}

export function sqsQueues(urls: Record<QueueName, string | undefined>): Queues {
  const sqs = new SQSClient({});
  return {
    async send(queue, message, { delaySeconds } = {}) {
      const QueueUrl = urls[queue];
      if (!QueueUrl) throw new Error(`No queue URL configured for ${queue}`);
      await sqs.send(
        new SendMessageCommand({
          QueueUrl,
          MessageBody: JSON.stringify(message),
          DelaySeconds: delaySeconds ? Math.min(Math.ceil(delaySeconds), 900) : undefined,
        }),
      );
    },
  };
}

export interface QueuedMessage {
  queue: QueueName;
  body: unknown;
  /** Epoch ms before which the message isn't delivered. */
  visibleAt: number;
}

/** Local runner and tests: messages wait in an array until drained. */
export function memoryQueues(now: () => number = Date.now) {
  const pending: QueuedMessage[] = [];
  const queues: Queues = {
    async send(queue, message, { delaySeconds = 0 } = {}) {
      pending.push({ queue, body: structuredClone(message), visibleAt: now() + delaySeconds * 1000 });
    },
  };
  return {
    queues,
    pending,
    /** Removes and returns the next deliverable message, ignoring delays when `ignoreDelay` is set. */
    take(ignoreDelay = false): QueuedMessage | undefined {
      const index = pending.findIndex((m) => ignoreDelay || m.visibleAt <= now());
      return index === -1 ? undefined : pending.splice(index, 1)[0];
    },
  };
}
