// Lambda: founder-signal-<env>-letter-step. Triggered by the letter-step SQS queue.
import { sqsHandler } from "../lib/lambda.ts";

export const handler = sqsHandler("letter-step");
