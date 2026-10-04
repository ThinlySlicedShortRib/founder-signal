import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

/** Starts a new letter's pipeline: the first `letter-step` message (§6.2). */
export interface LetterQueue {
  start(letterId: string): Promise<void>;
}

/** On AWS. Locally there's no queue the API can reach; the dev runner's watchdog picks new letters up instead. */
export function sqsLetterQueue(queueUrl: string): LetterQueue {
  const sqs = new SQSClient({});
  return {
    async start(letterId) {
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ letterId, expectedStatus: "scheduled" }) }));
    },
  };
}

/** Starts a discovery run (§6.3a) that a held letter waits on: a `discover` message. */
export interface DiscoverQueue {
  start(runId: string): Promise<void>;
}

/** On AWS. Locally the dev runner's letter sweep starts the runs that held letters wait on. */
export function sqsDiscoverQueue(queueUrl: string): DiscoverQueue {
  const sqs = new SQSClient({});
  return {
    async start(runId) {
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ runId }) }));
    },
  };
}
