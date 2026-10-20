// Run with `pnpm --filter @fs/mobile test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIRM_MS, createEpisodeTasks, DONE_MS, ETA_EARLY, IDLE_LOCAL, newEta, phaseOf, rawSecondsLeft, ringTarget, rowShows, stepOf, STOPPED_MS, tickEta } from "./episode-task.ts";

function fakeTimers() {
  let now = 1000;
  let next = 0;
  const queue: { at: number; fn: () => void; id: number }[] = [];
  return {
    now: () => now,
    set: (fn: () => void, ms: number) => {
      queue.push({ at: now + ms, fn, id: ++next });
      return next;
    },
    clear: (t: unknown) => {
      const i = queue.findIndex((q) => q.id === t);
      if (i >= 0) queue.splice(i, 1);
    },
    advance(ms: number) {
      now += ms;
      for (const q of queue.filter((q) => q.at <= now)) {
        queue.splice(queue.indexOf(q), 1);
        q.fn();
      }
    },
  };
}

const ready = { status: "ready" as const };
const voicing = { status: "voicing" as const, progress: 0.5 };

test("phase: from the server, the player and what was done here", () => {
  assert.equal(phaseOf(null, IDLE_LOCAL, null, "a"), "idle");
  assert.equal(phaseOf(voicing, IDLE_LOCAL, null, "a"), "making");
  assert.equal(phaseOf(null, { ...IDLE_LOCAL, requesting: true }, null, "a"), "making");
  assert.equal(phaseOf({ status: "failed" }, IDLE_LOCAL, null, "a"), "failed");
  assert.equal(phaseOf(ready, IDLE_LOCAL, null, "a"), "ready");
  assert.equal(phaseOf(ready, IDLE_LOCAL, { itemId: "a", playing: true, at: 3, duration: 200 }, "a"), "playing");
  assert.equal(phaseOf(ready, IDLE_LOCAL, { itemId: "a", playing: false, at: 30, duration: 200 }, "a"), "paused");
  // Another piece's audio doesn't count.
  assert.equal(phaseOf(ready, IDLE_LOCAL, { itemId: "b", playing: true, at: 3, duration: 200 }, "a"), "ready");
  assert.equal(phaseOf(ready, { ...IDLE_LOCAL, finished: true }, { itemId: "a", playing: false, at: 200, duration: 200 }, "a"), "done");
  assert.equal(phaseOf(voicing, { ...IDLE_LOCAL, stopped: true }, null, "a"), "stopped");
});

test("the row: shows for an episode on the go, not for an old failure or once folded", () => {
  assert.equal(rowShows("idle", IDLE_LOCAL), false);
  assert.equal(rowShows("ready", IDLE_LOCAL), true);
  assert.equal(rowShows("failed", IDLE_LOCAL), false);
  assert.equal(rowShows("failed", { ...IDLE_LOCAL, started: true }), true);
  assert.equal(rowShows("ready", { ...IDLE_LOCAL, hidden: true }), false);
  assert.equal(rowShows("stopped", { ...IDLE_LOCAL, hidden: true }), true);
});

test("steps and the ring follow the worker, never backwards", () => {
  assert.deepEqual([stepOf(0), stepOf(0.249), stepOf(0.25), stepOf(0.94), stepOf(0.95), stepOf(1)], [0, 0, 1, 1, 2, 2]);
  assert.equal(ringTarget(0.4, { status: "voicing", progress: 0.3 }), 0.4);
  assert.equal(ringTarget(0.4, { status: "voicing", progress: 0.6 }), 0.6);
  assert.equal(ringTarget(0.4, { status: "ready", progress: 0.9 }), 1);
});

test("the stop confirm: Keep, five seconds, a scroll or a tap elsewhere all keep going", () => {
  const t = fakeTimers();
  const tasks = createEpisodeTasks(t);
  tasks.begin("a");
  tasks.askStop("a");
  assert.equal(tasks.get("a").confirm, true);
  tasks.keep("a");
  assert.equal(tasks.get("a").confirm, false);

  tasks.askStop("a");
  t.advance(CONFIRM_MS);
  assert.equal(tasks.get("a").confirm, false);

  tasks.askStop("a");
  tasks.dismiss({ scroll: true });
  assert.equal(tasks.get("a").confirm, true, "the scroll right after the tap doesn't count");
  t.advance(400);
  tasks.dismiss({ scroll: true });
  assert.equal(tasks.get("a").confirm, false);

  tasks.askStop("a");
  tasks.dismiss();
  assert.equal(tasks.anyConfirm(), false);
});

test("Stop: Stopped for a moment, then the row folds; asking again brings it back", () => {
  const t = fakeTimers();
  const tasks = createEpisodeTasks(t);
  tasks.begin("a");
  tasks.requested("a", true);
  tasks.askStop("a");
  tasks.stop("a");
  assert.equal(phaseOf(voicing, tasks.get("a"), null, "a"), "stopped");
  t.advance(STOPPED_MS);
  // The server no longer has it.
  assert.equal(phaseOf(null, tasks.get("a"), null, "a"), "idle");
  assert.equal(rowShows("idle", tasks.get("a")), false);
  // The confirm's own timer was replaced, so it can't fire later.
  t.advance(CONFIRM_MS);
  assert.equal(tasks.get("a").hidden, true);
  tasks.begin("a");
  assert.equal(rowShows(phaseOf(null, tasks.get("a"), null, "a"), tasks.get("a")), true);
});

test("Listened: a few seconds, then the row folds; playing again brings it back", () => {
  const t = fakeTimers();
  const tasks = createEpisodeTasks(t);
  tasks.finish("a");
  tasks.finish("a");
  t.advance(DONE_MS);
  assert.deepEqual([tasks.get("a").finished, tasks.get("a").hidden], [false, true]);
  tasks.show("a");
  assert.equal(tasks.get("a").hidden, false);
});


test("time left: ~1 min early on, then elapsed × (1 − p) / p, counting down in 5s steps", () => {
  const e = newEta();
  assert.equal(tickEta(e, 1000, 0.2, rawSecondsLeft(0.2, 10, 1000, 1000)), ETA_EARLY);
  // 40% after 20s: 30s left.
  let now = 2000;
  assert.equal(tickEta(e, now, 0.4, rawSecondsLeft(0.4, 20, now, now)), "~30s left");
  // It counts down with the clock between samples.
  const sampled = now;
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    now += 250;
    seen.add(tickEta(e, now, 0.4, rawSecondsLeft(0.4, 20, sampled, now)));
  }
  assert.ok(seen.has("~25s left") && seen.has("~20s left"), [...seen].join(", "));
  assert.equal([...seen].at(-1), "~20s left");
  // A stall (the raw figure jumps up a little) doesn't make it flicker back up.
  assert.equal(tickEta(e, now + 250, 0.4, 22), "~20s left");
  // Near the end.
  for (let i = 0; i < 80; i++) tickEta(e, (now += 250), 0.9, 1);
  assert.equal(tickEta(e, (now += 250), 0.9, 1), "Almost done");
});

test("time left: above a minute it reads in minutes", () => {
  const e = newEta();
  assert.equal(tickEta(e, 1000, 0.3, rawSecondsLeft(0.3, 60, 1000, 1000)), "~2 min left");
});
