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
