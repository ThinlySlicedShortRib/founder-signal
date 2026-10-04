// Lambda: founder-signal-<env>-author. Triggered by the author SQS queue.
import { sqsHandler } from "../lib/lambda.ts";

export const handler = sqsHandler("author");
