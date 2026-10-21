import { Children, createContext, isValidElement, type ReactNode, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, palette } from "@/components/onboarding/kit";
import { PagerIcon, type PagerIconName } from "./icons";
import { createPillStore, type PillLayer, type PillStore } from "./pill-store";

/**
 * The floating dark pill (.pill on the boards): every screen's navigation and,
 * while reading, every action. It sits 22px above the bottom edge, or just
 * above the home indicator.
 *
 * There is one pill for the whole app, and it morphs between modes like the
 * Dynamic Island: the old contents fade out and shrink a touch, the pill
 * springs to the new contents' size, and they fade up in place. The
 * `PillProvider` and `<PillOutlet />` sit in the root layout, over every
 * route, so the pill (and its status row) persists from screen to screen:
 * each owner renders a `<Pill mode=…>` (a slot, which draws nothing itself)
 * and the newest claim wins. A `<Pill>` with no provider above it draws its
 * own (and still morphs when its `mode` changes).
 *
 * Above the controls the pill can grow a status row for a background task
 * (`<PillStatusSlot>`): it's claimed on its own, so it stays put, without
 * re-animating, while the controls under it morph or change hands. While it
 * shows, the pill is at least `STATUS_W` wide (the row takes the pill's
 * width), the controls sit centred under it, and a hairline runs between.
 *
 * The status row can grow up into a panel (player-expand.html): its contents
 * drive `usePillFrame()`'s `open` (0 collapsed → 1 open) and `panelH` (the
 * open height), and the pill follows as one continuous shape, the row's part
 * growing from STATUS_W × STATUS_H to STATUS_OPEN_W × panelH with the controls
 * still underneath. While it's open the screen dims a little, and a tap
 * outside closes it.
 */

/** The status row: its least width, and its height with the hairline under it (the approved 44, plus room for the grab handle). */
export const STATUS_W = 264;
export const STATUS_H = 50;
/** The status row's width once it has grown into its panel. */
export const STATUS_OPEN_W = 284;

/** The open panel's spring (the mock's: stiffness 300, damping 31, on 0 → 1). */
const PANEL_SPRING = { stiffness: 300, damping: 31, mass: 1, reduceMotion: ReduceMotion.Never } as const;

/** The status row's panel, shared between the pill (which takes its shape from it) and the row's contents (which drive it). */
export type PillFrame = {
  /** 0 collapsed → 1 open (past either end while a drag rubber-bands). */
  open: SharedValue<number>;
  /** The panel's height when open, hairline included. */
  panelH: SharedValue<number>;
  /** Springs open or closed (at once with Reduce Motion, or with `instant`); `velocity` is in `open` units per second. */
  settle: (open: boolean, opts?: { velocity?: number; instant?: boolean }) => void;
  reduce: boolean;
};

const PillFrameContext = createContext<PillFrame | null>(null);
/** The status row's panel (inside the pill's status row only; null elsewhere). */
export const usePillFrame = () => useContext(PillFrameContext);
/** The row grows and folds in this long (its height at once with Reduce Motion), fading in or out in STATUS_FADE_MS (RM: STATUS_RM_FADE_MS). */
const STATUS_MS = 220;
const STATUS_FADE_MS = 180;
const STATUS_RM_FADE_MS = 120;
const STATUS_EASE = Easing.bezier(0.2, 0.8, 0.2, 1);
const noSubscribe = () => () => {};

export function usePillSpace() {
  const insets = useSafeAreaInsets();
  const store = useContext(PillContext);
  const status = useSyncExternalStore(store?.subscribe ?? noSubscribe, () => (store ? store.getSnapshot().status != null : false));
  const statusH = status ? STATUS_H : 0;
  const bottom = insets.bottom > 0 ? insets.bottom + 6 : 22;
  /** Padding to leave under scrolling content so its end clears the pill (the boards' 104–110px). */
  return { bottom, space: bottom + 88 + statusH, statusH };
}

const PillContext = createContext<PillStore | null>(null);

// ── Motion ───────────────────────────────────────────────────────────────────
/** Old contents: fade out, scaling to 0.96. */
const OUT_MS = 120;
const OUT_SCALE = 0.96;
/** New contents: fade up 4px, starting after the old have mostly gone, 25ms apart per button. */
const IN_DELAY = 60;
const IN_MS = 180;
const STAGGER_MS = 25;
const IN_RISE = 4;
/** Reduce Motion: a plain crossfade, and the size changes at once. */
const RM_OUT_MS = 100;
const RM_IN_MS = 150;
/** The size: a gentle spring with almost no bounce (perceptual duration; Reanimated runs it ~1.5x). */
const SPRING = { duration: 340, dampingRatio: 0.88 } as const;
/** A new mode's children that mount this long after it appeared don't fade in (they're an update, not the morph). */
const ENTRANCE_MS = IN_DELAY + IN_MS + 4 * STAGGER_MS;
const EASE_OUT = Easing.out(Easing.cubic);


/** One pill for everything under it (the app: it's in the root layout). Put `<PillOutlet />` where the pill should be drawn. */
export function PillProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createPillStore);
  return <PillContext value={store}>{children}</PillContext>;
}

/**
 * Claims the pill with these contents. `mode` names what the pill is doing
 * ("pager", "reading", "verdict"…): a new mode morphs, while new children in the
 * same mode (time left ticking, Save toggled) just update. `hidden` fades the
 * pill out while a dialog covers it.
 */
export function Pill(props: PillProps) {
  const store = useContext(PillContext);
  return store ? <PillSlot store={store} {...props} /> : <StandalonePill {...props} />;
}

type PillProps = { children: ReactNode; label: string; mode?: string; hidden?: boolean; z?: number };

/**
 * Claims the pill's status row with these contents (null: none, and the row folds). Independent of the
 * pill's mode: whoever owns the controls, the row stays. Needs a `PillProvider` (does nothing without one).
 */
export function PillStatusSlot({ children }: { children: ReactNode | null }) {
  const store = useContext(PillContext);
  const id = useId();
  useLayoutEffect(() => {
    store?.setStatus(id, children ?? null);
  });
  useLayoutEffect(() => () => store?.releaseStatus(id), [store, id]);
  return null;
}

/**
 * A dialog drawn over the pill's place (a sheet above the pill's layer): while `open`, the pill fades out under
 * it, status row and all. The app-level pill is drawn above every screen, so a screen's own z-order can't put
 * anything over it.
 */
export function usePillCover(open: boolean) {
  const store = useContext(PillContext);
  const id = useId();
  useLayoutEffect(() => {
    store?.setCover(id, open);
  }, [store, id, open]);
  useLayoutEffect(() => () => store?.setCover(id, false), [store, id]);
}

function StandalonePill(props: PillProps) {
  const [store] = useState(createPillStore);
  return (
    <PillContext value={store}>
      <PillSlot store={store} {...props} />
      <PillOutlet />
    </PillContext>
  );
}

function PillSlot({ store, children, label, mode, hidden = false, z = 20 }: PillProps & { store: PillStore }) {
  const id = useId();
  // Every render: the outlet draws the latest contents. Layout effects, so a handover lands before paint.
  useLayoutEffect(() => {
    store.set(id, { mode: mode ?? label, label, node: children, hidden, z });
  });
  useLayoutEffect(() => () => store.release(id), [store, id]);
  return null;
}

type Size = { w: number; h: number };
/** A pinned size while the pill springs between modes, or "auto": sized by the live contents, as laid out. */
type Dim = number | "auto";

/** The box the contents of an outgoing mode lay out in, centred on the pill: big enough that they keep their natural size whatever size the pill is mid-spring. */
const STAGE_H = 200;

/**
 * Draws the provider's pill: one container whose size springs between modes, with the contents crossfading inside it.
 *
 * The live contents lay out in normal flow, so they size the pill themselves (right from the first frame, and
 * for every update within a mode). Only a morph pins the size: when the mode changes, the pill is held at the
 * outgoing contents' size, springs to the new contents' size once they've laid out, and goes back to "auto".
 */
export function PillOutlet({ suppressed = false }: { /** A route with no pill (a pushed screen with a header): the pill fades out, keeping its contents. */ suppressed?: boolean } = {}) {
  const store = useContext(PillContext);
  if (!store) throw new Error("PillOutlet needs a PillProvider");
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { bottom } = usePillSpace();
  const stageW = useWindowDimensions().width;
  const reduce = useReducedMotion();

  const width = useSharedValue<Dim>("auto");
  const height = useSharedValue<Dim>("auto");
  const shown = useSharedValue(1);
  /** Each layer's natural size, from its own layout. */
  const sizes = useRef(new Map<number, Size>());
  /** The layer the pill is sized by (kept in step with the store, ahead of this component's render). */
  const liveId = useRef<number | null>(null);
  /** The size is held at explicit numbers (a morph in progress). */
  const pinned = useRef(false);
  /** The pill's first contents don't have an entrance of their own. */
  const [firstId, setFirstId] = useState<number | null>(null);

  const current = snap.current;
  const id = current?.id ?? null;
  const visible = !!current && !current.hidden && !snap.covered && !suppressed;
  if (firstId === null && id !== null) setFirstId(id);

  const unpinned = useCallback(() => {
    pinned.current = false;
  }, []);

  /** Pinned: spring to the live contents' size and hand back to "auto" (snap with Reduce Motion, or while faded out). */
  const settle = useCallback(
    (s: Size) => {
      if (reduce || shown.get() < 0.5) {
        width.set("auto");
        height.set("auto");
        pinned.current = false;
        return;
      }
      width.set(
        withSpring(s.w, SPRING, (done) => {
          if (done) width.set("auto");
        }),
      );
      height.set(
        withSpring(s.h, SPRING, (done) => {
          if (done) {
            height.set("auto");
            scheduleOnRN(unpinned);
          }
        }),
      );
    },
    [reduce, width, height, shown, unpinned],
  );

  // A new mode: hold the pill at the outgoing contents' size before the incoming ones lay out. This listens to the
  // store directly (rather than reacting to the render) so the pin is set before the new contents are committed.
  useLayoutEffect(() => {
    liveId.current = store.getSnapshot().current?.id ?? null;
    return store.subscribe(() => {
      const next = store.getSnapshot().current?.id ?? null;
      const prev = liveId.current;
      if (next === prev) return;
      liveId.current = next;
      const from = prev === null ? undefined : sizes.current.get(prev);
      if (!pinned.current && from) {
        width.set(from.w);
        height.set(from.h);
        pinned.current = true;
      }
      // A mode coming back mid-fade already has a size; a new one springs once it's laid out (onMeasure).
      const known = next === null ? undefined : sizes.current.get(next);
      if (pinned.current && known) settle(known);
    });
  }, [store, width, height, settle]);

  const onMeasure = useCallback(
    (layer: number, s: Size) => {
      const was = sizes.current.get(layer);
      if (was && was.w === s.w && was.h === s.h) return;
      sizes.current.set(layer, s);
      if (layer === liveId.current && pinned.current) settle(s);
    },
    [settle],
  );

  const onGone = useCallback(
    (layer: number) => {
      sizes.current.delete(layer);
      store.drop(layer);
    },
    [store],
  );

  // The first look shows at once (no fade from nothing); after that the pill fades out and back under a dialog.
  const started = useRef(false);
  useLayoutEffect(() => {
    if (!current) return;
    if (!started.current) {
      started.current = true;
      shown.set(visible ? 1 : 0);
      return;
    }
    shown.set(withTiming(visible ? 1 : 0, { duration: visible ? IN_MS : OUT_MS, easing: EASE_OUT, reduceMotion: ReduceMotion.Never }));
  }, [current, visible, shown]);

  // The status row's panel: how open, and how tall when open.
  const open = useSharedValue(0);
  const panelH = useSharedValue(STATUS_H + 150);
  const frame = useMemo<PillFrame>(
    () => ({
      open,
      panelH,
      reduce,
      settle: (to, { velocity = 0, instant = false } = {}) => {
        const target = to ? 1 : 0;
        cancelAnimation(open);
        if (instant || reduce) open.set(target);
        else open.set(withSpring(target, { ...PANEL_SPRING, velocity: Math.max(-14, Math.min(14, velocity)) }));
      },
    }),
    [open, panelH, reduce],
  );
  // Nothing to open (no row), or the pill's gone (a dialog, a screen without it): closed, at once.
  const hasStatus = snap.status != null;
  useEffect(() => {
    if (!visible || !hasStatus) frame.settle(false, { instant: true });
  }, [visible, hasStatus, frame]);
  /** The scrim takes taps once the panel is on its way open. */
  const [dimmed, setDimmed] = useState(false);
  useAnimatedReaction(
    () => open.get() > 0.05,
    (on, was) => {
      if (on !== was) scheduleOnRN(setDimmed, on);
    },
  );
  const scrimStyle = useAnimatedStyle(() => ({ opacity: 0.16 * Math.min(1, Math.max(0, open.get())) }));

  const boxStyle = useAnimatedStyle(() => ({ width: width.get(), height: height.get() }));
  // A full pill at the controls' 54pt, a little squarer as the panel opens.
  const pillStyle = useAnimatedStyle(() => ({ opacity: shown.get(), borderRadius: 27 - 5 * Math.min(1, Math.max(0, open.get())) }));
  /** The live controls' width, for the status row to grow from. */
  const ctlW = useSharedValue(0);
  // The row follows the controls' width as the pill springs between modes (at once the first time, or with Reduce Motion).
  const onLiveWidth = useCallback((w: number) => ctlW.set(ctlW.get() === 0 || reduce ? w : withSpring(w, SPRING)), [ctlW, reduce]);

  const layers = [...snap.exiting, ...(current ? [current] : [])].sort((a, b) => a.id - b.id);

  return (
    <>
      {/* The open panel dims the screen a little; a tap outside it closes it. */}
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: palette.pill, zIndex: current?.z ?? 20, pointerEvents: dimmed ? "auto" : "none" }, scrimStyle]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close the player" onPress={() => frame.settle(false)} style={{ flex: 1 }} />
      </Animated.View>
    <View style={{ pointerEvents: "box-none", position: "absolute", left: 0, right: 0, bottom, alignItems: "center", zIndex: current?.z ?? 20 }}>
      <Animated.View
        style={[
          {
            pointerEvents: visible ? "auto" : "none",
            backgroundColor: palette.pill,
            boxShadow: "0 12px 30px rgba(18,19,22,0.22)",
            // Clips the contents to the rounded shape (the shadow is drawn outside the clip).
            overflow: "hidden",
            alignItems: "center",
          },
          pillStyle,
        ]}
      >
        <PillFrameContext value={frame}>
          <PillStatusArea node={snap.status} reduce={reduce} ctlW={ctlW} maxW={Math.round(stageW * 0.94)} />
        </PillFrameContext>
        {/* The controls, sized as before (live contents, or pinned mid-morph). Clipped on their own, so an outgoing mode never shows over the row. */}
        <Animated.View style={[{ overflow: "hidden", alignItems: "center", justifyContent: "center" }, boxStyle]}>
          {layers.map((layer) => (
            <PillLayerView
              key={layer.id}
              layer={layer}
              live={layer === current}
              initial={layer.id === firstId}
              reduce={reduce}
              stageW={stageW}
              onMeasure={onMeasure}
              onLiveWidth={layer === current ? onLiveWidth : undefined}
              onGone={onGone}
            />
          ))}
        </Animated.View>
      </Animated.View>
    </View>
    </>
  );
}

/**
 * The status row above the controls. It grows (height 220ms, fading in over 180ms) when a status is claimed and
 * folds when it's let go, keeping its last contents while it folds. It takes the pill's width: at least
 * `STATUS_W`, or the controls' if they're wider, and the pill widens with it as it grows. As its panel opens
 * (`PillFrame.open`) it grows to `STATUS_OPEN_W` and the panel's height, out of the same shape.
 */
function PillStatusArea({ node, reduce, ctlW, maxW }: { node: ReactNode | null; reduce: boolean; ctlW: SharedValue<number>; maxW: number }) {
  const on = node != null;
  /** What it shows: the latest contents, or the last ones while it folds. */
  const [held, setHeld] = useState<ReactNode | null>(node);
  if (on && held !== node) setHeld(node);
  const open = useSharedValue(on ? 1 : 0);
  const fade = useSharedValue(on ? 1 : 0);
  const w = Math.min(STATUS_W, maxW);
  const w1 = Math.min(STATUS_OPEN_W, maxW);
  const frame = useContext(PillFrameContext)!;
  const { open: x, panelH } = frame;

  const folded = useCallback(() => setHeld(null), []);
  useEffect(() => {
    const done = (finished?: boolean) => {
      "worklet";
      if (finished && !on) scheduleOnRN(folded);
    };
    const grow = { duration: reduce ? 0 : STATUS_MS, easing: STATUS_EASE, reduceMotion: ReduceMotion.Never };
    const fadeCfg = { duration: reduce ? STATUS_RM_FADE_MS : STATUS_FADE_MS, easing: Easing.inOut(Easing.ease), reduceMotion: ReduceMotion.Never };
    // Whichever ends last lets the contents go.
    open.set(withTiming(on ? 1 : 0, grow, reduce ? undefined : done));
    fade.set(withTiming(on ? 1 : 0, fadeCfg, reduce ? done : undefined));
  }, [on, reduce, open, fade, folded]);

  const style = useAnimatedStyle(() => {
    const p = open.get();
    const k = Math.min(1, Math.max(0, x.get()));
    const ctl = Math.min(ctlW.get(), maxW);
    // The row's width (wider as its panel opens); the pill grows from the controls' width to it.
    const row = Math.max(ctl, w + (w1 - w) * k);
    // Past either end while a drag rubber-bands, so not clamped.
    const h = STATUS_H + (panelH.get() - STATUS_H) * x.get();
    return { height: p * h, opacity: fade.get(), width: ctl + (row - ctl) * p };
  });
  const rowStyle = useAnimatedStyle(() => {
    const k = Math.min(1, Math.max(0, x.get()));
    return { width: Math.max(Math.min(ctlW.get(), maxW), w + (w1 - w) * k), height: STATUS_H + (panelH.get() - STATUS_H) * x.get() };
  });

  if (held == null) return null;
  return (
    <Animated.View style={[{ overflow: "hidden", alignItems: "center", justifyContent: "flex-start" }, style]}>
      <Animated.View style={[{ borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.1)", flexShrink: 0 }, rowStyle]}>{held}</Animated.View>
    </Animated.View>
  );
}

/** One mode's contents: live (in flow, sizing the pill) while current, frozen as it last looked while fading out. */
function PillLayerView({
  layer,
  live,
  initial,
  reduce,
  stageW,
  onMeasure,
  onLiveWidth,
  onGone,
}: {
  layer: PillLayer;
  live: boolean;
  /** The pill's first contents: no entrance of their own. */
  initial: boolean;
  reduce: boolean;
  stageW: number;
  onMeasure: (layer: number, s: Size) => void;
  onLiveWidth?: (w: number) => void;
  onGone: (layer: number) => void;
}) {
  const opacity = useSharedValue(1);
  const scale = useSharedValue(1);
  /** Taps land only once the old contents are gone, so a tap aimed at them doesn't hit these. */
  const [tappable, setTappable] = useState(initial);
  /** Children that mount while this is true fade up (the morph); later ones are updates and just appear. */
  const [entering, setEntering] = useState(!initial);
  const { id } = layer;

  useEffect(() => {
    if (tappable) return;
    const t = setTimeout(() => setTappable(true), reduce ? RM_OUT_MS : OUT_MS);
    return () => clearTimeout(t);
  }, [tappable, reduce]);

  useEffect(() => {
    if (!entering) return;
    const t = setTimeout(() => setEntering(false), ENTRANCE_MS);
    return () => clearTimeout(t);
  }, [entering]);

  useEffect(() => {
    if (live) {
      // Current, or revived while it was fading out: back to full from wherever it got to.
      const config = { duration: reduce ? RM_IN_MS : IN_MS, easing: EASE_OUT, reduceMotion: ReduceMotion.Never };
      opacity.set(withTiming(1, config));
      scale.set(withTiming(1, config));
      return;
    }
    const ms = reduce ? RM_OUT_MS : OUT_MS;
    const config = { duration: ms, easing: EASE_OUT, reduceMotion: ReduceMotion.Never };
    opacity.set(withTiming(0, config));
    scale.set(withTiming(reduce ? 1 : OUT_SCALE, config));
    const t = setTimeout(() => onGone(id), ms + 40);
    return () => clearTimeout(t);
  }, [live, reduce, id, onGone, opacity, scale]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.get(), transform: [{ scale: scale.get() }] }));
  const active = live && tappable && !layer.orphan;

  return (
    <Animated.View
      style={[
        live
          ? // In flow: its natural size is the pill's size. It never shrinks to the pill, so mid-spring it overflows, centred, into the clip.
            { flexShrink: 0 }
          : // Out of flow, on a fixed stage centred on the pill, so it keeps its last look while the pill springs to the new one.
            { position: "absolute", left: "50%", top: "50%", width: stageW, height: STAGE_H, marginLeft: -stageW / 2, marginTop: -STAGE_H / 2 },
        { pointerEvents: active ? "box-none" : "none", alignItems: "center", justifyContent: "center" },
        style,
      ]}
      accessibilityElementsHidden={!live}
      importantForAccessibility={live ? "auto" : "no-hide-descendants"}
      aria-hidden={!live}
    >
      <View
        accessibilityRole={live ? "toolbar" : undefined}
        accessibilityLabel={live ? layer.label : undefined}
        onLayout={(e) => {
          onMeasure(id, { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
          onLiveWidth?.(e.nativeEvent.layout.width);
        }}
        style={{ pointerEvents: "box-none", flexDirection: "row", alignItems: "center", flexShrink: 0, gap: 2, padding: 5, maxWidth: Math.round(stageW * 0.94) }}
      >
        {Children.toArray(layer.node).map((child, i) => (
          <PillItem key={isValidElement(child) && child.key != null ? child.key : i} index={i} enter={entering} reduce={reduce}>
            {child}
          </PillItem>
        ))}
      </View>
    </Animated.View>
  );
}

/** One button or label in a layer, fading up in turn when its mode arrives. */
function PillItem({ index, enter, reduce, children }: { index: number; enter: boolean; reduce: boolean; children: ReactNode }) {
  // Decided when it mounts: a child that appears later in the same mode doesn't animate.
  const [plan] = useState(() => (enter ? { delay: reduce ? 0 : IN_DELAY + index * STAGGER_MS, ms: reduce ? RM_IN_MS : IN_MS, rise: reduce ? 0 : IN_RISE } : null));
  const progress = useSharedValue(plan ? 0 : 1);
  const rise = plan?.rise ?? 0;

  useEffect(() => {
    if (plan) progress.set(withDelay(plan.delay, withTiming(1, { duration: plan.ms, easing: EASE_OUT, reduceMotion: ReduceMotion.Never }), ReduceMotion.Never));
  }, [plan, progress]);

  const style = useAnimatedStyle(() => ({ opacity: progress.get(), transform: [{ translateY: (1 - progress.get()) * rise }] }));
  return <Animated.View style={[{ pointerEvents: "box-none" }, style]}>{children}</Animated.View>;
}

/** .pb: a 44px round button; `blue` is the menu or tray button, `dim` an end of the pager. */
export function PillButton({
  icon,
  label,
  onPress,
  blue,
  dim,
  filled,
  expanded,
  pressed: isPressed,
}: {
  icon: PagerIconName;
  label: string;
  onPress?: () => void;
  blue?: boolean;
  dim?: boolean;
  filled?: boolean;
  expanded?: boolean;
  /** For toggles such as Save. */
  pressed?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-disabled={dim}
      aria-expanded={expanded}
      aria-pressed={isPressed}
      disabled={dim || !onPress}
      onPress={onPress}
      hitSlop={2}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: blue ? palette.blue : "transparent",
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <PagerIcon name={icon} color={dim ? palette.muted : "#FFFFFF"} filled={filled} />
    </Pressable>
  );
}

/** .pl: a mono kicker over the current page, e.g. TODAY / 2 / 5. */
export function PillLabel({ kicker, value }: { kicker: string; value: string }) {
  return (
    <View accessible accessibilityLabel={`${kicker}, ${value}`} style={{ minWidth: 92, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontFamily: font.mono, fontSize: 10, lineHeight: 12, letterSpacing: 0.8, textTransform: "uppercase", color: palette.pillMuted }}>{kicker}</Text>
      <Text numberOfLines={1} style={{ fontFamily: font.bodySemi, fontSize: 15, lineHeight: 18, color: "#FFFFFF" }}>
        {value}
      </Text>
    </View>
  );
}

/** .pv: a text button in the pill ("Not for me", "Worth it", "Piece 2 ↓"). */
export function PillAction({ title, onPress, primary, label }: { title: string; onPress: () => void; primary?: boolean; label?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        borderRadius: 999,
        paddingHorizontal: 16,
        justifyContent: "center",
        backgroundColor: primary ? palette.blue : "transparent",
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ fontFamily: font.bodySemi, fontSize: 15, lineHeight: 19, color: "#FFFFFF" }}>{title}</Text>
    </Pressable>
  );
}

/** .grow: the status part of the pill (progress ring + time left, or the verdict). */
export function PillStatus({ children, label }: { children: ReactNode; label: string }) {
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 6, paddingRight: 10, minWidth: 120 }}
    >
      {children}
    </View>
  );
}

export function PillStatusText({ children }: { children: ReactNode }) {
  return (
    <Text numberOfLines={1} style={{ fontFamily: font.bodySemi, fontSize: 14.5, lineHeight: 18, color: "#FFFFFF" }}>
      {children}
    </Text>
  );
}

/** The blue menu button: ≡ to open the big-type menu, × while it's open. */
export function MenuToggle({ open, onPress }: { open: boolean; onPress: () => void }) {
  return <PillButton icon={open ? "close" : "menu"} label={open ? "Close menu" : "Open menu"} onPress={onPress} blue expanded={open} />;
}
