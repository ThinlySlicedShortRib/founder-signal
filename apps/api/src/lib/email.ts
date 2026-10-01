import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Local development: print the email instead of sending it. */
export function consoleEmailSender(): EmailSender {
  return {
    async send({ to, subject, text }) {
      console.log(`\n✉️  To: ${to}\n   Subject: ${subject}\n   ${text.replaceAll("\n", "\n   ")}\n`);
    },
  };
}

export function sesEmailSender(from: string): EmailSender {
  const ses = new SESv2Client({});
  return {
    async send({ to, subject, text }) {
      await ses.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [to] },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: "UTF-8" },
              Body: { Text: { Data: text, Charset: "UTF-8" } },
            },
          },
        }),
      );
    },
  };
}
