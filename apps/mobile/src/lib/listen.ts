import type { EpisodeView } from "@fs/schema";
import { useQueryClient } from "@tanstack/react-query";
import { type AudioPlayer, type AudioStatus, createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { GestureResponderEvent } from "react-native";
import { createEpisodeTasks, ETA_DONE, ETA_EARLY, type Eta, isBusy, minutesLabel, newEta, type Phase, phaseOf, type PlayState, rawSecondsLeft, rowShows, tickEta } from "./episode-task";
import { createNowPlaying, type NowPlayingMeta, type PlayerView, watchList } from "./now-playing";
import { resumeAt } from "./podcast-library";
import { podcastLibrary } from "./podcasts";
import { cancelEpisode, episodeAudioUrl, episodeKey, type EpisodeResponse, requestEpisode, useEpisode } from "./podcast";
import { queryClient } from "./query";

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
 *   - what the pill's row and its expandable panel show (`nowPlaying`, from
 *     now-playing.ts): what's playing, Up next, and the episodes it tracks.
 *
 * Playback time ticks four times a second; only `usePlayTime` hears it, so
 * the Reader and the pill don't re-render with it.
 */

export const tasks = createEpisodeTasks();
export const nowPlaying = createNowPlaying();

// ── The one player ───────────────────────────────────────────────────────────
/**
 * The app's only audio player, created on first use. Its handle is also kept on `globalThis`, because Fast
 * Refresh re-runs this module with fresh module state: without that, each edit would make another native
 * player while the old one kept playing. When the module runs again, the previous player is stopped, taken
 * off the lock screen and released before anything else, so there is never more than one.
 */
const SLOT = "__foundersignal_listen_player__";
const slot = globalThis as unknown as Record<typeof SLOT, AudioPlayer | undefined>;
releasePlayer(slot[SLOT]);
slot[SLOT] = undefined;

function releasePlayer(p: AudioPlayer | undefined) {
  if (!p) return;
  try {
    p.pause();
    p.clearLockScreenControls();
    p.removeAllListeners("playbackStatusUpdate");
    p.remove();
  } catch {
    // Already gone with its runtime.
  }
}

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

/** Where a just-loaded episode picks up (the Podcasts tab's saved spot), once the player has it loaded. */
let pendingSeek: number | null = null;

function onStatus(s: AudioStatus) {
  if (!loaded) return;
  if (pendingSeek !== null) {
    if (!s.isLoaded) return;
    const to = pendingSeek;
    pendingSeek = null;
    if (Math.abs(s.currentTime - to) > 1) {
      void player?.seekTo(to);
      return;
    }
  }
  fine = { ...fine, at: s.currentTime, duration: s.duration || fine.duration };
  emit(fineListeners);
  setCoarse({ itemId: loaded.itemId, playing: s.playing, at: s.currentTime, duration: s.duration });
  // The Podcasts tab keeps where you are in it (and whether you've listened).
  podcastLibrary.progress(loaded.itemId, s.currentTime, s.duration, s.playing);
  if (s.didJustFinish) {
    const ended = loaded.itemId;
    tasks.finish(ended);
    podcastLibrary.finished(ended);
    // The reader asked for what comes next: it plays now. Otherwise nothing starts on its own.
    const next = nowPlaying.advance();
    if (next) playNow(next);
  }
}

function getPlayer(): AudioPlayer {
  if (!player) {
    releasePlayer(slot[SLOT]);
    player = createAudioPlayer(null, { updateInterval: 250 });
    slot[SLOT] = player;
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
  podcastLibrary.describe(meta);
  if (loaded?.itemId === meta.itemId && lockShown) showOnLockScreen(meta.itemId);
}

/** An episode's row folded away (Listened or Stopped): it stops offering itself to the row, and the lock screen card goes if it was this one's. */
export function rowFolded(itemId: string) {
  nowPlaying.folded(itemId);
  if (loaded?.itemId === itemId && !player?.playing) clearLockScreen();
}

const subscribeNowPlaying = (l: () => void) => nowPlaying.subscribe(l);
/** What the pill shows: the row, the panel's lists and the handle's hint (`playbackOnly`: the Podcasts tab). */
export function usePlayerView(playbackOnly: boolean): PlayerView {
  return useSyncExternalStore(subscribeNowPlaying, () => nowPlaying.view(playbackOnly));
}
/** What a piece is, as its reader last said (null until it has). */
export function useNowPlayingMeta(itemId: string | null): NowPlayingMeta | null {
  return useSyncExternalStore(subscribeNowPlaying, () => nowPlaying.meta(itemId));
}

/** What the pill says about an episode: its title, "No. 14 · Piece 1 · Author" and artwork (its reader's word, else the Podcasts tab's). */
export type EpisodeInfo = { title: string; line: string; artworkUrl: string | null };
const infos = new Map<string, { key: string; info: EpisodeInfo }>();
function episodeInfo(itemId: string): EpisodeInfo | null {
  const m = nowPlaying.meta(itemId);
  const e = podcastLibrary.get(itemId);
  if (!m && !e) return null;
  const n = m?.letterNumber ?? e?.letterNumber ?? null;
  const pos = m?.position ?? e?.position ?? null;
  const author = m?.author ?? e?.author ?? null;
  const info = {
    title: m?.title ?? e?.title ?? "",
    line: [n != null ? `No. ${n}` : null, pos != null ? `Piece ${pos}` : null, author].filter(Boolean).join(" · "),
    artworkUrl: m?.artworkUrl ?? null,
  };
  // The same object until it changes (useSyncExternalStore).
  const key = JSON.stringify(info);
  const was = infos.get(itemId);
  if (was?.key === key) return was.info;
  infos.set(itemId, { key, info });
  return info;
}
const subscribeInfo = (l: () => void) => {
  const a = nowPlaying.subscribe(l);
  const b = podcastLibrary.subscribe(l);
  return () => (a(), b());
};
export function useEpisodeInfo(itemId: string | null): EpisodeInfo | null {
  return useSyncExternalStore(subscribeInfo, () => (itemId ? episodeInfo(itemId) : null));
}
export function useEpisodeTitle(itemId: string | null): string | null {
  return useEpisodeInfo(itemId)?.title || null;
}

/** The episodes the pill watches for its panel (now-playing.ts `watchList`). */
export function useWatchList(): string[] {
  const key = useSyncExternalStore(subscribeInfo, () => watchList(nowPlaying.state(), podcastLibrary.entries()).join("\n"));
  return useMemo(() => (key ? key.split("\n") : []), [key]);
}

function load(itemId: string, episode: EpisodeView) {
  const url = episodeAudioUrl(episode);
  if (!url) return null;
  const p = getPlayer();
  if (loaded?.itemId !== itemId || loaded.url !== url) {
    p.replace({ uri: url });
    pendingSeek = null;
    loaded = { itemId, url };
    nowPlaying.loaded(itemId);
    fine = { at: 0, duration: episode.durationSeconds ?? 0, scrub: null };
    setCoarse({ itemId, playing: false, at: 0, duration: 0 });
    emit(fineListeners);
  }
  return p;
}

const subscribeCoarse = (l: () => void) => (coarseListeners.add(l), () => void coarseListeners.delete(l));
/** The piece whose audio is in the player (playing, paused or ended), or null. */
export function usePlayerItem(): string | null {
  return useSyncExternalStore(subscribeCoarse, () => coarse.itemId);
}

/** On the Podcasts tab: asked for or played (with what its reader said about it, when it showed). */
function rememberEpisode(itemId: string) {
  podcastLibrary.remember(nowPlaying.meta(itemId) ?? { itemId, title: "Untitled piece", home: { kind: "item" } });
}
const subscribeFine = (l: () => void) => (fineListeners.add(l), () => void fineListeners.delete(l));

/**
 * Plays a ready episode in the one player (replacing whatever was in it, which keeps its place in Podcasts): it
 * becomes what's playing, on the row and the lock screen. Part-way through, it carries on from there; at the
 * end, from the top.
 */
function playItem(itemId: string, episode: EpisodeView) {
  const fresh = loaded?.itemId !== itemId;
  const p = load(itemId, episode);
  if (!p) return;
  const atEnd = !!p.duration && p.currentTime >= p.duration - 0.5;
  tasks.show(itemId);
  nowPlaying.played(itemId);
  showOnLockScreen(itemId);
  rememberEpisode(itemId);
  if (atEnd) void p.seekTo(0);
  else if (fresh) {
    // Part-way through (from the Podcasts tab, or another day): carry on from there.
    const from = resumeAt(podcastLibrary.get(itemId));
    if (from) {
      pendingSeek = from;
      fine = { ...fine, at: from };
      emit(fineListeners);
    }
  }
  p.play();
}

/** "Play now" (and Up next's turn): plays it if it's ready, from what the app last heard from the server. */
export function playNow(itemId: string) {
  const episode = queryClient.getQueryData<EpisodeResponse>(episodeKey(itemId))?.episode;
  if (episode?.status === "ready") playItem(itemId, episode);
}

/** "Play after this": to the end of Up next. */
export const playAfter = (itemId: string) => nowPlaying.playAfter(itemId);
/** ✕ on Up next: back to Ready. */
export const unqueue = (itemId: string) => nowPlaying.unqueue(itemId);

/** ±15s on the episode in the player (nothing for any other piece). */
export function skipBy(itemId: string, seconds: number) {
  if (loaded?.itemId !== itemId || !player) return;
  const duration = player.duration || fine.duration;
  const to = Math.max(0, Math.min(duration ? duration - 0.5 : Infinity, (fine.scrub ?? fine.at) + seconds));
  void player.seekTo(to);
  fine = { ...fine, at: to, scrub: null };
  emit(fineListeners);
}

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
    rememberEpisode(itemId);
    // Being made: with nothing playing, the pill's row shows it, on every screen.
    nowPlaying.ask(itemId);
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
    // It was never made, so it leaves the Podcasts tab too.
    podcastLibrary.forget(itemId);
    // The card goes straight back to its start button; the job is deleted on the server.
    qc.setQueryData<EpisodeResponse>(episodeKey(itemId), (d) => (d ? { ...d, episode: null } : d));
    cancelEpisode(itemId).then(
      (r) => qc.setQueryData<EpisodeResponse>(episodeKey(itemId), (d) => ({ available: d?.available ?? true, episode: r.episode })),
      () => void qc.invalidateQueries({ queryKey: episodeKey(itemId) }),
    );
  }, [qc, itemId]);

  const toggle = useCallback(() => {
    if (!episode || episode.status !== "ready") return;
    // At the end the player stays there (and may still report playing): play starts again from the top.
    const p = loaded?.itemId === itemId ? player : null;
    const atEnd = !!p?.duration && p.currentTime >= p.duration - 0.5;
    if (p?.playing && !atEnd) return p.pause();
    // Playing: it becomes what's playing (replacing another episode in the row, in place) and the lock screen.
    playItem(itemId, episode);
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
