// Lambda: founder-signal-<env>-extract. Triggered by the extract SQS queue.
import { sqsHandler } from "../lib/lambda.ts";

export const handler = sqsHandler("extract");
