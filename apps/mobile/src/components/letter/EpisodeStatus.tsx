import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import { usePathname } from "expo-router";
import { useEffect, useId, useRef, useState } from "react";
import { type GestureResponderEvent, Platform, Pressable, StyleSheet, Text, type TextStyle, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  Keyframe,
  ReduceMotion,
  type SharedValue,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type WithTimingConfig,
} from "react-native-reanimated";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import { font, palette } from "@/components/onboarding/kit";
import { PillStatusSlot } from "@/components/pager/Pill";
import { fmtTime, type Phase, STEP_ENDS, STEPS, stepOf } from "@/lib/episode-task";
import { type EpisodeTask, nowPlaying, rowFolded, scrubTo, setConfirmRect, useEpisodeTask, useNowPlaying, usePlayTime } from "@/lib/listen";
import { goToNowPlaying } from "@/lib/now-playing-nav";
import { POLL_MS } from "@/lib/podcast";

/**
 * A Listen episode's status strip (async-status.html, "Pill grows a row"):
 * one component, two homes. In the pill it's the status row above the
 * controls (dark); in the article it's the Listen card's body (light). Both
 * read the same `EpisodeTask`, so they always agree.
 *
 * The icon on the left is the only thing that plays or pauses; the text
 * goes to the Listen card (`onOpen`). While making, a ring fills with the
 * worker's real progress, beside the step and an estimate of the time left
 * ("Recording voices · ~35s left"); ✕ asks "Stop this episode?" in place,
 * with Keep and Stop. When the ring closes it grows into the play button.
 */

/** The row's height inside the pill (the pill's status area is this plus its 1pt hairline). */
export const STATUS_ROW_H = 43;

type Tone = "dark" | "light";
const TONES = {
  dark: {
    ink: "#FFFFFF",
    muted: palette.pillMuted,
    track: "rgba(255,255,255,0.18)",
    tick: "rgba(255,255,255,0.5)",
    fill: palette.blueMid,
    shine: "rgba(255,255,255,0.4)",
    knob: "#FFFFFF",
    x: "rgba(255,255,255,0.1)",
    ghost: "rgba(255,255,255,0.3)",
    pulse: palette.blueMid,
  },
  light: {
    ink: palette.ink,
    muted: palette.muted,
    track: "rgba(18,19,22,0.12)",
    tick: "rgba(18,19,22,0.34)",
    fill: palette.blue,
    shine: "#A9ADB6",
    knob: palette.blue,
    x: "rgba(18,19,22,0.06)",
    ghost: "rgba(18,19,22,0.2)",
    pulse: palette.blue,
  },
} as const;

const EASE = Easing.bezier(0.2, 0.8, 0.2, 1);
const NEVER = ReduceMotion.Never;
const timing = (ms: number, easing: WithTimingConfig["easing"] = EASE): WithTimingConfig => ({ duration: ms, easing, reduceMotion: NEVER });

/** The ring is the same size in every home: 21pt across its centre line, with a 2pt stroke. */
const RING_R = 10.5;
const RING_SW = 2;
const TICK_W = 1.2;
/** The ring closes this fast once the episode is ready, then holds closed for a beat before it becomes the play button. */
const CLOSE_MS = 260;
/** The beat as the ring crosses a tick (built here: the reaction that plays it runs on the UI thread). */
const BEAT: WithTimingConfig = { duration: 380, easing: Easing.bezier(0.3, 0.9, 0.4, 1), reduceMotion: ReduceMotion.Never };
const HOLD_MS = 200;

// Text motion (the mock's WAAPI keyframes).
const STATE_IN = new Keyframe({ 0: { opacity: 0, transform: [{ translateY: 5 }] }, 100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE } }).duration(220);
const STEP_IN = new Keyframe({ 0: { opacity: 0, transform: [{ translateY: 4 }] }, 100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE } }).duration(220);

/** True after the first render: children that appear later animate in, the first look doesn't. */
function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return mounted;
}

const stepAt = (v: number) => {
  "worklet";
  return v >= STEP_ENDS[1] ? 2 : v >= STEP_ENDS[0] ? 1 : 0;
};

// ── The progress ring ────────────────────────────────────────────────────────

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * Making an episode: a determinate ring that fills clockwise from 12 o'clock as the worker reports progress,
 * with faint ticks where the script and the voices end. It eases to each polled number over the poll
 * interval, so it keeps moving between polls, and never goes backwards. As it crosses a tick it gives one
 * small beat and tells the strip (`onStep`), so the step text changes at that moment.
 */
function ProgressRing({
  progress,
  size,
  tone,
  stopped,
  quiet,
  onStep,
}: {
  progress: number;
  size: number;
  tone: Tone;
  /** Stopped: the bare track, around a small square. */
  stopped: boolean;
  /** No beat while the Stop confirm covers it. */
  quiet: SharedValue<boolean>;
  onStep: (step: number) => void;
}) {
  const reduce = useReducedMotion();
  const t = TONES[tone];
  const c = 2 * Math.PI * RING_R;
  const mid = size / 2;
  const shown = useSharedValue(Math.max(0, Math.min(1, progress)));
  const beat = useSharedValue(1);

  // A new ring starts the step text where it starts.
  useEffect(() => onStep(stepOf(shown.get())), [onStep, shown]);

  useEffect(() => {
    const target = Math.max(shown.get(), Math.max(0, Math.min(1, progress)));
    if (target === shown.get()) return;
    // Ready closes it quickly; otherwise it travels until the next poll lands.
    shown.set(reduce ? target : withTiming(target, target >= 1 ? timing(CLOSE_MS) : timing(POLL_MS, Easing.linear)));
  }, [progress, reduce, shown]);

  useAnimatedReaction(
    () => stepAt(shown.get()),
    (step, prev) => {
      if (prev == null || step === prev) return;
      scheduleOnRN(onStep, step);
      if (reduce || quiet.get()) return;
      beat.set(0);
      beat.set(withTiming(1, BEAT));
    },
    [reduce, onStep],
  );

  const arc = useAnimatedProps(() => ({ strokeDashoffset: c * (1 - shown.get()), strokeOpacity: shown.get() > 0.004 ? 1 : 0 }));
  const beatStyle = useAnimatedStyle(() => ({ transform: [{ scale: interpolate(beat.get(), [0, 0.35, 1], [1, 1.14, 1]) }] }));

  const ticks = STEP_ENDS.map((at) => {
    const a = at * 2 * Math.PI - Math.PI / 2;
    const [cos, sin] = [Math.cos(a), Math.sin(a)];
    const [r0, r1] = [RING_R - RING_SW / 2, RING_R + RING_SW / 2];
    return <Line key={at} x1={mid + cos * r0} y1={mid + sin * r0} x2={mid + cos * r1} y2={mid + sin * r1} stroke={t.tick} strokeWidth={TICK_W} />;
  });
  const sq = (8.8 / 32) * size;

  return (
    <Animated.View style={beatStyle}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Circle cx={mid} cy={mid} r={RING_R} fill="none" stroke={t.track} strokeWidth={RING_SW} />
        {stopped ? (
          <Rect x={mid - sq / 2} y={mid - sq / 2} width={sq} height={sq} rx={(2 / 32) * size} fill={t.muted} />
        ) : (
          <>
            {ticks}
            <AnimatedCircle
              cx={mid}
              cy={mid}
              r={RING_R}
              fill="none"
              stroke={palette.blue}
              strokeWidth={RING_SW}
              strokeLinecap="round"
              strokeDasharray={`${c} ${c}`}
              animatedProps={arc}
              transform={`rotate(-90 ${mid} ${mid})`}
            />
          </>
        )}
      </Svg>
    </Animated.View>
  );
}

// ── The icon: ring while making, then a blue disc with play / pause / check ─────

/** The check's length in the 32-unit box, for drawing it in. */
const CHECK_LEN = 16.1;

function Glyph({ phase, size, draw }: { phase: Phase; size: number; draw: SharedValue<number> }) {
  const s = size;
  const check = useAnimatedProps(() => ({ strokeDashoffset: CHECK_LEN * (1 - draw.get()) }));
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
        <AnimatedPath
          d="M10.4 16.4l3.8 3.8 7.4-7.7"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={`${CHECK_LEN} ${CHECK_LEN}`}
          animatedProps={check}
        />
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
    <Svg width={s} height={s} viewBox="0 0 32 32">
      <Path d="M13 10.6v10.8l8.6-5.4z" fill="#FFFFFF" />
    </Svg>
  );
}

/** How the glyph comes in: not at all, popping (.6 → 1), or landing with a little turn (the play mark, as the ring becomes the button). */
const GLYPH_STILL = 0;
const GLYPH_POP = 1;
const GLYPH_LAND = 2;

/**
 * The strip's left icon. Making: the progress ring. Ready: the closed ring fills in from its own edge and grows
 * into the blue play button, so it reads as the same circle; the play mark lands and one small ring goes out.
 * After that, a disc whose glyph swaps (play, pause, check, !). Stopped: a grey square in the bare track.
 */
function EpisodeIcon({
  phase,
  run,
  progress,
  size,
  tone,
  quiet,
  onStep,
}: {
  phase: Phase;
  /** Which episode the ring is for: a new one starts a new ring (it never goes backwards within one). */
  run: string;
  progress: number;
  size: number;
  tone: Tone;
  quiet: SharedValue<boolean>;
  onStep: (step: number) => void;
}) {
  const reduce = useReducedMotion();
  const t = TONES[tone];
  const ringy = phase === "making" || phase === "stopped";
  /** The ring's outer edge as a share of the disc, which the disc grows from. */
  const s0 = (RING_R + RING_SW / 2) / (size / 2);

  const ringOp = useSharedValue(ringy ? 1 : 0);
  /** The ring growing into the button: 0 → 1 while it does, -1 otherwise. */
  const grow = useSharedValue(-1);
  const discOp = useSharedValue(ringy ? 0 : 1);
  const discScale = useSharedValue(1);
  /** The disc filling in from the ring's edge: 0 → 1 while it does, -1 otherwise. */
  const fill = useSharedValue(-1);
  const glyphK = useSharedValue(1);
  const glyphMode = useSharedValue(GLYPH_STILL);
  const draw = useSharedValue(1);
  const out = useSharedValue(0);
  const shake = useSharedValue(0);
  const was = useRef(phase);
  /** The ring stays drawn while it grows into the button. */
  const [ringOn, setRingOn] = useState(ringy);
  if (ringy && !ringOn) setRingOn(true);

  useEffect(() => {
    const from = was.current;
    was.current = phase;
    if (from === phase) return;
    const ringNow = phase === "making" || phase === "stopped";
    const ringThen = from === "making" || from === "stopped";
    grow.set(-1);
    fill.set(-1);
    if (reduce) {
      ringOp.set(ringNow ? 1 : 0);
      discOp.set(ringNow ? 0 : 1);
      discScale.set(1);
      glyphMode.set(GLYPH_STILL);
      draw.set(1);
      if (!ringNow) {
        const id = setTimeout(() => setRingOn(false), 0);
        return () => clearTimeout(id);
      }
      return;
    }
    // The plain change of state: ring and disc swap with a quick fade.
    ringOp.set(withTiming(ringNow ? 1 : 0, timing(140)));
    discOp.set(withTiming(ringNow ? 0 : 1, timing(140)));
    discScale.set(1);
    let ringGone = 140;

    if (from === "making" && phase === "ready") {
      // The closed ring grows to the button's size as it fades; the disc fills in from the ring's edge, overshoots a touch and settles.
      ringOp.set(0);
      grow.set(0);
      grow.set(withTiming(1, timing(260)));
      discOp.set(1);
      fill.set(0);
      fill.set(withTiming(1, timing(400)));
      glyphMode.set(GLYPH_LAND);
      glyphK.set(0);
      glyphK.set(withDelay(220, withTiming(1, timing(260, Easing.bezier(0.3, 1.4, 0.5, 1))), NEVER));
      out.set(0);
      out.set(withDelay(260, withTiming(1, timing(620, Easing.bezier(0.2, 0.7, 0.3, 1))), NEVER));
      ringGone = 260;
    } else if (phase === "done") {
      // Listened: the check draws itself in on a disc that bounces up.
      glyphMode.set(GLYPH_STILL);
      draw.set(0);
      draw.set(withDelay(60, withTiming(1, timing(340)), NEVER));
      discScale.set(0.85);
      discScale.set(withTiming(1, timing(300, Easing.bezier(0.3, 1.5, 0.5, 1))));
    } else if (phase === "failed") {
      glyphMode.set(GLYPH_STILL);
      const k = (x: number) => withTiming(x, timing(80, Easing.out(Easing.quad)));
      shake.set(withSequence(k(-3), k(3), k(-1.5), k(0)));
    } else if (!ringNow && from !== "making") {
      glyphMode.set(GLYPH_POP);
      glyphK.set(0);
      glyphK.set(withTiming(1, timing(180)));
    } else glyphMode.set(GLYPH_STILL);

    if (!ringNow) {
      const id = setTimeout(() => setRingOn(false), (ringThen ? ringGone : 0) + 40);
      return () => clearTimeout(id);
    }
  }, [phase, reduce, ringOp, grow, discOp, discScale, fill, glyphK, glyphMode, draw, out, shake]);

  const ringStyle = useAnimatedStyle(() => {
    const g = grow.get();
    const growing = g >= 0 && g < 1;
    return { opacity: growing ? 1 - g : ringOp.get(), transform: [{ scale: growing ? 1 + (1 / s0 - 1) * g : 1 }] };
  });
  const discStyle = useAnimatedStyle(() => {
    const k = fill.get();
    if (k >= 0 && k < 1)
      return { opacity: interpolate(k, [0, 0.25], [0, 1], "clamp"), transform: [{ scale: interpolate(k, [0, 0.25, 0.7, 1], [s0, s0 + 0.04, 1.08, 1]) }] };
    return { opacity: discOp.get(), transform: [{ scale: discScale.get() }] };
  });
  const glyphStyle = useAnimatedStyle(() => {
    const k = glyphK.get();
    const mode = glyphMode.get();
    if (mode === GLYPH_LAND) return { opacity: Math.min(1, Math.max(0, k)), transform: [{ scale: 0.4 + 0.6 * k }, { rotate: `${-25 * (1 - k)}deg` }] };
    if (mode === GLYPH_POP) return { opacity: k, transform: [{ scale: 0.6 + 0.4 * k }, { rotate: "0deg" }] };
    return { opacity: 1, transform: [{ scale: 1 }, { rotate: "0deg" }] };
  });
  const glyphBox = useAnimatedStyle(() => ({ opacity: discOp.get() > 0 || (fill.get() >= 0 && fill.get() < 1) ? 1 : 0 }));
  const outStyle = useAnimatedStyle(() => {
    const k = out.get();
    return { opacity: k > 0 && k < 1 ? 0.5 * (1 - k) : 0, transform: [{ scale: 1 + 0.7 * k }] };
  });
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.get() }] }));

  const abs = { position: "absolute", width: size, height: size, alignItems: "center", justifyContent: "center" } as const;
  return (
    <Animated.View style={[{ width: size, height: size }, shakeStyle]}>
      {ringOn && (
        <Animated.View style={[abs, ringStyle]}>
          <ProgressRing key={run} progress={progress} size={size} tone={tone} stopped={phase === "stopped"} quiet={quiet} onStep={onStep} />
        </Animated.View>
      )}
      <Animated.View style={[abs, { borderRadius: size / 2, backgroundColor: phase === "failed" ? palette.orange : palette.blue }, discStyle]} />
      <Animated.View style={[abs, glyphBox]}>
        <Animated.View style={glyphStyle}>{!ringy && <Glyph phase={phase} size={size} draw={draw} />}</Animated.View>
      </Animated.View>
      <Animated.View style={[abs, { borderRadius: size / 2, borderWidth: 1.5, borderColor: t.pulse, pointerEvents: "none" }, outStyle]} />
    </Animated.View>
  );
}

// ── Text ─────────────────────────────────────────────────────────────────────

/** "Making the episode…": a soft light passes over the title (left to right, every 2.2s). Plain text with Reduce Motion. */
function Shimmer({ text, style, ink, shine }: { text: string; style: TextStyle; ink: string; shine: string }) {
  const reduce = useReducedMotion();
  const [w, setW] = useState(0);
  const x = useSharedValue(0);
  useEffect(() => {
    if (reduce || !w) return;
    x.set(0);
    x.set(withRepeat(withTiming(1, timing(2200, Easing.linear)), -1, false));
    return () => cancelAnimation(x);
  }, [reduce, w, x]);
  // The light is a band in a gradient 2.6× the title's width, slid across it (CSS: background-size 260%, position 100% → 0%).
  const band = useAnimatedStyle(() => ({ transform: [{ translateX: -1.6 * w * (1 - x.get()) }] }));
  const label = (
    <Text numberOfLines={1} style={style}>
      {text}
    </Text>
  );
  if (reduce || Platform.OS === "web") return label;
  return (
    <MaskedView style={{ alignSelf: "stretch" }} onLayout={(e) => setW(e.nativeEvent.layout.width)} maskElement={label}>
      <Text numberOfLines={1} style={[style, { opacity: 0 }]}>
        {text}
      </Text>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: ink }]} />
      {w > 0 && (
        <Animated.View style={[{ position: "absolute", top: 0, bottom: 0, left: 0, width: 2.6 * w }, band]}>
          <LinearGradient colors={[ink, ink, shine, ink, ink]} locations={[0, 0.38, 0.5, 0.62, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ flex: 1 }} />
        </Animated.View>
      )}
    </MaskedView>
  );
}

/** The second line: the body face at 11pt, in tabular figures so a count never jitters. */
const line2 = (color: string, making: boolean): TextStyle => ({
  fontFamily: font.bodyMedium,
  fontSize: 11,
  lineHeight: 12,
  color,
  fontVariant: ["tabular-nums"],
  // A hair tighter while making, so the longest line ("Writing the script · ~1 min left") fits.
  letterSpacing: making ? -0.165 : 0,
});

/** Making: "step · time left". The time left never cuts off (the step gives way first), and a new estimate crossfades in. */
function MakingLine({ step, eta, tone, quiet }: { step: number; eta: string; tone: Tone; quiet: boolean }) {
  const reduce = useReducedMotion();
  const t = TONES[tone];
  const mounted = useMounted();
  const still = reduce || quiet || !mounted;
  const style = line2(t.muted, true);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", height: 12, minWidth: 0 }}>
      <Animated.Text key={step} entering={still ? undefined : STEP_IN} numberOfLines={1} style={[style, { flexShrink: 1, minWidth: 0 }]}>
        {STEPS[step]}
      </Animated.Text>
      <Text style={[style, { marginHorizontal: 3 }]}>·</Text>
      <EtaText text={eta} still={still} style={style} />
    </View>
  );
}

/**
 * The time left: two copies in one cell, so a new estimate crossfades over the old one (in from 3pt below over
 * 260ms, the old one out 3pt up over 200ms). Under the Stop confirm, or with Reduce Motion, it just changes.
 */
function EtaText({ text, still, style }: { text: string; still: boolean; style: TextStyle }) {
  const [shown, setShown] = useState<{ cur: string; prev: string | null; n: number }>({ cur: text, prev: null, n: 0 });
  if (text !== shown.cur) setShown({ cur: text, prev: still ? null : shown.cur, n: shown.n + 1 });
  const into = useSharedValue(1);
  const away = useSharedValue(1);
  const { n, prev } = shown;
  useEffect(() => {
    if (!n) return;
    into.set(prev ? 0 : 1);
    away.set(prev ? 0 : 1);
    if (!prev) return;
    into.set(withTiming(1, timing(260)));
    away.set(withTiming(1, timing(200)));
  }, [n, prev, into, away]);
  const inStyle = useAnimatedStyle(() => ({ opacity: into.get(), transform: [{ translateY: 3 * (1 - into.get()) }] }));
  const outStyle = useAnimatedStyle(() => ({ opacity: 1 - away.get(), transform: [{ translateY: -3 * away.get() }] }));
  return (
    <View style={{ flexShrink: 0 }}>
      <Animated.Text numberOfLines={1} style={[style, inStyle]}>
        {shown.cur}
      </Animated.Text>
      {prev != null && (
        <Animated.Text numberOfLines={1} style={[style, { position: "absolute", left: 0, top: 0 }, outStyle]}>
          {prev}
        </Animated.Text>
      )}
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

/**
 * The phase as the strip shows it: the same as the task's, except that when the episode is ready while the
 * ring is still filling, it stays "making" until the ring has closed and held for a beat (at once with Reduce Motion).
 */
function useShownPhase(phase: Phase, reduce: boolean): Phase {
  const [shown, setShown] = useState(phase);
  const holding = phase === "ready" && shown === "making" && !reduce;
  if (phase !== shown && !holding) setShown(phase);
  useEffect(() => {
    if (!holding) return;
    const id = setTimeout(() => setShown("ready"), CLOSE_MS + HOLD_MS);
    return () => clearTimeout(id);
  }, [holding]);
  return holding ? "making" : phase;
}

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
  const phase = useShownPhase(card && task.phase === "stopped" ? "idle" : task.phase, reduce);
  const closing = phase === "making" && task.phase === "ready";
  const progress = closing ? 1 : task.progress;
  const ico = tone === "dark" ? 28 : 32;
  const id = useId();
  const box = useRef<View>(null);
  const mounted = useMounted();
  /** The step follows the ring (it tells us as it crosses a tick). */
  const [step, setStep] = useState(() => stepOf(progress));

  // The confirm takes the row over in place; its box is where a tap counts as inside it.
  const confirming = task.confirming && phase === "making";
  const quiet = useSharedValue(confirming);
  useEffect(() => {
    quiet.set(confirming);
    if (!confirming) return setConfirmRect(id, null);
    box.current?.measureInWindow((x, y, w, h) => setConfirmRect(id, { x, y, w, h }));
    return () => setConfirmRect(id, null);
  }, [confirming, id, quiet]);
  const fade = useSharedValue(confirming ? 1 : 0);
  useEffect(() => {
    fade.set(withTiming(confirming ? 1 : 0, timing(reduce ? 0 : 160, Easing.inOut(Easing.ease))));
  }, [confirming, reduce, fade]);
  const mainStyle = useAnimatedStyle(() => ({ opacity: 1 - fade.get(), transform: [{ translateY: reduce ? 0 : -4 * fade.get() }] }));
  const confirmStyle = useAnimatedStyle(() => ({ opacity: fade.get(), transform: [{ translateY: reduce ? 0 : 4 * (1 - fade.get()) }] }));

  const iconAction = { idle: task.start, ready: task.toggle, playing: task.toggle, paused: task.toggle, failed: task.start }[phase as string] as (() => void) | undefined;
  const timed = phase === "playing" || phase === "paused";

  let title = "";
  let sub = "";
  if (phase === "idle") [title, sub] = ["Make a two-host episode", "Ready in about a minute"];
  else if (phase === "making") title = "Making the episode…";
  else if (phase === "ready") [title, sub] = [`Episode ready · ${task.length}`, "Two hosts · tap to play"];
  else if (phase === "failed") title = "Couldn't make the episode";
  else if (phase === "done") [title, sub] = [`Listened · ${task.length}`, "Played to the end"];
  else if (phase === "stopped") title = "Stopped";

  const titleStyle: TextStyle = { fontFamily: font.bodySemi, fontSize: 13, lineHeight: phase === "failed" ? 15 : 16, color: phase === "stopped" ? t.muted : t.ink };
  const making = phase === "making";

  return (
    <View ref={box} collapsable={false} style={{ flex: 1, alignSelf: "stretch", flexDirection: "row", alignItems: "center" }}>
      <Animated.View style={[{ flex: 1, flexDirection: "row", alignItems: "center", gap: card ? 8 : 10, pointerEvents: confirming ? "none" : "box-none" }, mainStyle]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ICON_LABEL[phase]}
          accessibilityState={{ disabled: !iconAction }}
          disabled={!iconAction}
          onPress={iconAction}
          hitSlop={8}
        >
          <EpisodeIcon phase={phase} run={task.episode?.id ?? "asked"} progress={progress} size={ico} tone={tone} quiet={quiet} onStep={setStep} />
        </Pressable>
        <Pressable
          accessibilityRole={onOpen ? "button" : "text"}
          accessibilityLabel={[title, timed ? null : making ? `${STEPS[step]}, ${task.eta}` : sub].filter(Boolean).join(", ")}
          accessibilityHint={onOpen ? "Goes to the Listen card" : undefined}
          accessibilityLiveRegion="polite"
          disabled={!onOpen}
          onPress={onOpen}
          style={{ flex: 1, minWidth: 0, minHeight: 40, justifyContent: "center" }}
        >
          {/* A change of state lifts the text in (not play ↔ pause, which only swaps the icon). */}
          <Animated.View key={timed ? "timed" : phase} entering={reduce || !mounted ? undefined : STATE_IN} style={{ gap: 2 }}>
            {timed ? (
              <PlayingText task={task} tone={tone} />
            ) : (
              <>
                {making ? (
                  <Shimmer text={title} style={titleStyle} ink={t.ink} shine={t.shine} />
                ) : (
                  <Text numberOfLines={phase === "failed" ? 2 : 1} style={titleStyle}>
                    {title}
                  </Text>
                )}
                {making ? (
                  <MakingLine step={step} eta={task.eta} tone={tone} quiet={confirming} />
                ) : (
                  !!sub && (
                    <Text numberOfLines={1} style={[line2(t.muted, false), { height: 12 }]}>
                      {sub}
                    </Text>
                  )
                )}
              </>
            )}
          </Animated.View>
        </Pressable>
        {making && (
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
          <Text style={{ fontFamily: font.bodySemi, fontSize: 12, lineHeight: 12, color: t.ink }}>Keep</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop the episode"
          onPress={task.stop}
          style={({ pressed }) => ({ borderRadius: 999, borderWidth: 1, borderColor: palette.orange, backgroundColor: palette.orange, paddingVertical: 7, paddingHorizontal: 9, opacity: pressed ? 0.8 : 1 })}
        >
          <Text style={{ fontFamily: font.bodySemi, fontSize: 12, lineHeight: 12, color: palette.ink }}>Stop</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

/** Playing or paused: the chapter, over a thin scrubber and the time ("1:12 / 4:03"). Only this re-renders as the time ticks. */
function PlayingText({ task, tone }: { task: EpisodeTask; tone: Tone }) {
  const t = TONES[tone];
  const time = usePlayTime(task.itemId);
  const duration = time.duration || task.episode?.durationSeconds || 0;
  const chapters = task.episode?.chapters ?? [];
  const chapter = [...chapters].reverse().find((c) => c.startSeconds <= time.at + 0.5)?.title ?? "The piece, out loud";
  return (
    <>
      <Text numberOfLines={1} style={{ fontFamily: font.bodySemi, fontSize: 13, lineHeight: 16, color: t.ink }}>
        {chapter}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", height: 12 }}>
        <Scrubber itemId={task.itemId} at={time.at} duration={duration} dragging={time.dragging} tone={tone} />
        <Text
          accessibilityLabel={`${fmtTime(time.at)} of ${fmtTime(duration)}`}
          style={{ paddingLeft: 8, fontFamily: font.mono, fontSize: 10.5, lineHeight: 12, color: t.muted, fontVariant: ["tabular-nums"] }}
        >
          {fmtTime(time.at)} / {fmtTime(duration)}
        </Text>
      </View>
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
      style={{ flex: 1, height: 14, marginVertical: -1, justifyContent: "center" }}
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

/**
 * The pill's status row: the strip at the pill's width, under which the controls sit. Once its row has closed
 * (folding after Listened or Stopped) it keeps its last look, so the fold doesn't flash another state.
 */
export function EpisodeStatusRow({ itemId, onOpen }: { itemId: string; onOpen: () => void }) {
  const task = useEpisodeTask(itemId);
  const [last, setLast] = useState(task);
  if (task.row && last !== task) setLast(task);
  return (
    <View style={{ height: STATUS_ROW_H, paddingLeft: 10, paddingRight: 9, flexDirection: "row", alignItems: "center" }}>
      <EpisodeStrip task={task.row ? task : last} tone="dark" onOpen={onOpen} />
    </View>
  );
}

// ── Now playing: the row on every pill ───────────────────────────────────────

/** Another episode takes the row: the old text and progress fade out (130ms), the new rise in after them (200ms). */
const SWAP_OUT = new Keyframe({ 0: { opacity: 1 }, 100: { opacity: 0, easing: Easing.in(Easing.ease) } }).duration(130);
const SWAP_IN = new Keyframe({ 0: { opacity: 0, transform: [{ translateY: 3 }] }, 100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE } })
  .delay(130)
  .duration(200);

/**
 * The app's one status row (now-playing.html), in the root layout: whichever episode is now playing (or being
 * made) claims the pill's row, on every screen. Screens only change the controls under it, so moving around
 * the app never folds, regrows or re-animates the row. It folds only when its episode's row closes
 * (Listened or Stopped); another episode starting crossfades it in place.
 */
export function NowPlayingStatus() {
  const { itemId } = useNowPlaying();
  // Unmounts (letting the row fold) only once nothing is playing; a new episode keeps the same slot.
  return itemId ? <NowPlayingSlot itemId={itemId} /> : null;
}

function NowPlayingSlot({ itemId }: { itemId: string }) {
  const task = useEpisodeTask(itemId);
  const closed = task.loaded && !task.row;
  // Its row closed: let go (the row falls back to the episode still in the player, or folds).
  useEffect(() => {
    if (closed) rowFolded(itemId);
  }, [closed, itemId]);
  return <PillStatusSlot>{task.row ? <NowPlayingRow itemId={itemId} /> : null}</PillStatusSlot>;
}

function NowPlayingRow({ itemId }: { itemId: string }) {
  const reduce = useReducedMotion();
  const mounted = useMounted();
  const pathname = usePathname();
  const open = () => {
    const meta = nowPlaying.meta(itemId);
    if (meta) goToNowPlaying(meta, pathname);
  };
  return (
    <View style={{ height: STATUS_ROW_H }}>
      <Animated.View
        key={itemId}
        entering={mounted && !reduce ? SWAP_IN : undefined}
        exiting={mounted && !reduce ? SWAP_OUT : undefined}
        style={StyleSheet.absoluteFill}
      >
        <EpisodeStatusRow itemId={itemId} onOpen={open} />
      </Animated.View>
    </View>
  );
}
