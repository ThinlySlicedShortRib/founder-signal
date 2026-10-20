// Run with `pnpm --filter @fs/mobile test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPillStore, GRACE_MS, type PillEntry } from "./pill-store.ts";

function fakeTimers() {
  let now = 0;
  const queue: { at: number; fn: () => void; id: number }[] = [];
  let next = 0;
  return {
    set: (fn: () => void, ms: number) => {
      const id = ++next;
      queue.push({ at: now + ms, fn, id });
      return id;
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

const e = (mode: string, extra: Partial<PillEntry> = {}): PillEntry => ({ mode, label: mode, node: mode, hidden: false, z: 20, ...extra });

test("the newest claim wins, and the one it replaces fades out", () => {
  const s = createPillStore(fakeTimers());
  s.set("pager", e("pager"));
  const first = s.getSnapshot().current!;
  assert.equal(first.mode, "pager");
  s.set("reader", e("reading"));
  const snap = s.getSnapshot();
  assert.equal(snap.current!.mode, "reading");
  assert.deepEqual(
    snap.exiting.map((l) => l.id),
    [first.id],
  );
  // The pager re-rendering doesn't take it back: only a new slot or a new mode claims.
  s.set("pager", e("pager", { label: "No. 3 · 3 / 5" }));
  assert.equal(s.getSnapshot().current!.mode, "reading");
});

test("updates within a mode keep the layer; a new mode is a new layer", () => {
  const s = createPillStore(fakeTimers());
  s.set("reader", e("reading", { node: "5 min left" }));
  const id = s.getSnapshot().current!.id;
  s.set("reader", e("reading", { node: "4 min left" }));
  assert.equal(s.getSnapshot().current!.id, id);
  assert.equal(s.getSnapshot().current!.node, "4 min left");
  assert.equal(s.getSnapshot().exiting.length, 0);
  s.set("reader", e("verdict"));
  assert.notEqual(s.getSnapshot().current!.id, id);
  assert.equal(s.getSnapshot().exiting[0]!.node, "4 min left");
});

test("a handover across renders morphs straight across (grace period)", () => {
  const t = fakeTimers();
  const s = createPillStore(t);
  s.set("reader", e("reading"));
  const reading = s.getSnapshot().current!;
  s.release("reader");
  assert.equal(s.getSnapshot().current!.id, reading.id);
  assert.equal(s.getSnapshot().current!.orphan, true);
  t.advance(GRACE_MS / 2);
  s.set("pager", e("pager"));
  const snap = s.getSnapshot();
  assert.equal(snap.current!.mode, "pager");
  assert.deepEqual(
    snap.exiting.map((l) => l.id),
    [reading.id],
  );
  t.advance(GRACE_MS * 2);
  assert.equal(s.getSnapshot().current!.mode, "pager");
});

test("with no claim after the grace period the pill empties", () => {
  const t = fakeTimers();
  const s = createPillStore(t);
  s.set("a", e("pager"));
  s.release("a");
  t.advance(GRACE_MS + 1);
  assert.equal(s.getSnapshot().current, null);
  assert.equal(s.getSnapshot().exiting.length, 1);
});

test("unmount and remount of the same slot (StrictMode) is not a change", () => {
  const t = fakeTimers();
  const s = createPillStore(t);
  s.set("a", e("pager"));
  const id = s.getSnapshot().current!.id;
  s.release("a");
  s.set("a", e("pager"));
  t.advance(GRACE_MS * 2);
  assert.equal(s.getSnapshot().current!.id, id);
  assert.equal(s.getSnapshot().current!.orphan, false);
  assert.equal(s.getSnapshot().exiting.length, 0);
});

test("flipping back while the old layer is still fading revives it", () => {
  const s = createPillStore(fakeTimers());
  s.set("reader", e("reading"));
  const reading = s.getSnapshot().current!.id;
  s.set("menu", e("menu"));
  const menu = s.getSnapshot().current!.id;
  s.release("menu");
  const snap = s.getSnapshot();
  assert.equal(snap.current!.id, reading);
  assert.deepEqual(
    snap.exiting.map((l) => l.id),
    [menu],
  );
  s.drop(menu);
  assert.equal(s.getSnapshot().exiting.length, 0);
  // Dropping the current layer by mistake does nothing.
  s.drop(reading);
  assert.equal(s.getSnapshot().current!.id, reading);
});

test("hidden keeps the layer", () => {
  const s = createPillStore(fakeTimers());
  s.set("reader", e("verdict"));
  const id = s.getSnapshot().current!.id;
  s.set("reader", e("verdict", { hidden: true }));
  assert.equal(s.getSnapshot().current!.id, id);
  assert.equal(s.getSnapshot().current!.hidden, true);
});

test("the status row is claimed on its own, survives mode changes, and folds after a grace period", () => {
  const timers = fakeTimers();
  const store = createPillStore(timers);
  store.set("pager", e("pager"));
  store.setStatus("reader", "making");
  assert.equal(store.getSnapshot().status, "making");
  // The controls morph; the status stays.
  store.set("reader", e("reading"));
  assert.equal(store.getSnapshot().current?.mode, "reading");
  assert.equal(store.getSnapshot().status, "making");
  store.setStatus("reader", "ready");
  assert.equal(store.getSnapshot().status, "ready");

  // Let go and claimed again inside the grace period (a handover): no fold.
  store.releaseStatus("reader");
  assert.equal(store.getSnapshot().status, "ready");
  store.setStatus("reader2", "playing");
  timers.advance(GRACE_MS);
  assert.equal(store.getSnapshot().status, "playing");

  // Nothing to show: it folds once the grace period is up.
  store.setStatus("reader2", null);
  assert.equal(store.getSnapshot().status, "playing");
  timers.advance(GRACE_MS);
  assert.equal(store.getSnapshot().status, null);
  assert.equal(store.getSnapshot().current?.mode, "reading");
});
