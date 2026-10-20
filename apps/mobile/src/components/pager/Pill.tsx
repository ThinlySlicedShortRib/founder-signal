import { Children, createContext, isValidElement, type ReactNode, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, palette } from "@/components/onboarding/kit";
import { PagerIcon, type PagerIconName } from "./icons";
import { createPillStore, type PillLayer, type PillStore } from "./pill-store";

/**
 * The floating dark pill (.pill on the boards): every screen's navigation and,
 * while reading, every action. It sits 22px above the bottom edge, or just
 * above the home indicator.
 *
 * There is one pill per screen, and it morphs between modes like the Dynamic
 * Island: the old contents fade out and shrink a touch, the pill springs to
 * the new contents' size, and they fade up in place. Owners in different
 * components share it through a `PillProvider`: each renders a
 * `<Pill mode=…>` (a slot, which draws nothing itself), the newest claim wins,
 * and `<PillOutlet />` draws the pill. A `<Pill>` with no provider above it
 * draws its own (and still morphs when its `mode` changes).
 */

export function usePillSpace() {
  const insets = useSafeAreaInsets();
  const bottom = insets.bottom > 0 ? insets.bottom + 6 : 22;
  /** Padding to leave under scrolling content so its end clears the pill (the boards' 104–110px). */
  return { bottom, space: bottom + 88 };
}

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
/** Size changes this soon after a mode change still spring (the new contents settling); later ones within a mode snap. */
const MORPH_WINDOW_MS = 450;
/** A new mode's children that mount this long after it appeared don't fade in (they're an update, not the morph). */
const ENTRANCE_MS = IN_DELAY + IN_MS + 4 * STAGGER_MS;
const EASE_OUT = Easing.out(Easing.cubic);

const PillContext = createContext<PillStore | null>(null);

/** One pill for everything under it (a screen whose pill changes hands between components). Put `<PillOutlet />` where the pill should be drawn. */
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

/** Draws the provider's pill: one container whose size springs between modes, with the contents crossfading inside it. */
export function PillOutlet() {
  const store = useContext(PillContext);
  if (!store) throw new Error("PillOutlet needs a PillProvider");
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { bottom } = usePillSpace();
  const stageW = useWindowDimensions().width;
  const reduce = useReducedMotion();

  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const shown = useSharedValue(0);
  /** The pill has had a size once (until then it's invisible: nothing to fade in from). */
  const [sized, setSized] = useState(false);
  const sizes = useRef(new Map<number, Size>());
  const currentId = useRef<number | null>(null);
  const morphUntil = useRef(0);

  const current = snap.current;
  const id = current?.id ?? null;
  const visible = !!current && !current.hidden;

  const applySize = useCallback(
    (s: Size, morph: boolean) => {
      // Snap when there's nothing to see a spring on (first size, faded out) or with Reduce Motion.
      if (!morph || reduce || shown.get() < 0.5) {
        width.set(s.w);
        height.set(s.h);
      } else {
        width.set(withSpring(s.w, SPRING));
        height.set(withSpring(s.h, SPRING));
      }
    },
    [reduce, width, height, shown],
  );

  // A new mode: the size springs once its contents are measured (below), or now if it's one coming back mid-fade.
  useLayoutEffect(() => {
    currentId.current = id;
    if (id === null) return;
    morphUntil.current = Date.now() + MORPH_WINDOW_MS;
    const known = sizes.current.get(id);
    if (known) applySize(known, true);
  }, [id, applySize]);

  const onMeasure = useCallback(
    (layer: number, s: Size) => {
      const was = sizes.current.get(layer);
      if (was && was.w === s.w && was.h === s.h) return;
      sizes.current.set(layer, s);
      if (layer !== currentId.current) return;
      applySize(s, Date.now() < morphUntil.current);
      setSized(true);
    },
    [applySize],
  );

  const onGone = useCallback(
    (layer: number) => {
      sizes.current.delete(layer);
      store.drop(layer);
    },
    [store],
  );

  useEffect(() => {
    if (!sized) return;
    shown.set(withTiming(visible ? 1 : 0, { duration: visible ? IN_MS : OUT_MS, easing: EASE_OUT, reduceMotion: ReduceMotion.Never }));
  }, [visible, sized, shown]);

  const boxStyle = useAnimatedStyle(() => ({ width: width.get(), height: height.get(), opacity: shown.get() }));

  const layers = [...snap.exiting, ...(current ? [current] : [])].sort((a, b) => a.id - b.id);

  return (
    <View style={{ pointerEvents: "box-none", position: "absolute", left: 0, right: 0, bottom, alignItems: "center", zIndex: current?.z ?? 20 }}>
      <Animated.View
        style={[
          { pointerEvents: visible ? "auto" : "none", backgroundColor: palette.pill, borderRadius: 999, boxShadow: "0 12px 30px rgba(18,19,22,0.22)" },
          boxStyle,
        ]}
      >
        {/* Clipped inside the pill's rounded shape; the shadow stays on the outer view. */}
        <View style={[StyleSheet.absoluteFill, { pointerEvents: "box-none", borderRadius: 999, overflow: "hidden" }]}>
          {/* A full-width stage centred on the pill, so contents lay out at their natural width whatever size the pill is mid-spring. */}
          <View style={{ pointerEvents: "box-none", position: "absolute", top: 0, bottom: 0, left: "50%", width: stageW, marginLeft: -stageW / 2 }}>
            {layers.map((layer) => (
              <PillLayerView
                key={layer.id}
                layer={layer}
                live={layer === current}
                initial={!sized}
                reduce={reduce}
                onMeasure={onMeasure}
                onGone={onGone}
              />
            ))}
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

/** One mode's contents: live while current, frozen as it last looked while fading out. */
function PillLayerView({
  layer,
  live,
  initial,
  reduce,
  onMeasure,
  onGone,
}: {
  layer: PillLayer;
  live: boolean;
  /** The pill's first contents: no entrance of their own (the whole pill fades in). */
  initial: boolean;
  reduce: boolean;
  onMeasure: (layer: number, s: Size) => void;
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
      style={[StyleSheet.absoluteFill, { pointerEvents: active ? "box-none" : "none", alignItems: "center", justifyContent: "center" }, style]}
      accessibilityElementsHidden={!live}
      importantForAccessibility={live ? "auto" : "no-hide-descendants"}
      aria-hidden={!live}
    >
      <View
        accessibilityRole={live ? "toolbar" : undefined}
        accessibilityLabel={live ? layer.label : undefined}
        onLayout={(e) => onMeasure(id, { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        style={{ pointerEvents: "box-none", flexDirection: "row", alignItems: "center", gap: 2, padding: 5, maxWidth: "94%" }}
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
