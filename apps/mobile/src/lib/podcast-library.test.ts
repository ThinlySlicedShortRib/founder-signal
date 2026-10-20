// Run with `pnpm --filter @fs/mobile test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPodcastLibrary, groupOf, type LibraryStorage, resumeAt, rowMeta, SAVE_EVERY_MS, snapshotGroups } from "./podcast-library.ts";

const meta = (itemId: string, title = `Piece ${itemId}`) => ({
  itemId,
  title,
  home: { kind: "letter" as const, letterId: "L14", today: true, page: 2 },
  author: "Maya Okafor",
  letterNumber: 14,
  position: 2,
});

function setup() {
  let now = 1000;
  const saved: string[] = [];
  const storage: LibraryStorage = { load: () => saved.at(-1) ?? null, save: (j) => void saved.push(j) };
  const lib = createPodcastLibrary(() => now);
  lib.open(storage);
  return { lib, saved, storage, tick: (ms: number) => (now += ms) };
}

test("asked for or played: on the list once, newest first, kept in storage", () => {
  const { lib, saved, tick } = setup();
  lib.remember(meta("a"));
  tick(10);
  lib.remember(meta("b"));
  tick(10);
  lib.remember(meta("a", "Renamed"));
  assert.deepEqual(
    lib.entries().map((e) => [e.itemId, e.title]),
    [
      ["b", "Piece b"],
      ["a", "Renamed"],
    ],
  );
  const again = createPodcastLibrary();
  again.open({ load: () => saved.at(-1)!, save: () => {} });
  assert.deepEqual(
    again.entries().map((e) => e.itemId),
    ["b", "a"],
  );
});

test("groups: new, in progress, listened; and the snapshot doesn't move while the tab is open", () => {
  const { lib } = setup();
  lib.remember(meta("a"));
  assert.equal(groupOf(lib.get("a")!), "new");
  const snap = snapshotGroups(lib.entries());
  lib.progress("a", 30, 240, false);
  assert.equal(groupOf(lib.get("a")!), "progress");
  assert.equal(snap.a, "new");
  lib.finished("a");
  assert.equal(groupOf(lib.get("a")!), "done");
});

test("the position is written when it pauses, and at most every few seconds while playing", () => {
  const { lib, saved, tick } = setup();
  lib.remember(meta("a"));
  const writes = saved.length;
  let heard = 0;
  lib.subscribe(() => heard++);
  tick(SAVE_EVERY_MS);
  lib.progress("a", 10, 240, true);
  assert.equal(saved.length, writes + 1);
  tick(1000);
  lib.progress("a", 11, 240, true);
  assert.equal(saved.length, writes + 1, "too soon to write again");
  assert.equal(heard, 1);
  lib.progress("a", 12, 240, false);
  assert.equal(saved.length, writes + 2, "paused: written at once");
  assert.equal(lib.get("a")!.at, 12);
});

test("listened stays listened while the player sits at the end, and clears when it's started again", () => {
  const { lib } = setup();
  lib.remember(meta("a"));
  lib.progress("a", 239.9, 240, false);
  lib.finished("a");
  lib.progress("a", 240, 240, false);
  assert.equal(lib.get("a")!.listened, true);
  lib.progress("a", 5, 240, true);
  assert.equal(lib.get("a")!.listened, false);
  assert.equal(groupOf(lib.get("a")!), "progress");
});

test("resume from the saved spot, but not when listened, unstarted or at the end", () => {
  assert.equal(resumeAt({ at: 130, duration: 260, listened: false }), 130);
  assert.equal(resumeAt({ at: 130, duration: 260, listened: true }), 0);
  assert.equal(resumeAt({ at: 0.5, duration: 260, listened: false }), 0);
  assert.equal(resumeAt({ at: 259, duration: 260, listened: false }), 0);
  assert.equal(resumeAt(null), 0);
});

test("stopped while being made: it leaves the list", () => {
  const { lib } = setup();
  lib.remember(meta("a"));
  lib.forget("a");
  assert.equal(lib.entries().length, 0);
});

test("a reader describing a piece updates its row, but never adds one", () => {
  const { lib } = setup();
  lib.describe(meta("x"));
  assert.equal(lib.entries().length, 0);
  lib.remember({ itemId: "a", title: "Untitled piece", home: { kind: "item" } });
  lib.describe(meta("a", "The real title"));
  assert.equal(lib.get("a")!.title, "The real title");
  assert.equal(rowMeta(lib.get("a")!), "Maya Okafor · No. 14 · Piece 2");
});

test("an unreadable file starts an empty list", () => {
  const lib = createPodcastLibrary();
  lib.open({ load: () => "{not json", save: () => {} });
  assert.deepEqual(lib.entries(), []);
});
