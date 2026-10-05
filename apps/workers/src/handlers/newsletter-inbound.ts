// Lambda: founder-signal-<env>-newsletter-inbound. SES saves each message to the mail bucket and
// publishes a notification to SNS, which delivers it to this function's SQS queue
// (docs/imports/README.md, "Newsletters by email"; infra/modules/inbound_email).
import { readEnv } from "@fs/config";
import { lambdaDeps } from "../lib/lambda.ts";
import { receiveInbound } from "../newsletters/receive.ts";
import { deliveryFromSesMessage } from "../newsletters/ses.ts";

interface SqsEvent {
  Records: { messageId: string; body: string }[];
}

const bucket = readEnv().INBOUND_MAIL_BUCKET;

export async function handler(event: SqsEvent) {
  const deps = await lambdaDeps();
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      if (!bucket) throw new Error("INBOUND_MAIL_BUCKET isn't set");
      const delivery = deliveryFromSesMessage(record.body, { bucket });
      if (!delivery) {
        console.log(JSON.stringify({ level: "info", event: "newsletter_inbound_ignored", messageId: record.messageId }));
        continue;
      }
      await receiveInbound(deps, delivery);
    } catch (err) {
      console.error(JSON.stringify({ level: "error", queue: "newsletter-inbound", messageId: record.messageId, message: (err as Error).message, stack: (err as Error).stack }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
