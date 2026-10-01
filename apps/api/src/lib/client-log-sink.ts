import { randomUUID } from "node:crypto";
import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from "@aws-sdk/client-cloudwatch-logs";
import type { ClientLogEntry } from "@fs/schema";

/** A mobile error report plus what the server knows about the sender. */
export interface ClientLogRecord extends ClientLogEntry {
  userId: string | null;
  receivedAt: string;
}

export interface ClientLogSink {
  write(records: ClientLogRecord[]): Promise<void>;
}

/** Local development: one JSON line per report on stdout. */
export function consoleClientLogSink(): ClientLogSink {
  return {
    async write(records) {
      for (const record of records) console.log(JSON.stringify({ type: "client_log", ...record }));
    },
  };
}

/**
 * Writes to the dedicated mobile log group (e.g. /founder-signal/dev/mobile).
 * Each Lambda instance writes to its own stream, created on first use, so
 * concurrent instances never contend for one stream.
 */
export function cloudWatchClientLogSink(logGroupName: string): ClientLogSink {
  const logs = new CloudWatchLogsClient({});
  let logStreamName: string | undefined;

  async function ensureStream() {
    if (logStreamName) return logStreamName;
    const name = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}`;
    try {
      await logs.send(new CreateLogStreamCommand({ logGroupName, logStreamName: name }));
    } catch (err) {
      if (!(err instanceof ResourceAlreadyExistsException)) throw err;
    }
    logStreamName = name;
    return name;
  }

  return {
    async write(records) {
      const stream = await ensureStream();
      // CloudWatch requires events in chronological order.
      const logEvents = records
        .map((record) => ({ timestamp: Date.parse(record.occurredAt), message: JSON.stringify(record) }))
        .sort((a, b) => a.timestamp - b.timestamp);
      await logs.send(new PutLogEventsCommand({ logGroupName, logStreamName: stream, logEvents }));
    },
  };
}
