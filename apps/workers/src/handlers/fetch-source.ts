// Lambda: founder-signal-<env>-fetch-source. Triggered by the fetch-source SQS queue.
import { sqsHandler } from "../lib/lambda.ts";

export const handler = sqsHandler("fetch-source");
