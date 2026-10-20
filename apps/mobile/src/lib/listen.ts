import type { EpisodeView } from "@fs/schema";
import { useQueryClient } from "@tanstack/react-query";
import { type AudioPlayer, type AudioStatus, createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { GestureResponderEvent } from "react-native";
import { createEpisodeTasks, makingStep, minutesLabel, type Phase, phaseOf, type PlayState, rowShows } from "./episode-task";
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
 *   - the one audio player, at module level, so playback carries on while the
 *     drawer opens and closes and the pill's controls change hands.
 *
 * Playback time ticks four times a second; only `usePlayTime` hears it, so
 * the Reader and the pill don't re-render with it.
 */

export const tasks = createEpisodeTasks();

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
    void setAudioModeAsync({ playsInSilentMode: true });
  }
  return player;
}

function load(itemId: string, episode: EpisodeView) {
  const url = episodeAudioUrl(episode);
  if (!url) return null;
  const p = getPlayer();
  if (loaded?.itemId !== itemId || loaded.url !== url) {
    p.replace({ uri: url });
    loaded = { itemId, url };
    fine = { at: 0, duration: episode.durationSeconds ?? 0, scrub: null };
    setCoarse({ itemId, playing: false, at: 0, duration: 0 });
    emit(fineListeners);
  }
  return p;
}

/** The reader left the piece (another page, or out of the letter): its audio stops. */
export function pauseIfPlaying(itemId: string) {
  if (loaded?.itemId === itemId && player?.playing) player.pause();
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

// ── Hooks ────────────────────────────────────────────────────────────────────

export type EpisodeTask = {
  itemId: string;
  /** The piece may have an episode at all (articles the app shows in full, with episodes on). */
  available: boolean;
  episode: EpisodeView | null;
  phase: Phase;
  /** "Stop this episode?" is showing (only ever while making). */
  confirming: boolean;
  /** The pill grows its status row. */
  row: boolean;
  /** Making: the step and time left; the ring's target (0 → 1, from the worker). */
  step: string;
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

  const start = useCallback(() => {
    tasks.begin(itemId);
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
    if (p.playing) return p.pause();
    tasks.show(itemId);
    // At the end the player stays there; start again from the top.
    if (p.duration && p.currentTime >= p.duration - 0.5) void p.seekTo(0);
    p.play();
  }, [itemId, episode]);

  const making = makingStep(episode);
  return useMemo(
    () => ({
      itemId,
      available: !!query.data?.available,
      episode,
      phase,
      confirming: local.confirm && phase === "making",
      row: !!query.data?.available && rowShows(phase, local),
      step: making.step,
      eta: making.eta,
      progress: episode?.status === "ready" ? 1 : (episode?.progress ?? 0),
      length: minutesLabel(episode?.durationSeconds),
      start,
      askStop: () => tasks.askStop(itemId),
      keep: () => tasks.keep(itemId),
      stop,
      toggle,
    }),
    [itemId, query.data?.available, episode, phase, local, making.step, making.eta, start, stop, toggle],
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

/** Pauses the piece's audio when the component that plays it goes (the Reader, when the page changes). */
export function usePauseOnLeave(itemId: string) {
  useEffect(() => () => pauseIfPlaying(itemId), [itemId]);
}
