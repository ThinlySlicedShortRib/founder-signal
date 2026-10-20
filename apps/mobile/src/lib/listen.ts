import type { EpisodeView } from "@fs/schema";
import { useQueryClient } from "@tanstack/react-query";
import { type AudioPlayer, type AudioStatus, createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { GestureResponderEvent } from "react-native";
import { createEpisodeTasks, ETA_DONE, ETA_EARLY, type Eta, isBusy, minutesLabel, newEta, type Phase, phaseOf, type PlayState, rawSecondsLeft, rowShows, tickEta } from "./episode-task";
import { createNowPlaying, type NowPlayingMeta } from "./now-playing";
import { cancelEpisode, episodeAudioUrl, episodeKey, type EpisodeResponse, requestEpisode, useEpisode } from "./podcast";

/**
 * The one source of truth for Listen episodes: everything that shows a
 * piece's episode (the pill's status row, the Listen card in the article, the
 * cover's headphones button) reads `useEpisodeTask(itemId)`, so they always
 * agree. Three parts, each held once for the whole app:
 *
 *   - the server's view, in the query cache (`useEpisode`, polled while making);
 *   - what the reader did here (asked, Stop confirm, Stopped, Listened, folded):
 *     `tasks`, from episode-task.ts;
 *   - the one audio player, at module level, so playback carries on across
 *     the whole app (between pieces, out of the letter, on every screen), in
 *     the background and on the lock screen;
 *   - which episode the pill's status row carries (`nowPlaying`, from
 *     now-playing.ts): the one last asked for or played, whatever the screen.
 *
 * Playback time ticks four times a second; only `usePlayTime` hears it, so
 * the Reader and the pill don't re-render with it.
 */

export const tasks = createEpisodeTasks();
export const nowPlaying = createNowPlaying();

// ── The one player ───────────────────────────────────────────────────────────
let player: AudioPlayer | null = null;
let loaded: { itemId: string; url: string } | null = null;
/** Coarse playback: which piece, playing or not, started or not. Changes rarely. */
let coarse: PlayState = { itemId: null, playing: false, at: 0, duration: 0 };
/** Fine playback: the time, every update. `scrub` is a drag in progress (seconds). */
let fine = { at: 0, duration: 0, scrub: null as number | null };
const coarseListeners = new Set<() => void>();
const fineListeners = new Set<() => void>();
const emit = (ls: Set<() => void>) => ls.forEach((l) => l());

function setCoarse(next: PlayState) {
  // `at` only says whether it's started: 0, or 1 once past the first half second.
  const n = { ...next, at: next.at > 0.5 ? 1 : 0, duration: 0 };
  if (n.itemId === coarse.itemId && n.playing === coarse.playing && n.at === coarse.at) return;
  coarse = n;
  emit(coarseListeners);
}

function onStatus(s: AudioStatus) {
  if (!loaded) return;
  fine = { ...fine, at: s.currentTime, duration: s.duration || fine.duration };
  emit(fineListeners);
  setCoarse({ itemId: loaded.itemId, playing: s.playing, at: s.currentTime, duration: s.duration });
  if (s.didJustFinish) tasks.finish(loaded.itemId);
}

function getPlayer(): AudioPlayer {
  if (!player) {
    player = createAudioPlayer(null, { updateInterval: 250 });
    player.addListener("playbackStatusUpdate", onStatus);
    // Keeps playing in the background and when locked; `doNotMix` is what the lock screen's controls need.
    void setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: "doNotMix" }).catch(() => {});
  }
  return player;
}

// ── The lock screen ──────────────────────────────────────────────────────────
/** Which piece the lock screen shows, and with what (so it's only told about changes). */
let lockShown: { itemId: string; key: string } | null = null;
const LOCK_OPTIONS = { showSeekForward: true, showSeekBackward: true };

function lockMetadata(meta: NowPlayingMeta | null) {
  return { title: meta?.title ?? "Listen", artist: meta?.subtitle ?? "Founder Signal", albumTitle: "Founder Signal", ...(meta?.artworkUrl ? { artworkUrl: meta.artworkUrl } : {}) };
}

/** The lock screen's now playing card (and Control Center, headphone buttons) follows the loaded episode. */
function showOnLockScreen(itemId: string) {
  if (!player) return;
  const md = lockMetadata(nowPlaying.meta(itemId));
  const key = JSON.stringify(md);
  if (lockShown?.itemId === itemId && lockShown.key === key) return;
  try {
    if (lockShown) player.updateLockScreenMetadata(md);
    else player.setActiveForLockScreen(true, md, LOCK_OPTIONS);
    lockShown = { itemId, key };
  } catch {
    // Not in this build: playback still works without the card.
  }
}

function clearLockScreen() {
  if (!player || !lockShown) return;
  try {
    player.clearLockScreenControls();
  } catch {
    // As above.
  }
  lockShown = null;
}

/** What a piece is, for the row's "go to the piece" and the lock screen. Its reader says, when it shows. */
export function describeNowPlaying(meta: NowPlayingMeta) {
  nowPlaying.describe(meta);
  if (loaded?.itemId === meta.itemId && lockShown) showOnLockScreen(meta.itemId);
}

/** The row's episode folded away (Listened or Stopped): the row falls back or goes, and so does the lock screen card. */
export function rowFolded(itemId: string) {
  nowPlaying.folded(itemId);
  if (loaded?.itemId === itemId && !player?.playing) clearLockScreen();
}

const subscribeNowPlaying = (l: () => void) => nowPlaying.subscribe(l);
/** The piece whose episode the pill's row carries, app-wide (null: no row). */
export function useNowPlaying(): { itemId: string | null; meta: NowPlayingMeta | null } {
  const itemId = useSyncExternalStore(subscribeNowPlaying, nowPlaying.subject);
  const meta = useSyncExternalStore(subscribeNowPlaying, () => nowPlaying.meta(itemId));
  return { itemId, meta };
}

function load(itemId: string, episode: EpisodeView) {
  const url = episodeAudioUrl(episode);
  if (!url) return null;
  const p = getPlayer();
  if (loaded?.itemId !== itemId || loaded.url !== url) {
    p.replace({ uri: url });
    loaded = { itemId, url };
    nowPlaying.loaded(itemId);
    fine = { at: 0, duration: episode.durationSeconds ?? 0, scrub: null };
    setCoarse({ itemId, playing: false, at: 0, duration: 0 });
    emit(fineListeners);
  }
  return p;
}

const subscribeCoarse = (l: () => void) => (coarseListeners.add(l), () => void coarseListeners.delete(l));
const subscribeFine = (l: () => void) => (fineListeners.add(l), () => void fineListeners.delete(l));

// ── Tapping elsewhere keeps going ─────────────────────────────────────────────
type Rect = { x: number; y: number; w: number; h: number };
const confirmRects = new Map<string, Rect>();
/** Where an open "Stop this episode?" is on screen (a touch inside it is meant for it). */
export function setConfirmRect(id: string, r: Rect | null) {
  if (r) confirmRects.set(id, r);
  else confirmRects.delete(id);
}
/**
 * For a screen's root view (`onStartShouldSetResponderCapture`): a touch anywhere outside an open
 * Stop confirm closes it (Keep). It never takes the touch, so the tap still does what it was for.
 */
export function keepOnTouchElsewhere(e: GestureResponderEvent): boolean {
  if (!tasks.anyConfirm()) return false;
  const { pageX: x, pageY: y } = e.nativeEvent;
  const inside = [...confirmRects.values()].some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  if (!inside) tasks.dismiss();
  return false;
}

// ── Time left while making, shared by every view of a piece ───────────────────
/** One estimate per piece, ticked four times a second while it's being made; views hear only a change of label. */
type Estimate = { eta: Eta; text: string; sample: { p: number; elapsed: number | null; at: number } | null };
const estimates = new Map<string, Estimate>();
const etaListeners = new Set<() => void>();
let etaTimer: ReturnType<typeof setInterval> | null = null;

function tickEstimates() {
  const now = Date.now();
  let changed = false;
  for (const e of estimates.values()) {
    const s = e.sample;
    const raw = s && s.elapsed != null && s.p > 0 ? rawSecondsLeft(s.p, s.elapsed, s.at, now) : null;
    const text = tickEta(e.eta, now, s?.p ?? 0, raw);
    if (text !== e.text) {
      e.text = text;
      changed = true;
    }
  }
  if (changed) emit(etaListeners);
  if (!estimates.size && etaTimer) {
    clearInterval(etaTimer);
    etaTimer = null;
  }
}

/** The latest poll of a piece being made (or null: it's not, and its estimate starts afresh next time). */
function sampleEstimate(itemId: string, episode: EpisodeView | null, at: number, making: boolean) {
  if (!making) {
    if (estimates.delete(itemId)) emit(etaListeners);
    return;
  }
  let e = estimates.get(itemId);
  if (!e) estimates.set(itemId, (e = { eta: newEta(), text: ETA_EARLY, sample: null }));
  const sample = episode && isBusy(episode) ? { p: episode.progress, elapsed: episode.elapsedSeconds, at } : null;
  if (sample && e.sample && sample.at === e.sample.at) return;
  e.sample = sample;
  tickEstimates();
  etaTimer ??= setInterval(tickEstimates, 250);
}

const subscribeEta = (l: () => void) => (etaListeners.add(l), () => void etaListeners.delete(l));

// ── Hooks ────────────────────────────────────────────────────────────────────

export type EpisodeTask = {
  itemId: string;
  /** The server has answered (until then `available` and `row` are false because nothing is known). */
  loaded: boolean;
  /** The piece may have an episode at all (articles the app shows in full, with episodes on). */
  available: boolean;
  episode: EpisodeView | null;
  phase: Phase;
  /** "Stop this episode?" is showing (only ever while making). */
  confirming: boolean;
  /** The pill grows its status row. */
  row: boolean;
  /** Making: about how long it has left ("~35s left"); the ring's target (0 → 1, from the worker). */
  eta: string;
  progress: number;
  /** "4 min". */
  length: string;
  start: () => void;
  askStop: () => void;
  keep: () => void;
  stop: () => void;
  /** Play or pause (from the top again once it's played to the end). */
  toggle: () => void;
};

export function useEpisodeTask(itemId: string): EpisodeTask {
  const qc = useQueryClient();
  const query = useEpisode(itemId);
  const local = useSyncExternalStore(tasks.subscribe, () => tasks.get(itemId));
  const play = useSyncExternalStore(subscribeCoarse, () => coarse);
  const episode = query.data?.episode ?? null;
  const phase = phaseOf(episode, local, play, itemId);
  const making = phase === "making";
  const updatedAt = query.dataUpdatedAt;
  useEffect(() => sampleEstimate(itemId, episode, updatedAt, making), [itemId, episode, updatedAt, making]);
  // Ready while the ring is still closing: it's done, whatever the last estimate said.
  const eta = useSyncExternalStore(subscribeEta, () => estimates.get(itemId)?.text ?? (episode?.status === "ready" ? ETA_DONE : ETA_EARLY));

  const start = useCallback(() => {
    tasks.begin(itemId);
    // Being made: it takes the pill's row on every screen.
    nowPlaying.claim(itemId);
    requestEpisode(itemId).then(
      (e) => {
        qc.setQueryData<EpisodeResponse>(episodeKey(itemId), { episode: e, available: true });
        tasks.requested(itemId, true);
      },
      () => tasks.requested(itemId, false),
    );
  }, [qc, itemId]);

  const stop = useCallback(() => {
    tasks.stop(itemId);
    // The card goes straight back to its start button; the job is deleted on the server.
    qc.setQueryData<EpisodeResponse>(episodeKey(itemId), (d) => (d ? { ...d, episode: null } : d));
    cancelEpisode(itemId).then(
      (r) => qc.setQueryData<EpisodeResponse>(episodeKey(itemId), (d) => ({ available: d?.available ?? true, episode: r.episode })),
      () => void qc.invalidateQueries({ queryKey: episodeKey(itemId) }),
    );
  }, [qc, itemId]);

  const toggle = useCallback(() => {
    if (!episode || episode.status !== "ready") return;
    const p = load(itemId, episode);
    if (!p) return;
    // At the end the player stays there (and may still report playing): start again from the top.
    const atEnd = !!p.duration && p.currentTime >= p.duration - 0.5;
    if (p.playing && !atEnd) return p.pause();
    tasks.show(itemId);
    // Playing: it takes the row (replacing another episode in place) and the lock screen.
    nowPlaying.claim(itemId);
    showOnLockScreen(itemId);
    if (atEnd) void p.seekTo(0);
    p.play();
  }, [itemId, episode]);

  return useMemo(
    () => ({
      itemId,
      loaded: query.data !== undefined,
      available: !!query.data?.available,
      episode,
      phase,
      confirming: local.confirm && phase === "making",
      row: !!query.data?.available && rowShows(phase, local),
      eta,
      progress: episode?.status === "ready" ? 1 : (episode?.progress ?? 0),
      length: minutesLabel(episode?.durationSeconds),
      start,
      askStop: () => tasks.askStop(itemId),
      keep: () => tasks.keep(itemId),
      stop,
      toggle,
    }),
    [itemId, query.data, episode, phase, local, eta, start, stop, toggle],
  );
}

/** The playing episode's time (for the scrubber and clock); zero for any other piece. */
export function usePlayTime(itemId: string) {
  const t = useSyncExternalStore(subscribeFine, () => fine);
  const mine = loaded?.itemId === itemId;
  const at = mine ? (t.scrub ?? t.at) : 0;
  return { at, duration: mine ? t.duration : 0, dragging: mine && t.scrub !== null };
}

/** Dragging the scrubber: shows the position at once, seeks on release. */
export function scrubTo(itemId: string, seconds: number | null, commit = false) {
  if (loaded?.itemId !== itemId || !player) return;
  if (commit && seconds !== null) void player.seekTo(seconds);
  fine = { ...fine, scrub: commit ? null : seconds, at: commit && seconds !== null ? seconds : fine.at };
  emit(fineListeners);
}
