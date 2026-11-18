// Run with `pnpm --filter @fs/mobile test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNowPlaying, lockSubtitle, type NowPlayingMeta, type TrackedEpisode, WATCH_NEW, watchList } from "./now-playing.ts";

const meta = (itemId: string, page = 2): NowPlayingMeta => ({
  itemId,
  title: `Piece ${itemId}`,
  home: { kind: "letter", letterId: "L13", today: false, page },
  subtitle: lockSubtitle(13, page - 1, null),
  artworkUrl: null,
});

/** A watcher's report: ready and unplayed unless the patch says otherwise. */
const ep = (itemId: string, patch: Partial<TrackedEpisode> = {}): TrackedEpisode => ({
  itemId,
  phase: "ready",
  open: true,
  progress: 1,
  unplayed: true,
  addedAt: 0,
  ...patch,
});

/** The store with a clock, and the two things the app does around it: play an episode, and report on it. */
function app() {
  let now = 1000;
  const np = createNowPlaying(() => now);
  let emits = 0;
  np.subscribe(() => emits++);
  return {
    np,
    emits: () => emits,
    tick: (ms: number) => (now += ms),
    /** What playItem in listen.ts does: load it, it's played, and its watcher says it's playing. */
    play(id: string) {
      np.loaded(id);
      np.played(id);
      np.report(ep(id, { phase: "playing", unplayed: false }));
    },
    /** B is asked for here and its watcher sees it being made. */
    make(id: string, progress: number, addedAt = 0) {
      np.ask(id);
      np.report(ep(id, { phase: "making", progress, addedAt }));
    },
    view: (playbackOnly = false) => np.view(playbackOnly),
  };
}

// ── The row ──────────────────────────────────────────────────────────────────

test("nothing tracked: no row, empty panel, plain handle", () => {
  const v = app().view();
  assert.deepEqual(v, { now: null, row: null, top: null, upNext: [], ready: [], making: [], hint: { kind: "none", progress: 0 } });
});

test("the row is only ever what's playing, whatever else is being made", () => {
  const a = app();
  a.play("A");
  a.make("B", 0.4);
  const v = a.view();
  assert.equal(v.row, "A");
  assert.equal(v.now, "A");
  assert.equal(v.top, "A");
  assert.deepEqual(v.making, ["B"]);
});

test("just loaded, before its watcher reports or the player says it's playing, it's already the row", () => {
  const a = app();
  a.make("B", 0.4);
  a.np.loaded("A");
  assert.equal(a.view().row, "A");
  a.np.report(ep("A")); // ready: loaded, not playing yet
  assert.equal(a.view().row, "A");
});

test("nothing playing, one being made: the row shows it, and the handle stays plain (it's already in the row)", () => {
  const a = app();
  a.make("B", 0.6);
  const v = a.view();
  assert.equal(v.row, "B");
  assert.equal(v.now, null);
  assert.equal(v.top, null, "Now playing only shows an episode you can play");
  assert.deepEqual(v.hint, { kind: "none", progress: 0 });
});

test("A ends with nothing in Up next: once its row folds, the row shows B ready to play", () => {
  const a = app();
  a.play("A");
  a.make("B", 0.5);
  a.np.report(ep("B")); // ready
  a.np.report(ep("A", { phase: "done", unplayed: false })); // Listened, for a moment
  assert.equal(a.view().row, "A");
  assert.equal(a.np.advance(), null, "nothing was queued, so nothing starts");
  a.np.report(ep("A", { phase: "ready", unplayed: false, open: false })); // its row folded
  const v = a.view();
  assert.equal(v.row, "B");
  assert.equal(v.top, "B", "the panel's Now playing offers it");
  assert.deepEqual(v.ready, [], "and it isn't listed twice");
  assert.deepEqual(v.hint, { kind: "none", progress: 0 }, "the handle goes plain again");
});

test("ready ones from another session never take the row; only ones asked for here do", () => {
  const a = app();
  a.np.report(ep("old", { addedAt: 1 }));
  assert.equal(a.view().row, null);
  assert.deepEqual(a.view().ready, ["old"]);
});

test("the Podcasts tab: the row is for playback only", () => {
  const a = app();
  a.make("B", 0.6);
  assert.equal(a.view(true).row, null);
  a.play("A");
  assert.equal(a.view(true).row, "A");
  assert.deepEqual(a.view(true).hint, { kind: "none", progress: 0 });
});

// ── The handle ───────────────────────────────────────────────────────────────

test("handle: fills with the progress of the episode closest to done, never the row's", () => {
  const a = app();
  a.play("A");
  a.make("B", 0.3, 1);
  a.make("C", 0.7, 2);
  a.make("D", 0.1, 3);
  assert.deepEqual(a.view().hint, { kind: "making", progress: 0.7 });
  assert.deepEqual(a.view().making, ["C", "B", "D"], "Making is ordered by how soon you'll hear it");
  a.np.report(ep("B", { phase: "making", progress: 0.9, addedAt: 1 }));
  assert.deepEqual(a.view().hint, { kind: "making", progress: 0.9 });
  assert.deepEqual(a.view().making, ["B", "C", "D"]);
});

test("handle: turns blue when one becomes ready while you listen, until the panel opens", () => {
  const a = app();
  a.play("A");
  a.make("B", 0.95);
  a.make("C", 0.2);
  a.np.report(ep("B"));
  assert.deepEqual(a.view().hint, { kind: "ready", progress: 0.2 }, "ready wins over making; the fill still follows C");
  assert.deepEqual(a.view().ready, ["B"]);
  assert.deepEqual(a.view().making, ["C"]);
  a.np.sawPanel();
  assert.deepEqual(a.view().hint, { kind: "making", progress: 0.2 });
});

test("handle: an episode that was already ready (not seen becoming ready) doesn't call out", () => {
  const a = app();
  a.play("A");
  a.np.report(ep("old"));
  assert.deepEqual(a.view().hint, { kind: "none", progress: 0 });
});

test("handle: playing the ready one clears it", () => {
  const a = app();
  a.play("A");
  a.make("B", 0.9);
  a.np.report(ep("B"));
  a.play("B");
  assert.deepEqual(a.view().hint, { kind: "none", progress: 0 });
});

test("handle: becoming ready again (made again) calls out again after it was seen", () => {
  const a = app();
  a.play("A");
  a.make("B", 0.9);
  a.np.report(ep("B"));
  a.np.sawPanel();
  a.make("B", 0.1);
  a.np.report(ep("B"));
  assert.equal(a.view().hint.kind, "ready");
});

// ── Up next ──────────────────────────────────────────────────────────────────

test("Play after this: to the end of Up next, in order, once, never the one playing", () => {
  const a = app();
  a.play("A");
  for (const id of ["B", "C", "D"]) a.np.report(ep(id));
  a.np.playAfter("C");
  a.np.playAfter("B");
  a.np.playAfter("C");
  a.np.playAfter("A");
  const v = a.view();
  assert.deepEqual(v.upNext, ["C", "B"]);
  assert.deepEqual(v.ready, ["D"], "queued ones leave Ready");
});

test("✕ on Up next: back to Ready, and the rest keep their order", () => {
  const a = app();
  a.play("A");
  for (const id of ["B", "C", "D"]) a.np.report(ep(id));
  for (const id of ["B", "C", "D"]) a.np.playAfter(id);
  a.np.unqueue("C");
  assert.deepEqual(a.view().upNext, ["B", "D"]);
  assert.deepEqual(a.view().ready, ["C"]);
});

test("auto-advance: when A ends, the first of Up next is taken off it to play", () => {
  const a = app();
  a.play("A");
  for (const id of ["B", "C"]) a.np.report(ep(id));
  a.np.playAfter("B");
  a.np.playAfter("C");
  assert.equal(a.np.advance(), "B");
  assert.deepEqual(a.np.queue(), ["C"]);
  a.play("B");
  assert.equal(a.view().row, "B");
  assert.deepEqual(a.view().upNext, ["C"]);
  assert.equal(a.np.advance(), "C");
  assert.equal(a.np.advance(), null, "then nothing more");
});

test("auto-advance skips one that's gone or failed since it was queued", () => {
  const a = app();
  a.play("A");
  for (const id of ["B", "C"]) a.np.report(ep(id));
  a.np.playAfter("B");
  a.np.playAfter("C");
  a.np.report(ep("B", { phase: "failed" }));
  assert.deepEqual(a.view().upNext, ["C"]);
  assert.equal(a.np.advance(), "C");
});

// ── Play now ─────────────────────────────────────────────────────────────────

test("Play now replaces what's playing; the old one keeps its place in Podcasts, not in Ready", () => {
  const a = app();
  a.play("A");
  a.make("B", 0.9);
  a.np.report(ep("B"));
  a.play("B");
  a.np.report(ep("A", { phase: "ready", unplayed: false }));
  const v = a.view();
  assert.equal(v.row, "B");
  assert.equal(v.top, "B");
  assert.deepEqual(v.ready, []);
  assert.equal(a.np.playerItem(), "B");
});

test("Play now on a queued one takes it off Up next", () => {
  const a = app();
  a.play("A");
  for (const id of ["B", "C"]) a.np.report(ep(id));
  a.np.playAfter("B");
  a.np.playAfter("C");
  a.play("C");
  assert.deepEqual(a.view().upNext, ["B"]);
  assert.equal(a.view().row, "C");
});

test("Ready: newest made first, then newest added", () => {
  const a = app();
  a.play("A");
  a.np.report(ep("old1", { addedAt: 1 }));
  a.np.report(ep("old2", { addedAt: 2 }));
  a.make("B", 0.5);
  a.tick(10);
  a.np.report(ep("B"));
  assert.deepEqual(a.view().ready, ["B", "old2", "old1"]);
});

// ── Bookkeeping ──────────────────────────────────────────────────────────────

test("views are the same object until something changes, and unchanged reports aren't news", () => {
  const a = app();
  a.play("A");
  const v = a.view();
  assert.equal(a.view(), v);
  const n = a.emits();
  a.np.report(ep("A", { phase: "playing", unplayed: false }));
  assert.equal(a.emits(), n);
  assert.equal(a.view(), v);
  a.np.describe(meta("A"));
  assert.notEqual(a.view(), v);
  assert.equal(a.np.meta("A")?.title, "Piece A");
});

test("untrack: it leaves the panel", () => {
  const a = app();
  a.np.report(ep("B"));
  a.np.untrack("B");
  assert.deepEqual(a.view().ready, []);
});

test("watched: the player, asked, Up next, and the newest New ones from Podcasts", () => {
  const lib = [
    { itemId: "n1", at: 0, listened: false },
    { itemId: "part", at: 80, listened: false },
    { itemId: "done", at: 0, listened: true },
    { itemId: "n2", at: 0.4, listened: false },
  ];
  assert.deepEqual(watchList({ player: "A", asked: ["B"], queue: ["C", "A"] }, lib), ["A", "B", "C", "n1", "n2"]);
  const many = Array.from({ length: WATCH_NEW + 5 }, (_, i) => ({ itemId: `e${i}`, at: 0, listened: false }));
  assert.equal(watchList({ player: null, asked: [], queue: [] }, many).length, WATCH_NEW);
});

test("lock screen subtitle", () => {
  assert.equal(lockSubtitle(14, 2, "Ignored"), "Founder Signal · No. 14 · Piece 2");
  assert.equal(lockSubtitle(null, null, "Stratechery"), "Founder Signal · Stratechery");
  assert.equal(lockSubtitle(null, null, null), "Founder Signal");
});
