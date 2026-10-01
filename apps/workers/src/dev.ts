// Local pipeline: `pnpm dev:workers`. Sweeps every minute and drains in-memory queues.
import { readEnv } from "@fs/config";
import { buildPipelineDeps } from "./lib/build-deps.ts";
import { drain } from "./lib/local.ts";
import { memoryQueues } from "./lib/queues.ts";
import { sweep } from "./pipeline/sweep.ts";

const SWEEP_INTERVAL_MS = 60_000;

const mq = memoryQueues();
const deps = await buildPipelineDeps(readEnv(), mq.queues);
console.log(`Workers running locally; sweeping every ${SWEEP_INTERVAL_MS / 1000}s. Ctrl+C to stop.`);

for (;;) {
  await sweep(deps);
  await drain(deps, mq);
  await new Promise((r) => setTimeout(r, SWEEP_INTERVAL_MS));
}
