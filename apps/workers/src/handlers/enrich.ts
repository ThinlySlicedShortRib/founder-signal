// Lambda: founder-signal-<env>-enrich. Triggered by the enrich SQS queue.
import { sqsHandler } from "../lib/lambda.ts";

export const handler = sqsHandler("enrich");
