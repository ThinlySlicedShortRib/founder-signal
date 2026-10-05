// Lambda: founder-signal-<env>-podcast. Triggered by the podcast SQS queue (one episode per message).
import { sqsHandler } from "../lib/lambda.ts";

export const handler = sqsHandler("podcast");
