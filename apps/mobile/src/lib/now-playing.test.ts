// Run with `pnpm --filter @fs/mobile test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEpisodeTasks, DONE_MS, type PlayState, STOPPED_MS } from "./episode-task.ts";
import { createNowPlaying, lockSubtitle, type NowPlayingMeta, rowOf } from "./now-playing.ts";

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
const meta = (itemId: string, page = 2): NowPlayingMeta => ({
  itemId,
  title: `Piece ${itemId}`,
  home: { kind: "letter", letterId: "L13", today: false, page },
  subtitle: lockSubtitle(13, page - 1, null),
  artworkUrl: null,
});

/** The app as far as the row cares: the store, the tasks, and the one player. */
function app() {
  const timers = fakeTimers();
  const np = createNowPlaying();
  const tasks = createEpisodeTasks(timers);
  let play: PlayState = { itemId: null, playing: false, at: 0, duration: 0 };
  let emits = 0;
  np.subscribe(() => emits++);
  return {
    np,
    tasks,
    timers,
    emits: () => emits,
    /** Play pressed on a piece's episode (as `toggle` in listen.ts does). */
    start(id: string) {
      tasks.show(id);
      np.loaded(id);
      play = { itemId: id, playing: true, at: 0, duration: 240 };
      return np.claim(id);
    },
    pause() {
      play = { ...play, playing: false, at: 72 };
    },
    resume() {
      play = { ...play, playing: true };
    },
    /** The player reports the end (didJustFinish). */
    end() {
      play = { ...play, playing: false, at: 240 };
      tasks.finish(play.itemId!);
    },
    row() {
      const s = np.subject();
      return rowOf(s, ready, tasks.get(s ?? ""), play);
    },
    /** What the row component does when it sees its subject's row closed. */
    settle() {
      const r = this.row();
      if (r && !r.open) np.folded(r.itemId);
    },
  };
}

test("nothing playing: no row", () => {
  const a = app();
  assert.equal(a.np.subject(), null);
  assert.equal(a.row(), null);
});

test("start: the episode takes the row, playing, from any screen", () => {
  const a = app();
  a.np.describe(meta("a"));
  assert.equal(a.start("a"), null, "the row was empty, so nothing was replaced");
  assert.deepEqual(a.row(), { itemId: "a", phase: "playing", open: true });
  assert.equal(a.np.meta(a.np.subject())?.title, "Piece a");
  // Starting the same one again (play after pause) isn't a replacement.
  assert.equal(a.np.claim("a"), null);
});

test("pause: the row stays, showing paused, and keeps the episode", () => {
  const a = app();
  a.start("a");
  a.pause();
  assert.deepEqual(a.row(), { itemId: "a", phase: "paused", open: true });
  a.timers.advance(60_000);
  a.settle();
  assert.equal(a.np.subject(), "a", "a paused episode never lets go of the row");
  a.resume();
  assert.equal(a.row()?.phase, "playing");
});

test("replace: another episode starting swaps the row in place (no fold)", () => {
  const a = app();
  a.start("a");
  const before = a.emits();
  assert.equal(a.start("b"), "a", "the row was open with a: it crossfades to b");
  assert.equal(a.emits(), before + 1, "one change, straight from a to b");
  assert.deepEqual(a.row(), { itemId: "b", phase: "playing", open: true });
  // a is just a ready episode again (its own card shows that); it doesn't come back to the row.
  a.settle();
  assert.equal(a.np.subject(), "b");
});

test("end: Listened, held for DONE_MS, then the row folds and lets go", () => {
  const a = app();
  a.start("a");
  a.end();
  assert.deepEqual(a.row(), { itemId: "a", phase: "done", open: true });
  a.timers.advance(DONE_MS - 1);
  a.settle();
  assert.equal(a.row()?.open, true, "still saying Listened");
  a.timers.advance(1);
  assert.equal(a.row()?.open, false, "folding");
  a.settle();
  assert.equal(a.np.subject(), null, "gone: no row anywhere");
  assert.equal(a.row(), null);
  // Playing it again brings the row back.
  a.start("a");
  assert.deepEqual(a.row(), { itemId: "a", phase: "playing", open: true });
});

test("DONE_MS is the mock's ~2.6s hold", () => {
  assert.equal(DONE_MS, 2600);
});

test("making elsewhere takes the row; once stopped and folded, the row falls back to the episode still playing", () => {
  const a = app();
  a.start("a");
  // b is asked for (making); it takes the row while a keeps playing.
  a.tasks.begin("b");
  assert.equal(a.np.claim("b"), "a");
  assert.equal(rowOf("b", { status: "voicing" }, a.tasks.get("b"), null)?.phase, "making");
  // Stop b: "Stopped", then its row folds, and the row goes back to a (in place, still playing).
  a.tasks.stop("b");
  a.timers.advance(STOPPED_MS);
  const b = rowOf("b", null, a.tasks.get("b"), null);
  assert.equal(b?.open, false);
  a.np.folded("b");
  assert.equal(a.np.subject(), "a");
  assert.deepEqual(a.row(), { itemId: "a", phase: "playing", open: true });
});

test("folded is ignored for anything but the subject", () => {
  const a = app();
  a.start("a");
  a.start("b");
  a.np.folded("a");
  assert.equal(a.np.subject(), "b");
});

test("describe: only a change to the subject's details is news", () => {
  const a = app();
  a.start("a");
  const n = a.emits();
  a.np.describe(meta("z"));
  a.np.describe(meta("a"));
  a.np.describe(meta("a"));
  assert.equal(a.emits(), n + 1);
});

test("lock screen subtitle", () => {
  assert.equal(lockSubtitle(14, 2, "Pipeline Weekly"), "Founder Signal · No. 14 · Piece 2");
  assert.equal(lockSubtitle(null, null, "Pipeline Weekly"), "Founder Signal · Pipeline Weekly");
  assert.equal(lockSubtitle(null, null, null), "Founder Signal");
});
