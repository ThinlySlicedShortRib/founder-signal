// Lambda: founder-signal-<env>-discover. Triggered by the discover SQS queue.
import { sqsHandler } from "../lib/lambda.ts";

export const handler = sqsHandler("discover");
