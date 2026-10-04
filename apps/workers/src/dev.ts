// Local pipeline: `pnpm dev:workers`. Sweeps every minute and drains in-memory queues.
// Letters are checked every few seconds, so a test letter from the app is ready within a minute.
import { readEnv } from "@fs/config";
import { buildPipelineDeps } from "./lib/build-deps.ts";
import { drain } from "./lib/local.ts";
import { memoryQueues } from "./lib/queues.ts";
import { sweepLetters } from "./letters/sweep.ts";
import { sweep } from "./pipeline/sweep.ts";

const SWEEP_INTERVAL_MS = 60_000;
const LETTER_INTERVAL_MS = 5_000;

const mq = memoryQueues();
const deps = await buildPipelineDeps(readEnv(), mq.queues);
console.log(`Workers running locally; sweeping every ${SWEEP_INTERVAL_MS / 1000}s, letters every ${LETTER_INTERVAL_MS / 1000}s. Ctrl+C to stop.`);

let lastSweep = 0;
for (;;) {
  if (Date.now() - lastSweep >= SWEEP_INTERVAL_MS) {
    lastSweep = Date.now();
    await sweep(deps);
  } else {
    // The API can't reach these in-memory queues, so a test letter it creates waits here for the watchdog.
    await sweepLetters(deps);
  }
  await drain(deps, mq);
  await new Promise((r) => setTimeout(r, LETTER_INTERVAL_MS));
}
