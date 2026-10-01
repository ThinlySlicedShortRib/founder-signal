import type { PipelineDeps } from "../pipeline/deps.ts";
import { dispatch } from "../pipeline/dispatch.ts";
import type { memoryQueues } from "./queues.ts";

type MemoryQueues = ReturnType<typeof memoryQueues>;

/**
 * Processes in-memory messages until none are left, waiting out delays (per-host
 * politeness). Failures are logged and dropped, like a message landing in a DLQ
 * after its retries.
 */
export async function drain(deps: PipelineDeps, mq: MemoryQueues, { maxAttempts = 3 } = {}) {
  const attempts = new Map<unknown, number>();
  let processed = 0;
  while (mq.pending.length) {
    const next = mq.take();
    if (!next) {
      const wait = Math.min(...mq.pending.map((m) => m.visibleAt)) - Date.now();
      await new Promise((r) => setTimeout(r, Math.max(wait, 50)));
      continue;
    }
    try {
      await dispatch(deps, next.queue, next.body);
      processed++;
    } catch (err) {
      const n = (attempts.get(next.body) ?? 0) + 1;
      attempts.set(next.body, n);
      console.error(`✗ ${next.queue} ${JSON.stringify(next.body)} (attempt ${n}): ${(err as Error).message}`);
      if (n < maxAttempts) mq.pending.push({ ...next, visibleAt: Date.now() + 2_000 * n });
    }
  }
  return processed;
}
