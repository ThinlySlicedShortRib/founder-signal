import { usePathname } from "expo-router";
import { useEffect, useId, useRef, useState } from "react";
import { Pressable, Text, type TextStyle, View } from "react-native";
import Animated, { Easing, ReduceMotion, type SharedValue, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { MakingLine, ProgressRing, useShownPhase } from "@/components/letter/EpisodeStatus";
import { TINTS } from "@/components/letter/Photo";
import { font, palette } from "@/components/onboarding/kit";
import { PagerIcon } from "@/components/pager/icons";
import { Mono } from "@/components/pager/PagerScreen";
import { fmtTime, type Phase, stepOf } from "@/lib/episode-task";
import { useTodayLetter } from "@/lib/letters";
import { type EpisodeTask, setConfirmRect, useEpisodeTask, usePlayerItem, usePlayTime } from "@/lib/listen";
import type { NowPlayingMeta } from "@/lib/now-playing";
import { goToNowPlaying } from "@/lib/now-playing-nav";
import { groupOf, type LibraryEpisode, type PodcastGroup, resumeAt, rowMeta } from "@/lib/podcast-library";
import { usePodcastLibrary } from "@/lib/podcasts";

/**
 * The Library's Podcasts tab (library-podcasts.html, the list layout): every
 * episode this reader has asked for or played, grouped by where they are with
 * it (In progress, New, Listened), each group newest first. A row is about
 * 70pt: a round state button, the piece's title, "Author · No. 13 · Piece 1"
 * and a state line. Play goes through the app's one player, so the pill's row
 * carries it from here; tapping the text opens the piece at its Listen card.
 *
 * `groups` is taken as the tab opens, so rows don't jump between groups while
 * it's open; they regroup next time.
 */

const GROUPS: [PodcastGroup, string][] = [
  ["progress", "In progress"],
  ["new", "New"],
  ["done", "Listened"],
];

export function PodcastsTab({ groups }: { groups: Record<string, PodcastGroup> }) {
  const list = usePodcastLibrary();
  const playerItem = usePlayerItem();
  const today = useTodayLetter();
  if (!list.length) return <PodcastsEmpty />;
  // A row added while the tab is open (not in the snapshot) goes where it belongs now.
  const sections = GROUPS.map(([g, label]) => ({ g, label, rows: list.filter((e) => (groups[e.itemId] ?? groupOf(e)) === g) })).filter((x) => x.rows.length);

  return (
    <View>
      {sections.map(({ g, label, rows }, gi) => {
        return (
          <View key={g} accessibilityLabel={label}>
            <Mono style={{ marginTop: gi === 0 ? 4 : 14, marginBottom: 2, paddingHorizontal: 4 }}>{label}</Mono>
            {rows.map((e, i) => (
              <PodcastRow
                key={e.itemId}
                entry={e}
                tint={TINTS[list.indexOf(e) % 3]!}
                // The hairline between rows, gone around the one in the player (it has its own highlight).
                rule={i > 0 && e.itemId !== playerItem && rows[i - 1]!.itemId !== playerItem}
                todayId={today.data?.id ?? null}
              />
            ))}
          </View>
        );
      })}
    </View>
  );
}

// ── A row ───────────────────────────────────────────────────────────────────

type RowState = "loading" | "ready" | "partial" | "playing" | "paused" | "listened" | "making" | "failed";

function rowState(phase: Phase, task: EpisodeTask, e: LibraryEpisode): RowState {
  switch (phase) {
    case "making":
    case "stopped":
      return "making";
    case "playing":
    case "paused":
      return phase;
    case "done":
      return "listened";
    case "failed":
      return "failed";
    case "ready":
      return e.listened ? "listened" : resumeAt(e) > 0 ? "partial" : "ready";
    case "idle":
      // Gone from the server (or never made): it can be asked for again.
      return task.loaded ? "failed" : "loading";
  }
}

const BUTTON_LABEL: Record<RowState, string> = {
  loading: "Loading",
  ready: "Play",
  partial: "Resume",
  paused: "Resume",
  playing: "Pause",
  listened: "Play again",
  failed: "Try again",
  making: "Being made",
};

const BTN = 40;

function PodcastRow({ entry, tint, rule, todayId }: { entry: LibraryEpisode; tint: string; rule: boolean; todayId: string | null }) {
  const task = useEpisodeTask(entry.itemId);
  const reduce = useReducedMotion();
  const pathname = usePathname();
  // While the ring closes on a just-made episode, the row still shows it being made.
  const phase = useShownPhase(task.phase, reduce);
  const closing = phase === "making" && task.phase === "ready";
  const s = rowState(phase, task, entry);
  const duration = task.episode?.durationSeconds || entry.duration;
  const [step, setStep] = useState(() => stepOf(task.progress));

  // The Stop confirm takes the row over in place; a tap outside it counts as Keep (the screen's capture).
  const confirming = task.confirming && s === "making";
  const quiet = useSharedValue(confirming);
  const id = useId();
  const box = useRef<View>(null);
  useEffect(() => {
    quiet.set(confirming);
    if (!confirming) return setConfirmRect(id, null);
    box.current?.measureInWindow((x, y, w, h) => setConfirmRect(id, { x, y, w, h }));
    return () => setConfirmRect(id, null);
  }, [confirming, id, quiet]);
  const fade = useSharedValue(confirming ? 1 : 0);
  useEffect(() => {
    fade.set(withTiming(confirming ? 1 : 0, { duration: reduce ? 0 : 160, easing: Easing.inOut(Easing.ease), reduceMotion: ReduceMotion.Never }));
  }, [confirming, reduce, fade]);
  const mainStyle = useAnimatedStyle(() => ({ opacity: 1 - fade.get() }));
  const confirmStyle = useAnimatedStyle(() => ({ opacity: fade.get(), transform: [{ translateY: reduce ? 0 : 4 * (1 - fade.get()) }] }));

  const action = { ready: task.toggle, partial: task.toggle, paused: task.toggle, playing: task.toggle, listened: task.toggle, failed: task.start }[s as string] as (() => void) | undefined;
  const highlight = s === "playing" || s === "paused";
  const meta = rowMeta(entry);

  const open = () => {
    const home: NowPlayingMeta["home"] = entry.home.kind === "letter" ? { ...entry.home, today: entry.home.letterId === todayId } : entry.home;
    goToNowPlaying({ itemId: entry.itemId, title: entry.title, home, subtitle: "", artworkUrl: null }, pathname);
  };

  let label = "";
  if (s === "ready") label = `${task.length} · Two hosts`;
  else if (s === "partial") label = `${fmtTime(Math.max(0, duration - entry.at))} left`;
  else if (s === "listened") label = `Listened · ${task.length}`;
  else if (s === "failed") label = "Couldn't make it";

  const rowBg = highlight ? palette.blueTint : palette.ground;
  return (
    <View ref={box} collapsable={false} style={{ borderRadius: 16, backgroundColor: rowBg }}>
      {rule && <View style={{ position: "absolute", top: 0, left: 60, right: 8, height: 1, backgroundColor: palette.rule }} />}
      <Animated.View style={[{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11, paddingHorizontal: 8, pointerEvents: confirming ? "none" : "box-none" }, mainStyle]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${BUTTON_LABEL[s]}: ${entry.title}`} accessibilityState={{ disabled: !action }} disabled={!action} onPress={action} hitSlop={6}>
          <StateButton state={s} tint={tint} progress={closing ? 1 : task.progress} run={task.episode?.id ?? "asked"} stopped={phase === "stopped"} quiet={quiet} onStep={setStep} />
        </Pressable>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={[entry.title, meta, s === "making" ? `Being made, ${task.eta}` : label].filter(Boolean).join(". ")}
          accessibilityHint="Opens the piece at its Listen card"
          onPress={open}
          style={({ pressed }) => ({ flex: 1, minWidth: 0, gap: 1, opacity: (s === "listened" ? 0.55 : 1) * (pressed ? 0.7 : 1) })}
        >
          <Text numberOfLines={2} style={{ fontFamily: font.bodySemi, fontSize: 14.5, lineHeight: 18.5, color: palette.ink }}>
            {entry.title}
          </Text>
          {!!meta && (
            <Text numberOfLines={1} style={{ fontFamily: font.body, fontSize: 12, lineHeight: 16, color: palette.muted }}>
              {meta}
            </Text>
          )}
          <View style={{ marginTop: 3, minHeight: 15, flexDirection: "row", alignItems: "center", gap: 6 }}>
            {s === "making" ? (
              <MakingLine step={step} eta={task.eta} tone="light" quiet={confirming} />
            ) : s === "playing" || s === "paused" ? (
              <PlayingLine itemId={entry.itemId} playing={s === "playing"} fallback={duration} />
            ) : (
              <>
                <Text numberOfLines={1} style={[STATE, { flexShrink: 1, color: s === "failed" ? palette.no : palette.muted }]}>
                  {label}
                </Text>
                {s === "partial" && <ProgressLine p={duration ? entry.at / duration : 0} />}
              </>
            )}
          </View>
        </Pressable>
        {s === "making" && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop making this episode"
            onPress={task.askStop}
            hitSlop={9}
            style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: "rgba(18,19,22,0.06)", alignItems: "center", justifyContent: "center" }}
          >
            <Svg width={12} height={12} viewBox="0 0 24 24">
              <Path d="M7 7l10 10M17 7L7 17" stroke={palette.muted} strokeWidth={2.6} strokeLinecap="round" />
            </Svg>
          </Pressable>
        )}
        {s === "failed" && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Retry making the episode: ${entry.title}`}
            onPress={task.start}
            style={({ pressed }) => ({ borderRadius: 999, paddingVertical: 8, paddingHorizontal: 11, backgroundColor: palette.blue, opacity: pressed ? 0.8 : 1 })}
          >
            <Text style={{ fontFamily: font.bodySemi, fontSize: 12.5, lineHeight: 14, color: "#FFFFFF" }}>Retry</Text>
          </Pressable>
        )}
      </Animated.View>

      {/* Stop this episode? In place, so the row's height never changes. Making goes on underneath. */}
      <Animated.View
        accessibilityElementsHidden={!confirming}
        importantForAccessibility={confirming ? "auto" : "no-hide-descendants"}
        style={[
          { position: "absolute", left: 12, right: 8, top: 0, bottom: 0, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: rowBg, pointerEvents: confirming ? "box-none" : "none" },
          confirmStyle,
        ]}
      >
        <Text accessibilityRole="alert" numberOfLines={1} style={{ flex: 1, minWidth: 0, fontFamily: font.bodySemi, fontSize: 12.5, lineHeight: 15, color: palette.ink }}>
          Stop this episode?
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Keep making it"
          onPress={task.keep}
          style={({ pressed }) => ({ borderRadius: 999, borderWidth: 1, borderColor: "rgba(18,19,22,0.2)", paddingVertical: 7, paddingHorizontal: 10, opacity: pressed ? 0.7 : 1 })}
        >
          <Text style={{ fontFamily: font.bodySemi, fontSize: 12, lineHeight: 12, color: palette.ink }}>Keep</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop the episode"
          onPress={task.stop}
          style={({ pressed }) => ({
            borderRadius: 999,
            borderWidth: 1,
            borderColor: palette.orange,
            backgroundColor: palette.orange,
            paddingVertical: 7,
            paddingHorizontal: 10,
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <Text style={{ fontFamily: font.bodySemi, fontSize: 12, lineHeight: 12, color: palette.ink }}>Stop</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const STATE: TextStyle = { fontFamily: font.bodyMedium, fontSize: 11.5, lineHeight: 15, fontVariant: ["tabular-nums"] };

/** Playing or paused: moving bars (playing), the time left from the player, and the progress line. Only this re-renders with the time. */
function PlayingLine({ itemId, playing, fallback }: { itemId: string; playing: boolean; fallback: number }) {
  const t = usePlayTime(itemId);
  const duration = t.duration || fallback;
  const left = fmtTime(Math.max(0, duration - t.at));
  return (
    <>
      {playing && <Bars />}
      <Text numberOfLines={1} style={[STATE, { flexShrink: 1, color: playing ? palette.blue : palette.muted }]}>
        {playing ? "Playing" : "Paused"} · {left} left
      </Text>
      <ProgressLine p={duration ? t.at / duration : 0} />
    </>
  );
}

function ProgressLine({ p }: { p: number }) {
  return (
    <View style={{ width: 44, height: 3, borderRadius: 2, backgroundColor: "rgba(18,19,22,0.12)", overflow: "hidden" }}>
      <View style={{ width: `${Math.max(0, Math.min(1, p)) * 100}%`, height: 3, borderRadius: 2, backgroundColor: palette.blue }} />
    </View>
  );
}

/** Three small bars that move while it plays (still, at rest heights, with Reduce Motion). */
function Bars() {
  return (
    <View style={{ height: 10, flexDirection: "row", alignItems: "flex-end", gap: 2 }}>
      <Bar ms={900} from={0.3} still={1} />
      <Bar ms={700} from={0.5} still={0.6} />
      <Bar ms={1050} from={0.4} still={0.8} />
    </View>
  );
}

function Bar({ ms, from, still }: { ms: number; from: number; still: number }) {
  const reduce = useReducedMotion();
  const k = useSharedValue(reduce ? still : from);
  useEffect(() => {
    if (reduce) return k.set(still);
    k.set(from);
    k.set(withRepeat(withTiming(1, { duration: ms, easing: Easing.inOut(Easing.ease), reduceMotion: ReduceMotion.Never }), -1, true));
  }, [reduce, k, ms, from, still]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleY: Math.max(0.3, k.get()) }] }));
  return <Animated.View style={[{ width: 2.5, height: 10, borderRadius: 1, backgroundColor: palette.blue, transformOrigin: "bottom" }, style]} />;
}

/** The round state button: play, pause, a check (listened), the ring (being made) or an orange mark (failed). */
function StateButton({
  state,
  tint,
  progress,
  run,
  stopped,
  quiet,
  onStep,
}: {
  state: RowState;
  tint: string;
  progress: number;
  run: string;
  stopped: boolean;
  quiet: SharedValue<boolean>;
  onStep: (step: number) => void;
}) {
  const bg = state === "making" || state === "listened" ? tint : state === "failed" ? palette.orange : state === "loading" ? palette.grey : palette.blue;
  return (
    <View style={{ width: BTN, height: BTN, borderRadius: BTN / 2, backgroundColor: bg, alignItems: "center", justifyContent: "center" }}>
      {state === "making" ? (
        <ProgressRing key={run} progress={progress} size={BTN} tone="light" stopped={stopped} quiet={quiet} onStep={onStep} />
      ) : state === "loading" ? null : (
        <Svg width={BTN} height={BTN} viewBox="0 0 40 40">
          {state === "playing" ? (
            <>
              <Rect x={14.2} y={13} width={4} height={14} rx={1.2} fill="#FFFFFF" />
              <Rect x={21.8} y={13} width={4} height={14} rx={1.2} fill="#FFFFFF" />
            </>
          ) : state === "listened" ? (
            <Path d="M13.5 20.5l4.5 4.5 8.5-9" fill="none" stroke={palette.muted} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
          ) : state === "failed" ? (
            <>
              <Rect x={18.3} y={10.5} width={3.4} height={12.5} rx={1.7} fill="#FFFFFF" />
              <Circle cx={20} cy={28} r={2.1} fill="#FFFFFF" />
            </>
          ) : (
            <Path d="M16.2 13.2v13.6l10.6-6.8z" fill="#FFFFFF" />
          )}
        </Svg>
      )}
    </View>
  );
}

// ── Empty ───────────────────────────────────────────────────────────────────

/** Before any episode: a small headphones drawing in the app's tints, and how to make one. */
function PodcastsEmpty() {
  return (
    <View style={{ alignItems: "center", gap: 10, paddingTop: 30, paddingHorizontal: 8 }}>
      <Svg width={150} height={112} viewBox="0 0 150 112">
        <Circle cx={66} cy={60} r={46} fill={palette.blueCard} />
        <Path d="M40 70V60a26 26 0 0 1 52 0v10" fill="none" stroke={palette.blue} strokeWidth={6} strokeLinecap="round" />
        <Rect x={34} y={64} width={15} height={24} rx={5} fill={palette.blue} />
        <Rect x={83} y={64} width={15} height={24} rx={5} fill={palette.blue} />
        <Rect x={102} y={16} width={40} height={24} rx={12} fill={palette.tints[1]} />
        <Circle cx={113} cy={28} r={2.4} fill={palette.droppedInk} />
        <Circle cx={122} cy={28} r={2.4} fill={palette.droppedInk} />
        <Circle cx={131} cy={28} r={2.4} fill={palette.droppedInk} />
        <Rect x={108} y={46} width={32} height={20} rx={10} fill={palette.tints[2]} />
        <Circle cx={118} cy={56} r={2.2} fill={palette.muted} />
        <Circle cx={130} cy={56} r={2.2} fill={palette.muted} />
        <Circle cx={18} cy={26} r={6} fill={palette.orange} />
      </Svg>
      <Text accessibilityRole="header" style={{ marginTop: 6, fontFamily: font.display, fontSize: 22, lineHeight: 26, letterSpacing: -0.44, color: palette.ink }}>
        No episodes yet
      </Text>
      <Text style={{ textAlign: "center", fontFamily: font.body, fontSize: 15, lineHeight: 22, color: palette.promptInk }}>
        Tap the headphones on any piece to make a short two-host episode. It takes about a minute, and it&apos;ll be kept here.
      </Text>
      <View style={{ marginTop: 6, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingLeft: 8, paddingRight: 14, borderRadius: 999, backgroundColor: palette.rule }}>
        <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: "#25272B", alignItems: "center", justifyContent: "center" }}>
          <PagerIcon name="headphones" size={16} color="#FFFFFF" />
        </View>
        <Text style={{ fontFamily: font.body, fontSize: 13, color: palette.promptInk }}>
          Look for this beside <Text style={{ fontFamily: font.bodySemi, color: palette.ink }}>Read article</Text>
        </Text>
      </View>
    </View>
  );
}
