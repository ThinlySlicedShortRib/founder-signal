// Delivers a raw email (.eml) to a user's inbound address and processes it, as SES would on AWS.
//   pnpm --filter @fs/workers newsletter <file.eml> [--user <email> | --to <address>]
// Without --user or --to, the recipient comes from the message's own headers.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { readEnv } from "@fs/config";
import { getOrCreateInboundAddress, schema } from "@fs/db";
import { newInboundLocalPart } from "@fs/ingest";
import { eq } from "drizzle-orm";
import { buildPipelineDeps } from "../lib/build-deps.ts";
import { memoryQueues } from "../lib/queues.ts";
import { receiveInbound } from "../newsletters/receive.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const userEmail = flag("--user");
let to = flag("--to");
const [file] = args;
if (!file) {
  console.error("Usage: pnpm --filter @fs/workers newsletter <file.eml> [--user <email> | --to <address>]");
  process.exit(1);
}

const deps = await buildPipelineDeps(readEnv(), memoryQueues().queues);
deps.log = () => {};
try {
  if (!deps.inbound) throw new Error("Newsletter forwarding is off: set INBOUND_EMAIL_DOMAIN");
  if (userEmail) {
    const [u] = await deps.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, userEmail));
    if (!u) throw new Error(`No user ${userEmail}`);
    const address = await getOrCreateInboundAddress(deps.db, u.id, () => newInboundLocalPart());
    to = `${address.localPart}@${deps.inbound.domain}`;
  }
  // The INIT_CWD is where pnpm was run from, so relative paths work from the repo root.
  const raw = await readFile(resolve(process.env.INIT_CWD ?? process.cwd(), file));
  const rawKey = `inbound/cli-${randomUUID()}-${basename(file).replace(/[^\w.-]/g, "_")}`;
  await deps.inbound.mail.put(rawKey, new Uint8Array(raw));
  const outcome = await receiveInbound(deps, { rawKey, envelopeTo: to ? [to] : null });
  console.log(JSON.stringify({ to: to ?? "(from headers)", ...outcome }, null, 2));
} catch (err) {
  console.error(`✗ ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await deps.close();
}
