import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { usePathname } from "expo-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type GestureResponderEvent, Pressable, Text, type TextStyle, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  interpolateColor,
  Keyframe,
  LinearTransition,
  ReduceMotion,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path, Rect, Text as SvgText } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import { font, palette } from "@/components/onboarding/kit";
import { PANEL_SPRING, PillStatusSlot, STATUS_H, STATUS_OPEN_W, usePillFrame } from "@/components/pager/Pill";
import { fmtTime } from "@/lib/episode-task";
import {
  nowPlaying,
  playAfter,
  playNow,
  rowFolded,
  scrubTo,
  skipBy,
  tasks,
  unqueue,
  useEpisodeInfo,
  useEpisodeTask,
  usePlayerItem,
  usePlayerView,
  usePlayTime,
  useWatchList,
} from "@/lib/listen";
import type { HintKind, PlayerView } from "@/lib/now-playing";
import { goToPodcasts } from "@/lib/now-playing-nav";
import { POLL_MS } from "@/lib/podcast";
import { STARTED_AT } from "@/lib/podcast-library";
import { usePillRowPlaybackOnly, usePodcastEntry } from "@/lib/podcasts";
import { MakingLine, NowPlayingRow, ProgressRing, Shimmer, STATUS_ROW_H } from "./EpisodeStatus";

/**
 * The expandable player (player-expand.html, "the handle fills"): the pill's
 * status row, app-wide. Collapsed, the row only ever shows what's playing
 * (with nothing playing, the episode asked for here: ready, or being made).
 * A grab handle on its top edge is the only trace of anything else: it fills
 * with the progress of the episode closest to done while one is being made,
 * and turns blue and pulses once when one becomes ready.
 *
 * Drag the row up, or tap the handle, and it grows into a dark panel out of
 * the same pill (Pill.tsx draws the shape from `usePillFrame()`), with the
 * pill's controls still underneath: Now playing, then Up next, Ready and
 * Making, ordered by how soon you'll hear them, and a link to the Podcasts
 * tab. It follows the finger with rubber-banding at both ends; a flick
 * decides, otherwise it settles to the nearer side of halfway. With Reduce
 * Motion it opens and closes at once.
 *
 * What it lists comes from `nowPlaying` (now-playing.ts), fed by one watcher
 * per episode it tracks (`TrackedEpisodes`).
 */

/** The open panel's width, and its least and most height (it scrolls inside past that). */
const PANEL_W = STATUS_OPEN_W;
const PANEL_MIN_H = STATUS_H + 80;
const PANEL_MAX_H = 286;
/** A release faster than this (px/ms) decides by its direction. */
const FLICK = 0.3;
/** The panel's content sits this far under its top edge (the handle's room). */
const PANEL_TOP = 16;
const HAIR = "rgba(255,255,255,0.1)";
const SEP = "rgba(255,255,255,0.08)";

const EASE = Easing.bezier(0.2, 0.8, 0.2, 1);
const NEVER = ReduceMotion.Never;
/** A row that arrives in the open panel rises in (the ones that stay glide to their new place). */
const ROW_IN = new Keyframe({ 0: { opacity: 0, transform: [{ translateY: 8 }] }, 100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE } }).delay(80).duration(260);
const ROW_MOVE = LinearTransition.duration(340).easing(EASE);

const clamp = (v: number, a = 0, b = 1) => {
  "worklet";
  return Math.min(b, Math.max(a, v));
};

/** Resistance past either end, in points of height (the mock's). */
function rubber(h: number, hs: number) {
  "worklet";
  if (h > hs) return hs + 18 * (1 - Math.exp(-(h - hs) / 60));
  if (h < STATUS_H) return STATUS_H - 8 * (1 - Math.exp(-(STATUS_H - h) / 40));
  return h;
}

// ── In the root layout ───────────────────────────────────────────────────────

/**
 * The app's one status row, in the root layout: it claims the pill's row on every screen while there's
 * something to show, so moving around the app never folds or regrows it. On the Library's Podcasts tab the row
 * is for playback only (making progress shows in the list's rows).
 */
export function NowPlayingStatus() {
  const playbackOnly = usePillRowPlaybackOnly();
  const has = usePlayerView(playbackOnly).row != null;
  const node = useMemo(() => <ExpandablePlayer playbackOnly={playbackOnly} />, [playbackOnly]);
  return (
    <>
      <TrackedEpisodes />
      <PillStatusSlot>{has ? node : null}</PillStatusSlot>
    </>
  );
}

/** One watcher per episode the pill tracks: the one in the player, asked for here, Up next, and Podcasts' New ones. */
function TrackedEpisodes() {
  const ids = useWatchList();
  return (
    <>
      {ids.map((id) => (
        <Watcher key={id} itemId={id} />
      ))}
    </>
  );
}

function Watcher({ itemId }: { itemId: string }) {
  const { loaded, phase, row, progress } = useEpisodeTask(itemId);
  const entry = usePodcastEntry(itemId);
  const unplayed = !entry || (!entry.listened && entry.at <= STARTED_AT);
  const addedAt = entry?.addedAt ?? 0;
  useEffect(() => {
    if (loaded) nowPlaying.report({ itemId, phase, open: row, progress, unplayed, addedAt });
  }, [itemId, loaded, phase, row, progress, unplayed, addedAt]);
  useEffect(() => () => nowPlaying.untrack(itemId), [itemId]);
  // Its row closed (Listened or Stopped): it stops offering itself to the row, and leaves the lock screen.
  const closed = loaded && !row;
  useEffect(() => {
    if (closed) rowFolded(itemId);
  }, [closed, itemId]);
  return null;
}

// ── The row and its panel ────────────────────────────────────────────────────

function ExpandablePlayer({ playbackOnly }: { playbackOnly: boolean }) {
  const frame = usePillFrame()!;
  const { open, panelH, reduce } = frame;
  const view = usePlayerView(playbackOnly);
  // While the row folds away it keeps showing its last episode.
  const [rowId, setRowId] = useState(view.row);
  if (view.row && view.row !== rowId) setRowId(view.row);

  /** The panel is only there while it's open or on its way (so its Now playing doesn't tick under the row). */
  const [mounted, setMounted] = useState(false);
  /** Past halfway: the panel takes taps, the row doesn't. */
  const [isOpen, setIsOpen] = useState(false);
  const onOpened = useCallback((on: boolean) => {
    setIsOpen(on);
    // Opened: whatever is ready has been seen, and the handle goes plain.
    if (on) nowPlaying.sawPanel();
  }, []);
  useAnimatedReaction(
    () => Math.abs(open.get()) > 0.0005,
    (on, was) => {
      if (on !== was) scheduleOnRN(setMounted, on);
    },
  );
  useAnimatedReaction(
    () => open.get() > 0.5,
    (on, was) => {
      if (on !== was) scheduleOnRN(onOpened, on);
    },
  );

  // The panel's height: its content, up to PANEL_MAX_H (then the list scrolls).
  const npH = useSharedValue(0);
  const listH = useSharedValue(0);
  const scrollY = useSharedValue(0);
  useEffect(() => {
    if (!view.top) npH.set(0);
  }, [view.top, npH]);
  useAnimatedReaction(
    () => clamp(PANEL_TOP + npH.get() + 1 + listH.get() + 1, PANEL_MIN_H, PANEL_MAX_H),
    (target, prev) => {
      if (prev == null || target === prev) return;
      if (reduce || open.get() < 0.02) panelH.set(target);
      else panelH.set(withTiming(target, { duration: 220, easing: EASE, reduceMotion: NEVER }));
    },
    [reduce],
  );

  // The drag. It decides after 5pt: sideways is the scrubber's, and inside the open list scrolling wins unless
  // it's a pull down from the top. Then the panel follows the finger, rubber-banding past either end.
  const start = useSharedValue({ x: 0, y: 0, h: STATUS_H, inList: false, decided: false });
  const native = useMemo(() => Gesture.Native(), []);
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .manualActivation(true)
        .onTouchesDown((e) => {
          const t = e.allTouches[0];
          if (!t) return;
          const p = open.get();
          start.set({
            x: t.absoluteX,
            y: t.absoluteY,
            h: STATUS_H + (panelH.get() - STATUS_H) * p,
            inList: p > 0.5 && t.y > PANEL_TOP + npH.get(),
            decided: false,
          });
        })
        .onTouchesMove((e, manager) => {
          const s = start.get();
          const t = e.allTouches[0];
          if (!t || s.decided) return;
          const dx = t.absoluteX - s.x;
          const dy = t.absoluteY - s.y;
          if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
          start.set({ ...s, decided: true });
          if (Math.abs(dx) > Math.abs(dy) || (s.inList && !(scrollY.get() <= 0 && dy > 0))) manager.fail();
          else manager.activate();
        })
        .onStart(() => {
          cancelAnimation(open);
        })
        .onUpdate((e) => {
          const hs = panelH.get();
          const h = rubber(start.get().h - e.translationY, hs);
          open.set((h - STATUS_H) / Math.max(1, hs - STATUS_H));
        })
        .onEnd((e) => {
          const v = e.velocityY / 1000;
          const to = v < -FLICK || (v <= FLICK && open.get() > 0.5) ? 1 : 0;
          if (reduce) open.set(to);
          else open.set(withSpring(to, { ...PANEL_SPRING, velocity: clamp(-e.velocityY / Math.max(60, panelH.get() - STATUS_H), -14, 14) }));
        }),
    [open, panelH, npH, scrollY, start, reduce],
  );

  // The row and the panel cross-fade near the bottom of the travel.
  const rowStyle = useAnimatedStyle(() => ({ opacity: 1 - clamp(open.get() / 0.4) }));
  const panelStyle = useAnimatedStyle(() => ({
    height: panelH.get() - 1,
    opacity: clamp((open.get() - 0.2) / 0.5),
    transform: [{ translateY: (1 - clamp(open.get())) * 10 }],
  }));

  const toggle = () => frame.settle(open.get() < 0.5);
  const close = () => frame.settle(false);

  return (
    <GestureDetector gesture={pan}>
      <View collapsable={false} style={{ flex: 1 }}>
        <Animated.View
          accessibilityElementsHidden={isOpen}
          importantForAccessibility={isOpen ? "no-hide-descendants" : "auto"}
          style={[{ position: "absolute", left: 0, right: 0, top: 0, height: STATUS_H - 1, paddingTop: STATUS_H - 1 - STATUS_ROW_H, pointerEvents: isOpen ? "none" : "box-none" }, rowStyle]}
        >
          {rowId && <NowPlayingRow itemId={rowId} />}
        </Animated.View>
        {mounted && (
          <Animated.View
            accessibilityElementsHidden={!isOpen}
            importantForAccessibility={isOpen ? "auto" : "no-hide-descendants"}
            style={[{ position: "absolute", top: 0, left: "50%", width: PANEL_W, marginLeft: -PANEL_W / 2, paddingTop: PANEL_TOP, pointerEvents: isOpen ? "box-none" : "none" }, panelStyle]}
          >
            <Panel view={view} native={native} npH={npH} listH={listH} scrollY={scrollY} panelH={panelH} reduce={reduce} onClose={close} />
          </Animated.View>
        )}
        <Handle kind={view.hint.kind} progress={view.hint.progress} open={open} isOpen={isOpen} reduce={reduce} onPress={toggle} />
      </View>
    </GestureDetector>
  );
}

// ── The handle, and the hint it carries ──────────────────────────────────────

const BAR_W = 26;
const BAR_WIDE = 32;
const BAR_H = 4;

/**
 * The grab handle on the row's top edge: plain grey with nothing waiting. While one is being made it grows a
 * little and fills white with the progress of the one closest to done. When one becomes ready it turns blue and
 * pulses once, and stays blue until the panel is opened or the episode plays. Tapping it opens or closes the panel.
 */
function Handle({
  kind,
  progress,
  open,
  isOpen,
  reduce,
  onPress,
}: {
  kind: HintKind;
  progress: number;
  open: SharedValue<number>;
  isOpen: boolean;
  reduce: boolean;
  onPress: () => void;
}) {
  const wide = kind !== "none" || isOpen;
  const w = useSharedValue(wide ? BAR_WIDE : BAR_W);
  const blue = useSharedValue(kind === "ready" ? 1 : 0);
  const fill = useSharedValue(progress);
  const pulse = useSharedValue(0);
  const was = useRef(kind);

  useEffect(() => {
    const cfg = { duration: reduce ? 0 : 260, easing: EASE, reduceMotion: NEVER };
    w.set(withTiming(wide ? BAR_WIDE : BAR_W, cfg));
    blue.set(withTiming(kind === "ready" ? 1 : 0, cfg));
  }, [wide, kind, reduce, w, blue]);
  useEffect(() => {
    // Eases up to each polled number over the poll interval, like the ring. Lower is another episode now
    // leading (the last one became ready), so it starts from there.
    if (reduce || progress < fill.get()) fill.set(progress);
    else fill.set(withTiming(progress, { duration: POLL_MS, easing: Easing.linear, reduceMotion: NEVER }));
  }, [progress, reduce, fill]);
  useEffect(() => {
    const from = was.current;
    was.current = kind;
    // Ready: one pulse (not while the panel is open, where it's moving into Ready instead).
    if (from !== "ready" && kind === "ready" && open.get() < 0.5 && !reduce) {
      pulse.set(0);
      pulse.set(withTiming(1, { duration: 700, easing: EASE, reduceMotion: NEVER }));
    }
  }, [kind, open, reduce, pulse]);

  const barStyle = useAnimatedStyle(() => {
    const k = pulse.get();
    const s = k <= 0 || k >= 1 ? 0 : k < 0.45 ? k / 0.45 : 1 - (k - 0.45) / 0.55;
    return {
      width: w.get(),
      backgroundColor: interpolateColor(blue.get(), [0, 1], ["rgba(255,255,255,0.26)", palette.blueMid]),
      transform: [{ scaleX: 1 + 0.3 * s }, { scaleY: 1 + 0.5 * s }],
    };
  });
  const glowStyle = useAnimatedStyle(() => {
    const k = pulse.get();
    const on = k > 0 && k < 1;
    return { width: w.get(), opacity: on ? 0.7 * (1 - k) : 0, transform: [{ scaleX: 1 + (10 * k) / BAR_WIDE }, { scaleY: 1 + (10 * k) / BAR_H }] };
  });
  const fillStyle = useAnimatedStyle(() => ({ width: clamp(fill.get()) * w.get() }));

  const label = kind === "ready" ? "An episode is ready" : kind === "making" ? `An episode is being made, ${Math.round(progress * 100)}%` : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={isOpen ? "Hide what's playing and waiting" : "Show what's playing and waiting"}
      accessibilityHint={label ?? undefined}
      accessibilityState={{ expanded: isOpen }}
      onPress={onPress}
      hitSlop={{ top: 4, left: 8, right: 8 }}
      style={{ position: "absolute", zIndex: 3, top: 0, left: "50%", width: 72, height: 16, marginLeft: -36, alignItems: "center", justifyContent: "center" }}
    >
      <Animated.View style={[{ position: "absolute", height: BAR_H, borderRadius: 2, backgroundColor: palette.blueMid }, glowStyle]} />
      <Animated.View style={[{ height: BAR_H, borderRadius: 2, overflow: "hidden" }, barStyle]}>
        {kind === "making" && <Animated.View style={[{ position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.8)" }, fillStyle]} />}
      </Animated.View>
    </Pressable>
  );
}

// ── The open panel ───────────────────────────────────────────────────────────

const SECTION: TextStyle = { fontFamily: font.mono, fontSize: 10, lineHeight: 13, letterSpacing: 0.6, textTransform: "uppercase", color: palette.pillMuted };
const ROW_TITLE: TextStyle = { fontFamily: font.bodySemi, fontSize: 13, lineHeight: 16, color: "#FFFFFF" };
const ROW_SUB: TextStyle = { fontFamily: font.bodyMedium, fontSize: 11, lineHeight: 14, color: palette.pillMuted, fontVariant: ["tabular-nums"], letterSpacing: -0.11 };

function Panel({
  view,
  native,
  npH,
  listH,
  scrollY,
  panelH,
  reduce,
  onClose,
}: {
  view: PlayerView;
  native: ReturnType<typeof Gesture.Native>;
  npH: SharedValue<number>;
  listH: SharedValue<number>;
  scrollY: SharedValue<number>;
  panelH: SharedValue<number>;
  reduce: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  // Rows that arrive after the panel first shows rise in; its first look doesn't.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const motion = { layout: reduce ? undefined : ROW_MOVE, entering: reduce || !settled ? undefined : ROW_IN };

  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.set(e.contentOffset.y);
  });
  // A fade at the bottom while there's more below.
  const fadeStyle = useAnimatedStyle(() => {
    const viewport = panelH.get() - 1 - PANEL_TOP - npH.get() - 1;
    return { opacity: listH.get() > viewport + 2 && scrollY.get() + viewport < listH.get() - 2 ? 1 : 0 };
  });

  const { upNext, ready, making, top, now } = view;
  const empty = !upNext.length && !ready.length && !making.length;

  return (
    <>
      {top && <NowPlayingBlock key={top} itemId={top} onHeight={(h) => npH.set(h)} />}
      <View style={{ flex: 1, minHeight: 0, borderTopWidth: 1, borderTopColor: HAIR }}>
        <GestureDetector gesture={native}>
          <Animated.ScrollView
            onScroll={onScroll}
            scrollEventThrottle={16}
            bounces={false}
            overScrollMode="never"
            showsVerticalScrollIndicator={false}
            onContentSizeChange={(_, h) => listH.set(h)}
            contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 6 }}
          >
            {upNext.length > 0 && <SectionHead key="h-next" title="Up next" motion={motion} />}
            {upNext.map((id, i) => (
              <Animated.View key={`n-${id}`} {...motion}>
                <UpNextRow itemId={id} index={i} rule={i > 0} />
              </Animated.View>
            ))}
            {ready.length > 0 && <SectionHead key="h-ready" title="Ready" motion={motion} />}
            {ready.map((id, i) => (
              <Animated.View key={`r-${id}`} {...motion}>
                <ReadyRow itemId={id} rule={i > 0} />
              </Animated.View>
            ))}
            {making.length > 0 && <SectionHead key="h-making" title="Making" motion={motion} />}
            {making.map((id, i) => (
              <Animated.View key={`m-${id}`} {...motion}>
                <MakingRow itemId={id} rule={i > 0} />
              </Animated.View>
            ))}
            {empty && (
              <Animated.View key="empty" {...motion}>
                {now ? <EmptyNote itemId={now} /> : <EmptyText playing={false} />}
              </Animated.View>
            )}
            <Animated.View key="all" {...motion}>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="All episodes in Podcasts"
                onPress={() => {
                  onClose();
                  goToPodcasts(pathname);
                }}
                style={({ pressed }) => ({
                  marginTop: 2,
                  paddingTop: 9,
                  paddingBottom: 4,
                  paddingHorizontal: 4,
                  borderTopWidth: 1,
                  borderTopColor: HAIR,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text style={{ fontFamily: font.bodySemi, fontSize: 12.5, lineHeight: 15, color: palette.blueMid }}>All episodes in Podcasts</Text>
                <Svg width={14} height={14} viewBox="0 0 24 24">
                  <Path d="M9 6l6 6-6 6" fill="none" stroke={palette.blueMid} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
                </Svg>
              </Pressable>
            </Animated.View>
          </Animated.ScrollView>
        </GestureDetector>
        <Animated.View style={[{ position: "absolute", left: 0, right: 0, bottom: 0, height: 22, pointerEvents: "none" }, fadeStyle]}>
          <LinearGradient colors={["rgba(18,19,22,0)", palette.pill]} style={{ flex: 1 }} />
        </Animated.View>
      </View>
    </>
  );
}

/** Nothing waiting: while something plays, where what you make will go. */
function EmptyNote({ itemId }: { itemId: string }) {
  return <EmptyText playing={useEpisodeTask(itemId).phase === "playing"} />;
}
function EmptyText({ playing }: { playing: boolean }) {
  return (
    <Text style={{ paddingTop: 12, paddingBottom: 6, paddingHorizontal: 4, fontFamily: font.bodyMedium, fontSize: 12, lineHeight: 16, color: palette.pillMuted }}>
      {playing ? "Episodes you make while this plays will wait here." : "Nothing else waiting."}
    </Text>
  );
}

type Motion = { layout: typeof ROW_MOVE | undefined; entering: typeof ROW_IN | undefined };

function SectionHead({ title, motion }: { title: string; motion: Motion }) {
  return (
    <Animated.View {...motion} style={{ paddingTop: 8, paddingBottom: 2, paddingHorizontal: 4 }}>
      <Text accessibilityRole="header" style={SECTION}>
        {title}
      </Text>
    </Animated.View>
  );
}

/** A panel row: a 28pt icon, the text, and whatever it ends with; a hairline above it after the first in a section. */
function PanelRow({ rule, icon, children, end, top = false }: { rule: boolean; icon: ReactNode; children: ReactNode; end?: ReactNode; top?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: top ? "flex-start" : "center", gap: 10, paddingVertical: 6, paddingHorizontal: 4 }}>
      {rule && <View style={{ position: "absolute", top: 0, left: 42, right: 4, height: 1, backgroundColor: SEP }} />}
      <View style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center", marginTop: top ? -2 : 0 }}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>{children}</View>
      {end}
    </View>
  );
}

function XButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={9}
      style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" }}
    >
      <Svg width={12} height={12} viewBox="0 0 24 24">
        <Path d="M7 7l10 10M17 7L7 17" stroke={palette.pillMuted} strokeWidth={2.6} strokeLinecap="round" />
      </Svg>
    </Pressable>
  );
}

/** Up next: its place in the queue, its title, "After this" (or "Then") and its length, and ✕ to take it off. */
function UpNextRow({ itemId, index, rule }: { itemId: string; index: number; rule: boolean }) {
  const task = useEpisodeTask(itemId);
  const title = useEpisodeInfo(itemId)?.title ?? "";
  return (
    <PanelRow
      rule={rule}
      icon={
        <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: "rgba(255,255,255,0.3)", alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontFamily: font.mono, fontSize: 10.5, lineHeight: 12, color: "#FFFFFF" }}>{index + 1}</Text>
        </View>
      }
      end={<XButton label={`Remove ${title} from Up next`} onPress={() => unqueue(itemId)} />}
    >
      <Text numberOfLines={1} style={ROW_TITLE}>
        {title}
      </Text>
      <Text numberOfLines={1} style={ROW_SUB}>
        {index ? "Then" : "After this"} · {task.length}
      </Text>
    </PanelRow>
  );
}

/** Ready: made and not yet played, with Play now, Play after this and its length. */
function ReadyRow({ itemId, rule }: { itemId: string; rule: boolean }) {
  const task = useEpisodeTask(itemId);
  const title = useEpisodeInfo(itemId)?.title ?? "";
  const button = (primary: boolean) => ({ pressed }: { pressed: boolean }) => ({
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 9,
    borderWidth: 1,
    borderColor: primary ? palette.blue : "rgba(255,255,255,0.3)",
    backgroundColor: primary ? palette.blue : "transparent",
    opacity: pressed ? 0.75 : 1,
  });
  const label: TextStyle = { fontFamily: font.bodySemi, fontSize: 12, lineHeight: 12, color: "#FFFFFF" };
  return (
    <PanelRow
      rule={rule}
      top
      icon={
        <Svg width={28} height={28} viewBox="0 0 32 32">
          <Circle cx={16} cy={16} r={16} fill={palette.blue} />
          <Path d="M13 10.6v10.8l8.6-5.4z" fill="#FFFFFF" />
        </Svg>
      }
    >
      <Text numberOfLines={1} style={ROW_TITLE}>
        {title}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 5, minWidth: 0 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Play ${title} now`} onPress={() => playNow(itemId)} style={button(true)}>
          <Text style={label}>Play now</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Play ${title} after this`} onPress={() => playAfter(itemId)} style={button(false)}>
          <Text style={label}>Play after this</Text>
        </Pressable>
        <Text numberOfLines={1} style={[ROW_SUB, { flex: 1, textAlign: "right" }]}>
          {task.length}
        </Text>
      </View>
    </PanelRow>
  );
}

/** Making: the ring, the step and the time left, and ✕ with the approved Stop confirm in the row's place. */
function MakingRow({ itemId, rule }: { itemId: string; rule: boolean }) {
  const task = useEpisodeTask(itemId);
  const title = useEpisodeInfo(itemId)?.title ?? "";
  const [step, setStep] = useState(0);
  const confirming = task.confirming;
  const quiet = useSharedValue(confirming);
  useEffect(() => quiet.set(confirming), [confirming, quiet]);
  return (
    <View>
      <View style={{ opacity: confirming ? 0 : 1, pointerEvents: confirming ? "none" : "auto" }} accessibilityElementsHidden={confirming} importantForAccessibility={confirming ? "no-hide-descendants" : "auto"}>
        <PanelRow
          rule={rule}
          icon={<ProgressRing key={task.episode?.id ?? "asked"} progress={task.progress} size={28} tone="dark" stopped={false} quiet={quiet} onStep={setStep} />}
          end={<XButton label={`Stop making ${title}`} onPress={() => tasks.askStop(itemId)} />}
        >
          <Shimmer text={title} style={ROW_TITLE} ink="#FFFFFF" shine="rgba(255,255,255,0.4)" />
          <MakingLine step={step} eta={task.eta} tone="dark" quiet={confirming} />
        </PanelRow>
      </View>
      {confirming && (
        <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 6, paddingRight: 4 }}>
          <Text accessibilityRole="alert" numberOfLines={1} style={{ flex: 1, minWidth: 0, fontFamily: font.bodySemi, fontSize: 12.5, lineHeight: 15, color: "#FFFFFF" }}>
            Stop this episode?
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Keep making it"
            onPress={task.keep}
            style={({ pressed }) => ({ borderRadius: 999, borderWidth: 1, borderColor: "rgba(255,255,255,0.3)", paddingVertical: 7, paddingHorizontal: 10, opacity: pressed ? 0.7 : 1 })}
          >
            <Text style={{ fontFamily: font.bodySemi, fontSize: 12, lineHeight: 12, color: "#FFFFFF" }}>Keep</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop the episode"
            onPress={task.stop}
            style={({ pressed }) => ({ borderRadius: 999, borderWidth: 1, borderColor: palette.orange, backgroundColor: palette.orange, paddingVertical: 7, paddingHorizontal: 10, opacity: pressed ? 0.8 : 1 })}
          >
            <Text style={{ fontFamily: font.bodySemi, fontSize: 12, lineHeight: 12, color: palette.ink }}>Stop</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ── Now playing, larger ──────────────────────────────────────────────────────

/**
 * The panel's top: the episode in the player (or, with nothing playing, the ready one the row offers). Its
 * thumbnail, title and "No. 14 · Piece 1 · Author", a big scrubber with chapter marks, elapsed / chapter /
 * remaining, ±15s and play or pause.
 */
function NowPlayingBlock({ itemId, onHeight }: { itemId: string; onHeight: (h: number) => void }) {
  const task = useEpisodeTask(itemId);
  const info = useEpisodeInfo(itemId);
  const time = usePlayTime(itemId);
  const inPlayer = usePlayerItem() === itemId;
  const phase = task.phase;
  const done = phase === "done";
  const duration = time.duration || task.episode?.durationSeconds || 0;
  const at = done ? duration : inPlayer ? time.at : 0;
  const chapters = task.episode?.chapters ?? [];
  const chapter = done
    ? "Played to the end"
    : !inPlayer
      ? "Ready · tap to play"
      : ([...chapters].reverse().find((c) => c.startSeconds <= at + 0.5)?.title ?? "The piece, out loud");
  const playing = phase === "playing";
  const canSkip = inPlayer && !done;
  const mono: TextStyle = { fontFamily: font.mono, fontSize: 10.5, lineHeight: 13, color: palette.pillMuted, fontVariant: ["tabular-nums"] };

  return (
    <View onLayout={(e) => onHeight(e.nativeEvent.layout.height)} style={{ gap: 5, paddingHorizontal: 16, paddingBottom: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ width: 40, height: 40, borderRadius: 9, overflow: "hidden", backgroundColor: "#F4F6FB" }}>
          {info?.artworkUrl && <Image source={{ uri: info.artworkUrl }} style={{ width: 40, height: 40 }} contentFit="cover" accessibilityIgnoresInvertColors />}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text numberOfLines={2} style={{ fontFamily: font.bodySemi, fontSize: 14, lineHeight: 17, color: "#FFFFFF" }}>
            {info?.title}
          </Text>
          {!!info?.line && (
            <Text numberOfLines={1} style={{ fontFamily: font.bodyMedium, fontSize: 11, lineHeight: 14, color: palette.pillMuted }}>
              {info.line}
            </Text>
          )}
        </View>
      </View>
      <BigScrubber itemId={itemId} at={at} duration={duration} marks={chapters.slice(1).map((c) => c.startSeconds)} enabled={canSkip} dragging={time.dragging} />
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginTop: -3 }}>
        <Text style={mono}>{fmtTime(at)}</Text>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, textAlign: "center", fontFamily: font.bodyMedium, fontSize: 11, lineHeight: 13, color: "#FFFFFF" }}>
          {chapter}
        </Text>
        <Text style={mono}>{done ? fmtTime(duration) : `-${fmtTime(Math.max(0, duration - at))}`}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 1 }}>
        <SkipButton back disabled={!canSkip} onPress={() => skipBy(itemId, -15)} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={playing ? "Pause" : done ? "Played to the end" : "Play"}
          disabled={done}
          onPress={task.toggle}
          style={({ pressed }) => ({ width: 42, height: 42, borderRadius: 21, backgroundColor: palette.blue, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.8 : 1 })}
        >
          <Svg width={20} height={20} viewBox="0 0 20 20">
            {playing ? (
              <>
                <Rect x={5} y={4} width={3.4} height={12} rx={1} fill="#FFFFFF" />
                <Rect x={11.6} y={4} width={3.4} height={12} rx={1} fill="#FFFFFF" />
              </>
            ) : done ? (
              <Path d="M4.6 10.4l3.6 3.6 7.2-7.6" fill="none" stroke="#FFFFFF" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <Path d="M6.4 3.8v12.4l9.8-6.2z" fill="#FFFFFF" />
            )}
          </Svg>
        </Pressable>
        <SkipButton disabled={!canSkip} onPress={() => skipBy(itemId, 15)} />
      </View>
    </View>
  );
}

function SkipButton({ back = false, disabled, onPress }: { back?: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={back ? "Back 15 seconds" : "Forward 15 seconds"}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.4 : pressed ? 0.7 : 1 })}
    >
      <Svg width={26} height={26} viewBox="0 0 28 28" fill="none">
        <Path d={back ? "M7.6 9.2A9 9 0 1 1 5 15.4" : "M20.4 9.2A9 9 0 1 0 23 15.4"} stroke="#FFFFFF" strokeWidth={1.8} strokeLinecap="round" />
        <Path d={back ? "M7.9 4.8v4.6h4.6" : "M20.1 4.8v4.6h-4.6"} stroke="#FFFFFF" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        <SvgText x={back ? 14.2 : 13.8} y={18.6} textAnchor="middle" fontFamily={font.bodySemi} fontSize={8.4} fill="#FFFFFF">
          15
        </SvgText>
      </Svg>
    </Pressable>
  );
}

/** The big scrubber: a 4pt track with a mark at each chapter, and a 13pt knob. Press anywhere on it, then drag. */
function BigScrubber({ itemId, at, duration, marks, enabled, dragging }: { itemId: string; at: number; duration: number; marks: number[]; enabled: boolean; dragging: boolean }) {
  const [width, setWidth] = useState(1);
  const p = duration > 0 ? clamp(at / duration) : 0;
  const to = (e: GestureResponderEvent) => clamp(e.nativeEvent.locationX / width) * duration;
  const live = enabled && duration > 0;
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Position in the episode"
      accessibilityValue={{ min: 0, max: Math.round(duration), now: Math.round(at), text: `${fmtTime(at)} of ${fmtTime(duration)}` }}
      accessibilityActions={live ? [{ name: "increment" }, { name: "decrement" }] : []}
      onAccessibilityAction={(e) => scrubTo(itemId, Math.max(0, Math.min(duration - 1, at + (e.nativeEvent.actionName === "increment" ? 10 : -10))), true)}
      onLayout={(e) => setWidth(Math.max(1, e.nativeEvent.layout.width))}
      onStartShouldSetResponder={() => live}
      onMoveShouldSetResponder={() => live}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => scrubTo(itemId, to(e))}
      onResponderMove={(e) => scrubTo(itemId, to(e))}
      onResponderRelease={(e) => scrubTo(itemId, to(e), true)}
      onResponderTerminate={() => scrubTo(itemId, null)}
      hitSlop={{ top: 8, bottom: 8 }}
      style={{ height: 16, marginTop: 2, justifyContent: "center" }}
    >
      <View style={{ height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.18)", pointerEvents: "none" }}>
        <View style={{ width: `${p * 100}%`, height: 4, borderRadius: 2, backgroundColor: palette.blueMid }} />
        {duration > 0 &&
          marks.map((m) => <View key={m} style={{ position: "absolute", top: 0, left: `${clamp(m / duration) * 100}%`, marginLeft: -1, width: 2, height: 4, backgroundColor: palette.pill }} />)}
      </View>
      <View
        style={{
          position: "absolute",
          left: `${p * 100}%`,
          marginLeft: -6.5,
          width: 13,
          height: 13,
          borderRadius: 6.5,
          backgroundColor: "#FFFFFF",
          boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
          transform: [{ scale: dragging ? 1.2 : 1 }],
          pointerEvents: "none",
        }}
      />
    </View>
  );
}
