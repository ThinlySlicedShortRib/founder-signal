import { useEffect, useId, useRef, useState } from "react";
import { type GestureResponderEvent, Pressable, Text, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { font, palette } from "@/components/onboarding/kit";
import { fmtTime, type Phase } from "@/lib/episode-task";
import { type EpisodeTask, scrubTo, setConfirmRect, useEpisodeTask, usePlayTime } from "@/lib/listen";
import { POLL_MS } from "@/lib/podcast";

/**
 * A Listen episode's status strip (async-status.html, "Pill grows a row"):
 * one component, two homes. In the pill it's the status row above the
 * controls (dark); in the article it's the Listen card's body (light). Both
 * read the same `EpisodeTask`, so they always agree.
 *
 * The icon on the left is the only thing that plays or pauses; the text
 * goes to the Listen card (`onOpen`). While making, ✕ asks "Stop this
 * episode?" in place, with Keep and Stop.
 */

/** The row's comfortable width; the pill is at least this wide while it carries a status. */
export const STATUS_W = 264;
export const STATUS_ROW_H = 44;

type Tone = "dark" | "light";
const TONES = {
  dark: { ink: "#FFFFFF", muted: palette.pillMuted, track: "rgba(255,255,255,0.18)", fill: palette.blueMid, knob: "#FFFFFF", x: "rgba(255,255,255,0.1)", ghost: "rgba(255,255,255,0.3)" },
  light: { ink: palette.ink, muted: palette.muted, track: "rgba(18,19,22,0.12)", fill: palette.blue, knob: palette.blue, x: "rgba(18,19,22,0.06)", ghost: "rgba(18,19,22,0.2)" },
} as const;

const EASE = Easing.bezier(0.2, 0.8, 0.2, 1);

// ── The progress ring ────────────────────────────────────────────────────────

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * Making an episode: a determinate ring that fills clockwise from 12 o'clock as
 * the worker reports progress. It eases to each polled number over the poll
 * interval, so it keeps moving between polls, and never goes backwards.
 * Self-contained so it's easy to restyle: size, stroke and colours are props.
 */
export function EpisodeProgressRing({
  progress,
  size = 22,
  stroke = 2,
  color = palette.blue,
  track = "rgba(43,75,255,0.18)",
  /** Ms to ease to a new number (the poll interval). */
  ease = POLL_MS,
}: {
  progress: number;
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
  ease?: number;
}) {
  const reduce = useReducedMotion();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const shown = useSharedValue(Math.max(0, Math.min(1, progress)));
  useEffect(() => {
    const target = Math.max(shown.get(), Math.max(0, Math.min(1, progress)));
    // Full (ready) closes quickly; otherwise it travels until the next poll lands.
    const ms = reduce ? 0 : target >= 1 ? 200 : ease;
    shown.set(withTiming(target, { duration: ms, easing: target >= 1 ? Easing.in(Easing.quad) : Easing.linear, reduceMotion: ReduceMotion.Never }));
  }, [progress, reduce, ease, shown]);
  const arc = useAnimatedProps(() => ({ strokeDashoffset: c * (1 - shown.get()) }));
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      <AnimatedCircle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c} ${c}`}
        animatedProps={arc}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </Svg>
  );
}

// ── The icon: ring while making, then a blue disc with play / pause / check ─────

function Glyph({ phase, size }: { phase: Phase; size: number }) {
  const s = size;
  const k = s / 32;
  if (phase === "playing")
    return (
      <Svg width={s} height={s} viewBox="0 0 32 32">
        <Rect x={11.4} y={10.5} width={3.3} height={11} rx={1} fill="#FFFFFF" />
        <Rect x={17.3} y={10.5} width={3.3} height={11} rx={1} fill="#FFFFFF" />
      </Svg>
    );
  if (phase === "done")
    return (
      <Svg width={s} height={s} viewBox="0 0 32 32">
        <Path d="M10.4 16.4l3.8 3.8 7.4-7.7" fill="none" stroke="#FFFFFF" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  if (phase === "failed")
    return (
      <Svg width={s} height={s} viewBox="0 0 32 32">
        <Rect x={14.6} y={8.8} width={2.8} height={9.6} rx={1.4} fill="#FFFFFF" />
        <Circle cx={16} cy={22.4} r={1.75} fill="#FFFFFF" />
      </Svg>
    );
  if (phase === "idle")
    return (
      <Svg width={s} height={s} viewBox="0 0 32 32">
        <Rect x={9.8} y={13} width={2.5} height={6} rx={1.25} fill="#FFFFFF" />
        <Rect x={14.75} y={9.5} width={2.5} height={13} rx={1.25} fill="#FFFFFF" />
        <Rect x={19.7} y={12} width={2.5} height={8} rx={1.25} fill="#FFFFFF" />
      </Svg>
    );
  return (
    <Svg width={s} height={s} viewBox="0 0 32 32" style={{ marginLeft: 1 * k }}>
      <Path d="M13 10.6v10.8l8.6-5.4z" fill="#FFFFFF" />
    </Svg>
  );
}

/**
 * The strip's left icon. Making: the progress ring. Ready: the ring closes, a blue
 * disc pops in with the play mark, and one soft ring goes out. After that, a disc
 * whose glyph swaps (play, pause, check, !). Stopped: a grey square on the track.
 */
function EpisodeIcon({ phase, progress, size, tone }: { phase: Phase; progress: number; size: number; tone: Tone }) {
  const reduce = useReducedMotion();
  const t = TONES[tone];
  const disc = useSharedValue(phase === "making" || phase === "stopped" ? 0 : 1);
  const glyph = useSharedValue(1);
  const pulse = useSharedValue(0);
  const was = useRef(phase);

  useEffect(() => {
    const from = was.current;
    was.current = phase;
    const round = phase !== "making" && phase !== "stopped";
    if (reduce) {
      disc.set(round ? 1 : 0);
      glyph.set(1);
      return;
    }
    const cfg = (ms: number) => ({ duration: ms, easing: EASE, reduceMotion: ReduceMotion.Never });
    if (from === "making" && phase === "ready") {
      // The ring closes (200ms, in the ring), then the disc fills with a little overshoot, the play mark lands and one ring goes out.
      disc.set(0);
      glyph.set(0);
      disc.set(withDelay(150, withSequence(withTiming(1.12, cfg(250)), withTiming(1, cfg(110)))));
      glyph.set(withDelay(280, withTiming(1, { duration: 260, easing: Easing.bezier(0.3, 1.4, 0.5, 1), reduceMotion: ReduceMotion.Never })));
      pulse.set(0);
      pulse.set(withDelay(330, withTiming(1, { duration: 700, easing: Easing.bezier(0.2, 0.7, 0.3, 1), reduceMotion: ReduceMotion.Never })));
      return;
    }
    disc.set(withTiming(round ? 1 : 0, cfg(180)));
    if (from !== phase && round) {
      glyph.set(0.6);
      glyph.set(withTiming(1, cfg(180)));
    }
  }, [phase, reduce, disc, glyph, pulse]);

  const discStyle = useAnimatedStyle(() => ({ opacity: Math.min(1, disc.get() * 4), transform: [{ scale: disc.get() }] }));
  const glyphStyle = useAnimatedStyle(() => ({ opacity: glyph.get() < 0.6 ? 0 : (glyph.get() - 0.6) / 0.4, transform: [{ scale: glyph.get() }, { rotate: `${(1 - glyph.get()) * -25}deg` }] }));
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.get() > 0 && pulse.get() < 1 ? 0.6 * (1 - pulse.get()) : 0, transform: [{ scale: 1 + pulse.get() }] }));

  const ring = Math.round(size * 0.78);
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {(phase === "making" || (phase === "ready" && !reduce)) && (
        <View style={{ position: "absolute" }}>
          <EpisodeProgressRing progress={phase === "making" ? progress : 1} size={ring} track={t.track} color={tone === "dark" ? palette.blueMid : palette.blue} />
        </View>
      )}
      {phase === "stopped" && (
        <Svg width={size} height={size} viewBox="0 0 32 32" style={{ position: "absolute" }}>
          <Circle cx={16} cy={16} r={12.5} fill="none" stroke={t.track} strokeWidth={2.6} />
          <Rect x={11.6} y={11.6} width={8.8} height={8.8} rx={2} fill={t.muted} />
        </Svg>
      )}
      <Animated.View
        style={[
          { position: "absolute", width: size, height: size, borderRadius: size / 2, backgroundColor: phase === "failed" ? palette.orange : palette.blue, alignItems: "center", justifyContent: "center" },
          discStyle,
        ]}
      >
        <Animated.View style={glyphStyle}>
          <Glyph phase={phase} size={size} />
        </Animated.View>
      </Animated.View>
      <Animated.View
        style={[{ position: "absolute", width: size, height: size, borderRadius: size / 2, borderWidth: 1.5, borderColor: tone === "dark" ? palette.blueMid : palette.blue, pointerEvents: "none" }, pulseStyle]}
      />
    </View>
  );
}

// ── The strip ────────────────────────────────────────────────────────────────

const ICON_LABEL: Record<Phase, string> = {
  idle: "Make the episode",
  making: "Making the episode",
  ready: "Play the episode",
  playing: "Pause",
  paused: "Play",
  failed: "Try again",
  done: "Listened",
  stopped: "Stopped",
};

export function EpisodeStrip({
  task,
  tone,
  card = false,
  onOpen,
}: {
  task: EpisodeTask;
  tone: Tone;
  /** The Listen card: after Stop it goes straight back to its start button. */
  card?: boolean;
  /** The text was tapped: go to the Listen card. */
  onOpen?: () => void;
}) {
  const reduce = useReducedMotion();
  const t = TONES[tone];
  const phase: Phase = card && task.phase === "stopped" ? "idle" : task.phase;
  const ico = tone === "dark" ? 28 : 32;
  const id = useId();
  const box = useRef<View>(null);

  // The confirm takes the row over in place; its box is where a tap counts as inside it.
  const confirming = task.confirming && phase === "making";
  useEffect(() => {
    if (!confirming) return setConfirmRect(id, null);
    box.current?.measureInWindow((x, y, w, h) => setConfirmRect(id, { x, y, w, h }));
    return () => setConfirmRect(id, null);
  }, [confirming, id]);
  const fade = useSharedValue(confirming ? 1 : 0);
  useEffect(() => {
    fade.set(withTiming(confirming ? 1 : 0, { duration: reduce ? 0 : 160, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.Never }));
  }, [confirming, reduce, fade]);
  const mainStyle = useAnimatedStyle(() => ({ opacity: 1 - fade.get(), transform: [{ translateY: -4 * fade.get() }] }));
  const confirmStyle = useAnimatedStyle(() => ({ opacity: fade.get(), transform: [{ translateY: 4 * (1 - fade.get()) }] }));

  const iconAction = { idle: task.start, ready: task.toggle, playing: task.toggle, paused: task.toggle, failed: task.start }[phase as string] as (() => void) | undefined;
  const timed = phase === "playing" || phase === "paused";

  let title = "";
  let sub = "";
  if (phase === "idle") [title, sub] = ["Make a two-host episode", "Ready in about a minute"];
  else if (phase === "making") [title, sub] = ["Making the episode…", task.step];
  else if (phase === "ready") [title, sub] = [`Episode ready · ${task.length}`, "Two hosts · tap to play"];
  else if (phase === "failed") title = "Couldn't make the episode";
  else if (phase === "done") [title, sub] = [`Listened · ${task.length}`, "Played to the end"];
  else if (phase === "stopped") title = "Stopped";

  return (
    <View ref={box} collapsable={false} style={{ flex: 1, alignSelf: "stretch", flexDirection: "row", alignItems: "center" }}>
      <Animated.View style={[{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10, pointerEvents: confirming ? "none" : "box-none" }, mainStyle]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ICON_LABEL[phase]}
          accessibilityState={{ disabled: !iconAction }}
          disabled={!iconAction}
          onPress={iconAction}
          hitSlop={8}
        >
          <EpisodeIcon phase={phase} progress={task.progress} size={ico} tone={tone} />
        </Pressable>
        <Pressable
          accessibilityRole={onOpen ? "button" : "text"}
          accessibilityLabel={[title, timed ? null : sub, phase === "making" ? task.eta : null].filter(Boolean).join(", ")}
          accessibilityHint={onOpen ? "Goes to the Listen card" : undefined}
          accessibilityLiveRegion="polite"
          disabled={!onOpen}
          onPress={onOpen}
          style={{ flex: 1, minWidth: 0, minHeight: 40, justifyContent: "center", gap: 2 }}
        >
          {/* A change of state lifts the text in (not play ↔ pause, which only swaps the icon). */}
          <Animated.View key={timed ? "timed" : phase} entering={reduce ? undefined : FadeInDown.duration(220).easing(EASE)} style={{ gap: 2 }}>
            {timed ? (
              <PlayingText task={task} tone={tone} />
            ) : (
              <>
                <Text
                  numberOfLines={phase === "failed" ? 2 : 1}
                  style={{ fontFamily: font.bodySemi, fontSize: 13, lineHeight: phase === "failed" ? 15 : 16, color: phase === "stopped" ? t.muted : t.ink }}
                >
                  {title}
                </Text>
                {!!sub && (
                  <View style={{ flexDirection: "row", alignItems: "center", height: 12 }}>
                    <Animated.Text
                      key={sub}
                      entering={reduce || phase !== "making" ? undefined : FadeIn.duration(220)}
                      numberOfLines={1}
                      style={{ flexShrink: 1, fontFamily: font.mono, fontSize: 10.5, lineHeight: 12, color: t.muted }}
                    >
                      {sub}
                    </Animated.Text>
                    {phase === "making" && <Text style={{ marginLeft: "auto", paddingLeft: 8, fontFamily: font.mono, fontSize: 10.5, lineHeight: 12, color: t.muted }}>{task.eta}</Text>}
                  </View>
                )}
              </>
            )}
          </Animated.View>
        </Pressable>
        {phase === "making" && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop making the episode"
            onPress={task.askStop}
            hitSlop={9}
            style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: t.x, alignItems: "center", justifyContent: "center" }}
          >
            <Svg width={12} height={12} viewBox="0 0 24 24">
              <Path d="M7 7l10 10M17 7L7 17" stroke={t.muted} strokeWidth={2.6} strokeLinecap="round" />
            </Svg>
          </Pressable>
        )}
        {phase === "failed" && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry making the episode"
            onPress={task.start}
            style={({ pressed }) => ({ borderRadius: 999, paddingVertical: 7, paddingHorizontal: 10, backgroundColor: palette.blue, opacity: pressed ? 0.8 : 1 })}
          >
            <Text style={{ fontFamily: font.bodySemi, fontSize: 12.5, lineHeight: 14, color: "#FFFFFF" }}>Retry</Text>
          </Pressable>
        )}
      </Animated.View>

      {/* Stop this episode? (in place, so the row's height never changes). Making goes on underneath. */}
      <Animated.View
        accessibilityViewIsModal={false}
        accessibilityElementsHidden={!confirming}
        importantForAccessibility={confirming ? "auto" : "no-hide-descendants"}
        style={[{ position: "absolute", left: tone === "dark" ? 4 : 0, right: 0, top: 0, bottom: 0, flexDirection: "row", alignItems: "center", gap: 5, pointerEvents: confirming ? "box-none" : "none" }, confirmStyle]}
      >
        <Text accessibilityRole="alert" numberOfLines={1} style={{ flex: 1, minWidth: 0, fontFamily: font.bodySemi, fontSize: 12.5, lineHeight: 15, color: t.ink }}>
          Stop this episode?
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Keep making it"
          onPress={task.keep}
          style={({ pressed }) => ({ borderRadius: 999, borderWidth: 1, borderColor: t.ghost, paddingVertical: 7, paddingHorizontal: 9, opacity: pressed ? 0.7 : 1 })}
        >
          <Text style={{ fontFamily: font.bodySemi, fontSize: 12, lineHeight: 14, color: t.ink }}>Keep</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop the episode"
          onPress={task.stop}
          style={({ pressed }) => ({ borderRadius: 999, borderWidth: 1, borderColor: palette.orange, backgroundColor: palette.orange, paddingVertical: 7, paddingHorizontal: 9, opacity: pressed ? 0.8 : 1 })}
        >
          <Text style={{ fontFamily: font.bodySemi, fontSize: 12, lineHeight: 14, color: palette.ink }}>Stop</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

/** Playing or paused: the chapter and the time, over a thin scrubber. Only this re-renders as the time ticks. */
function PlayingText({ task, tone }: { task: EpisodeTask; tone: Tone }) {
  const t = TONES[tone];
  const time = usePlayTime(task.itemId);
  const duration = time.duration || task.episode?.durationSeconds || 0;
  const chapters = task.episode?.chapters ?? [];
  const chapter = [...chapters].reverse().find((c) => c.startSeconds <= time.at + 0.5)?.title ?? "The piece, out loud";
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "baseline" }}>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontFamily: font.bodySemi, fontSize: 13, lineHeight: 16, color: t.ink }}>
          {chapter}
        </Text>
        <Text
          accessibilityLabel={`${fmtTime(time.at)} played, ${fmtTime(duration - time.at)} left`}
          style={{ paddingLeft: 8, fontFamily: font.mono, fontSize: 10.5, lineHeight: 16, color: t.muted, fontVariant: ["tabular-nums"] }}
        >
          {fmtTime(time.at)} · -{fmtTime(Math.max(0, duration - time.at))}
        </Text>
      </View>
      <Scrubber itemId={task.itemId} at={time.at} duration={duration} dragging={time.dragging} tone={tone} />
    </>
  );
}

/** A thin line with a knob: press anywhere on it, then drag. The knob grows a little while held. */
function Scrubber({ itemId, at, duration, dragging, tone }: { itemId: string; at: number; duration: number; dragging: boolean; tone: Tone }) {
  const t = TONES[tone];
  const [width, setWidth] = useState(1);
  const p = duration > 0 ? Math.max(0, Math.min(1, at / duration)) : 0;
  const to = (e: GestureResponderEvent) => Math.max(0, Math.min(1, e.nativeEvent.locationX / width)) * duration;
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Position in the episode"
      accessibilityValue={{ min: 0, max: Math.round(duration), now: Math.round(at), text: `${fmtTime(at)} of ${fmtTime(duration)}` }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => scrubTo(itemId, Math.max(0, Math.min(duration - 1, at + (e.nativeEvent.actionName === "increment" ? 10 : -10))), true)}
      onLayout={(e) => setWidth(Math.max(1, e.nativeEvent.layout.width))}
      onStartShouldSetResponder={() => duration > 0}
      onMoveShouldSetResponder={() => duration > 0}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => scrubTo(itemId, to(e))}
      onResponderMove={(e) => scrubTo(itemId, to(e))}
      onResponderRelease={(e) => scrubTo(itemId, to(e), true)}
      onResponderTerminate={() => scrubTo(itemId, null)}
      hitSlop={{ top: 10, bottom: 10 }}
      style={{ height: 12, justifyContent: "center" }}
    >
      <View style={{ height: 3, borderRadius: 2, backgroundColor: t.track, pointerEvents: "none" }}>
        <View style={{ width: `${p * 100}%`, height: 3, borderRadius: 2, backgroundColor: t.fill }} />
      </View>
      <View
        style={{
          position: "absolute",
          left: `${p * 100}%`,
          marginLeft: -4.5,
          width: 9,
          height: 9,
          borderRadius: 4.5,
          backgroundColor: t.knob,
          transform: [{ scale: dragging ? 1.45 : 1 }],
          pointerEvents: "none",
        }}
      />
    </View>
  );
}

/** The pill's status row: the strip at its comfortable width, under which the controls sit. */
export function EpisodeStatusRow({ itemId, onOpen }: { itemId: string; onOpen: () => void }) {
  const task = useEpisodeTask(itemId);
  return (
    <View style={{ height: STATUS_ROW_H, paddingLeft: 10, paddingRight: 9, flexDirection: "row", alignItems: "center" }}>
      <EpisodeStrip task={task} tone="dark" onOpen={onOpen} />
    </View>
  );
}
