import type { AuthorCard, DislikeReason, Interaction, LetterPiece, LetterView, LikeReason, SectionSummary } from "@fs/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { ApiError, api, unwrap } from "./api";
import { reportError } from "./error-reporting";
import { localDay, uuid } from "./format";
import { kvGet, kvSet } from "./kv";

/**
 * Letters, the reader and reading events (build plan §6–7, Layout 6).
 *
 * The user's state for each piece (saved, verdict, skipped, completed), the
 * authors they follow and their P.S. choices are kept in a small local store
 * as well as sent to the API, and laid over whatever the server returns. That
 * keeps every tap instant, and keeps it right when a refetch races a write.
 */

export const LETTER_KEYS = {
  today: ["letters", "today"] as const,
  list: ["letters", "list"] as const,
  one: (id: string) => ["letters", id] as const,
  item: (id: string) => ["items", id] as const,
  saved: ["me", "saved"] as const,
  activity: (month: string) => ["me", "activity", month] as const,
};

// ── Local state laid over the server's ───────────────────────────────────────

type PieceState = Partial<Pick<LetterPiece, "saved" | "verdict" | "skipped" | "completed">>;

const local = {
  pieces: new Map<string, PieceState>(),
  follows: new Map<string, boolean>(),
  leanings: new Map<string, string[]>(),
  version: 0,
};
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
function changed() {
  local.version++;
  for (const fn of listeners) fn();
}

export function setPieceState(itemId: string, patch: PieceState) {
  local.pieces.set(itemId, { ...local.pieces.get(itemId), ...patch });
  changed();
}

/** Re-renders when any local reading state changes. */
export function useLocalVersion(): number {
  return useSyncExternalStore(subscribe, () => local.version, () => local.version);
}

export function pieceWithLocal(p: LetterPiece): LetterPiece {
  const s = local.pieces.get(p.itemId);
  const following = p.author ? local.follows.get(p.author.key) : undefined;
  return {
    ...p,
    ...s,
    author: p.author && following !== undefined ? { ...p.author, following } : p.author,
  };
}

export function authorWithLocal(a: AuthorCard): AuthorCard {
  const following = local.follows.get(a.key);
  return following === undefined ? a : { ...a, following };
}

export function letterWithLocal(l: LetterView): LetterView {
  const chosen = local.leanings.get(l.id);
  return {
    ...l,
    pieces: l.pieces.map(pieceWithLocal),
    postscript: chosen ? { ...l.postscript, chosenLeanings: chosen } : l.postscript,
  };
}

/** A piece's state, wherever it was opened from (letter or library). */
export function usePieceState(itemId: string, base?: PieceState): PieceState {
  useLocalVersion();
  return { ...base, ...local.pieces.get(itemId) };
}

// ── Letters ──────────────────────────────────────────────────────────────────

export function useTodayLetter({ poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: LETTER_KEYS.today,
    queryFn: async () => (await unwrap(api.letters.today.$get())).letter,
    // Polls (after asking for a test letter) until a letter shows up.
    refetchInterval: (q) => (poll && !q.state.data ? 3_000 : false),
  });
}

export function useLetter(id: string) {
  return useQuery({
    queryKey: LETTER_KEYS.one(id),
    queryFn: async () => (await unwrap(api.letters[":id"].$get({ param: { id } }))).letter,
  });
}

export function useLetters({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: LETTER_KEYS.list,
    queryFn: async () => {
      const body = await unwrap(api.letters.$get({ query: {} }));
      // The route's validator has no error hook, so its type also includes zod's error body.
      if (!("letters" in body)) throw new ApiError("VALIDATION_FAILED", "Couldn't load your letters", 400);
      return body.letters;
    },
    enabled,
  });
}

/** "Send me a test letter": the API queues one now; Today polls until it's delivered. */
export function useTestLetter() {
  return useMutation({
    mutationFn: async () => await unwrap(api.me.schedule["test-letter"].$post()),
  });
}

export function useSetLeanings(letterId: string) {
  return useMutation({
    mutationFn: async (chosen: string[]) => {
      local.leanings.set(letterId, chosen);
      changed();
      return (await unwrap(api.letters[":id"].leanings.$put({ param: { id: letterId }, json: { chosen } }))).postscript;
    },
  });
}

/** The page of a letter the user was last on, so Today opens where they left off. */
export const lastPage = {
  get: async (letterId: string) => {
    const v = await kvGet(`fs.letter.${letterId}.page`);
    return v === null ? null : Number(v);
  },
  set: (letterId: string, page: number) => void kvSet(`fs.letter.${letterId}.page`, String(page)),
};

// ── Reader ───────────────────────────────────────────────────────────────────

export function useItem(id: string) {
  return useQuery({
    queryKey: LETTER_KEYS.item(id),
    queryFn: async () => (await unwrap(api.items[":id"].$get({ param: { id } }))).item,
    staleTime: 5 * 60_000,
  });
}

export function useSectionSummary(itemId: string) {
  return useMutation({
    mutationFn: async (sectionId: string): Promise<SectionSummary> =>
      (await unwrap(api.items[":id"].summary.$post({ param: { id: itemId }, json: { sectionId } }))).summary,
  });
}

export function useFollowAuthor() {
  return useMutation({
    mutationFn: async ({ key, following }: { key: string; following: boolean }) => {
      local.follows.set(key, following);
      changed();
      return unwrap(api.me.authors[":key"].follow.$put({ param: { key: encodeURIComponent(key) }, json: { following } }));
    },
    onError: (_e, { key, following }) => {
      local.follows.set(key, !following);
      changed();
    },
  });
}

export function useSaved({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: LETTER_KEYS.saved,
    queryFn: async () => (await unwrap(api.me.saved.$get())).saved,
    enabled,
  });
}

export function useActivity(month: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: LETTER_KEYS.activity(month),
    queryFn: async () => {
      const body = await unwrap(api.me.activity.$get({ query: { month } }));
      if (!("activity" in body)) throw new ApiError("VALIDATION_FAILED", "Couldn't load your activity", 400);
      return body.activity;
    },
    enabled,
  });
}

// ── Reading events (§6.6) ────────────────────────────────────────────────────

type EventType = Interaction["type"];

let queue: Interaction[] = [];
let flushing = false;

async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  const batch = queue.slice(0, 100);
  try {
    await unwrap(api.events.$post({ json: { events: batch } }));
    queue = queue.slice(batch.length);
  } catch (err) {
    // Kept for the next event; the server ignores duplicate IDs.
    if ((err as ApiError).code !== "OFFLINE") reportError(err, { context: "events" });
    if ((err as ApiError).status === 400) queue = queue.slice(batch.length);
  } finally {
    flushing = false;
  }
}

/** Records a reading event with a client UUID and the device's local day. Fire and forget. */
export function track(type: EventType, itemId: string, letterId: string | null) {
  const now = new Date();
  queue.push({ eventId: uuid(), type, itemId, letterId, occurredAt: now.toISOString(), localDay: localDay(now) });
  void flush();
}

/** Save or unsave a piece: local state at once, then the event. */
export function useToggleSave() {
  const qc = useQueryClient();
  return (itemId: string, letterId: string | null, saved: boolean) => {
    setPieceState(itemId, { saved });
    track(saved ? "save" : "unsave", itemId, letterId);
    setTimeout(() => void qc.invalidateQueries({ queryKey: LETTER_KEYS.saved }), 800);
  };
}

// ── Labels ───────────────────────────────────────────────────────────────────

export const LIKE_LABELS: Record<LikeReason, string> = {
  topic: "The topic",
  creator: "Who made it",
  practical: "Practical, I can use it",
  numbers: "Real numbers",
  depth: "Depth",
  concise: "Short and to the point",
  fresh_take: "A fresh take",
  video: "I like videos",
};

export const DISLIKE_LABELS: Record<DislikeReason, string> = {
  not_my_topic: "Not my topic",
  too_basic: "Too basic",
  too_long: "Too long",
  already_knew: "Already knew it",
  not_credible: "Not credible",
  too_promotional: "Too promotional",
};
