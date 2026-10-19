import type { AuthorCard } from "@fs/schema";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { font, palette } from "@/components/onboarding/kit";
import { PagerIcon } from "@/components/pager/icons";
import { AuthorChip } from "./Author";

/** The drawer header's row under the status bar, kept tight; the buttons get the rest of 44pt as hit slop. */
export const DRAWER_ROW = 40;
/** Rest this far below the screen, so the closed drawer's shadow (10px up, 30px blur) is out of sight too. */
const OFF = 44;
/** Let go above this share of the screen and the drawer opens. */
const OPEN_FROM = 0.67;
/** A flick faster than this (px/ms) decides on its own. */
const FLICK = 0.35;

const clamp = (v: number, lo = 0, hi = 1) => {
  "worklet";
  return Math.min(hi, Math.max(lo, v));
};

/**
 * The article as a drawer over the piece page. It rests out of sight below the screen; dragging
 * up on the piece page brings it up with the finger, and letting go snaps it to the top (past a
 * third of the way, or on a flick up) or back down. It arrives with some speed left, so it lands,
 * and the landing sends rings out from the handle: the faster it lands, the wider they go.
 * Everything runs on the UI thread; with Reduce Motion it snaps without the rings.
 */
export function useArticleDrawer({ screenH, reduceMotion }: { screenH: number; reduceMotion: boolean }) {
  const h = useSharedValue(screenH);
  /** The drawer's top, from 0 (open) to the screen's height plus `OFF` (closed). */
  const y = useSharedValue(screenH + OFF);
  const start = useSharedValue(0);
  const hitInGesture = useSharedValue(false);
  /** The landing: 0 → 1 over the rings' run, and how hard it landed (0.25–1). */
  const ring = useSharedValue(1);
  const power = useSharedValue(0);

  useEffect(() => {
    const wasClosed = y.get() >= h.get();
    h.set(screenH);
    if (wasClosed) y.set(screenH + OFF);
  }, [screenH, h, y]);

  /** 0 closed → 1 open. */
  const openness = useDerivedValue(() => 1 - clamp(y.get() / Math.max(1, h.get())));

  const land = (speed: number) => {
    "worklet";
    if (reduceMotion) return;
    power.set(clamp(speed / 2.4, 0.25, 1));
    ring.set(0);
    ring.set(withTiming(1, { duration: 1020, easing: Easing.linear }));
  };

  /** Up to the top, easing in from `velocity` (px/ms, negative is up) and keeping speed to the end. */
  const open = (velocity = -1.4) => {
    "worklet";
    const from = y.get();
    // Already there, or just over the top (pushed by hand): settle without another landing.
    if (from < 0.5) return y.set(from < -0.5 && !reduceMotion ? withTiming(0, { duration: 160 }) : 0);
    if (reduceMotion) return y.set(0);
    const ms = clamp((from / Math.max(1.1, Math.abs(velocity))) * 1.35, 170, 380);
    // Ends on a slope of 0.625, so the drawer is still moving when it reaches the top.
    y.set(
      withTiming(0, { duration: ms, easing: Easing.bezier(0.3, 0.2, 0.6, 0.75) }, (done) => {
        if (done) land((0.625 * from) / ms);
      }),
    );
  };

  const close = (velocity = 0) => {
    "worklet";
    const to = h.get() + OFF;
    if (reduceMotion) return y.set(to);
    y.set(withSpring(to, { stiffness: 300, damping: 26, mass: 1, velocity: velocity * 1000 }));
  };

  const coverPan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-8, 8])
        .failOffsetX([-20, 20])
        // On activation, not touch-down: a tap (on Read, say) mustn't stop a drawer mid-flight.
        .onStart((e) => {
          cancelAnimation(y);
          // Less the activation slop, so the drawer doesn't jump to the finger.
          start.set(y.get() - e.translationY);
          hitInGesture.set(false);
        })
        .onUpdate((e) => {
          const raw = start.get() + e.translationY;
          const before = y.get();
          // Resistance past the top; never below its rest.
          y.set(raw < 0 ? -16 * (1 - Math.exp(raw / 50)) : Math.min(raw, h.get() + OFF));
          // Pushed all the way up by hand: it lands under the finger too, once.
          if (!hitInGesture.get() && before > 1 && raw <= 0) {
            hitInGesture.set(true);
            land(Math.abs(e.velocityY) / 1000);
          }
        })
        .onEnd((e) => {
          const v = e.velocityY / 1000;
          const toTop = v < -FLICK || (v <= FLICK && y.get() < h.get() * OPEN_FROM);
          if (toTop) open(Math.min(v, -1.1));
          else close(v);
        }),
    // The worklets read shared values (stable); `open`, `close` and `land` only change with Reduce Motion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reduceMotion],
  );

  const coverStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - 0.05 * openness.get() }] }));
  const dimStyle = useAnimatedStyle(() => ({ opacity: 0.5 * openness.get() }));
  const drawerStyle = useAnimatedStyle(() => {
    const r = 22 * clamp(y.get() / 70);
    return { transform: [{ translateY: y.get() }], borderTopLeftRadius: r, borderTopRightRadius: r };
  });

  return { y, openness, open, close, coverPan, coverStyle, dimStyle, drawerStyle, ring, power };
}

export type ArticleDrawer = ReturnType<typeof useArticleDrawer>;

/**
 * The drawer's sticky header. At the top of the article it's just the handle and the close
 * button, over the article's own title; once that title has scrolled under it, the title comes
 * into the header on one line with an info button that drops down the summary and the writer.
 */
export function DrawerHeader({
  drawer,
  scrollY,
  titleBottom,
  insetTop,
  title,
  summary,
  author,
  onAuthor,
  onClose,
  reduceMotion,
}: {
  drawer: ArticleDrawer;
  scrollY: SharedValue<number>;
  /** Where the article's own title ends, in scroll offsets. */
  titleBottom: SharedValue<number>;
  insetTop: number;
  title: string;
  summary: string | null;
  author: AuthorCard | null;
  onAuthor: () => void;
  onClose: () => void;
  reduceMotion: boolean;
}) {
  const [compact, setCompact] = useState(false);
  const [info, setInfo] = useState(false);
  const shown = useSharedValue(0);
  const hasInfo = !!summary || !!author;
  // Worklets capture these alone, not the whole drawer (its gesture and styles don't cross threads).
  const { y, ring, power } = drawer;
  /** Leaving compact also closes the info panel. */
  const onCompact = useCallback((now: boolean) => {
    setCompact(now);
    if (!now) setInfo(false);
  }, []);

  useAnimatedReaction(
    () => y.get() < 0.5 && scrollY.get() > titleBottom.get() - 4,
    (now, before) => {
      if (now === before) return;
      shown.set(reduceMotion ? (now ? 1 : 0) : withTiming(now ? 1 : 0, { duration: 180 }));
      scheduleOnRN(onCompact, now);
    },
    [reduceMotion],
  );

  const compactStyle = useAnimatedStyle(() => ({ opacity: shown.get(), transform: [{ translateY: (1 - shown.get()) * 6 }] }));
  const ruleStyle = useAnimatedStyle(() => ({ opacity: shown.get() }));
  // Near the top the handle moves down to sit just under the status bar.
  const handleStyle = useAnimatedStyle(() => {
    const near = 1 - clamp(y.get() / 70);
    const p = ring.get() * 1020;
    const s = p < 380 ? (p < 95 ? p / 95 : 1 - (p - 95) / 285) * power.get() : 0;
    return { top: 9 + (insetTop - 6) * near, transform: [{ scaleX: 1 + 0.5 * s }, { scaleY: 1 - 0.4 * s }] };
  });

  return (
    <>
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: insetTop + DRAWER_ROW, zIndex: 5, backgroundColor: palette.surface }}>
        <Animated.View style={[{ position: "absolute", left: "50%", width: 38, height: 5, marginLeft: -19, borderRadius: 3, backgroundColor: palette.line }, handleStyle]} />
        <Ring ring={ring} power={power} insetTop={insetTop} index={0} />
        <Ring ring={ring} power={power} insetTop={insetTop} index={1} />
        <View style={{ position: "absolute", left: 20, right: 12, bottom: 0, height: DRAWER_ROW, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Animated.View style={[{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, pointerEvents: compact ? "auto" : "none" }, compactStyle]}>
            <Text numberOfLines={1} accessibilityElementsHidden={!compact} style={{ flex: 1, fontFamily: font.display, fontSize: 15, letterSpacing: -0.3, color: palette.ink }}>
              {title}
            </Text>
            {hasInfo && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="About this piece"
                accessibilityState={{ expanded: info }}
                disabled={!compact}
                onPress={() => setInfo((o) => !o)}
                hitSlop={9}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  borderWidth: 1.5,
                  borderColor: info ? palette.ink : palette.line,
                  backgroundColor: info ? palette.ink : "transparent",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ fontFamily: font.bodySemi, fontSize: 13, fontStyle: "italic", color: info ? "#FFFFFF" : palette.ink }}>i</Text>
              </Pressable>
            )}
          </Animated.View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to the piece page"
            onPress={onClose}
            hitSlop={7}
            style={{ width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: palette.rule }}
          >
            <PagerIcon name="chevron-down" size={18} color={palette.ink} />
          </Pressable>
        </View>
        <Animated.View style={[{ position: "absolute", left: 0, right: 0, bottom: 0, height: 1, backgroundColor: palette.rule }, ruleStyle]} />
      </View>

      {info && compact && (
        <Animated.View
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(140)}
          style={{
            position: "absolute",
            top: insetTop + DRAWER_ROW,
            left: 0,
            right: 0,
            zIndex: 4,
            gap: 12,
            paddingHorizontal: 20,
            paddingTop: 12,
            paddingBottom: 16,
            backgroundColor: palette.surface,
            borderBottomWidth: 1,
            borderBottomColor: palette.rule,
            boxShadow: "0 12px 24px rgba(18,19,22,0.08)",
          }}
        >
          {summary && <Text style={{ fontFamily: font.body, fontSize: 15, lineHeight: 21.75, color: palette.promptInk }}>{summary}</Text>}
          {author && <AuthorChip author={author} onPress={onAuthor} />}
        </Animated.View>
      )}
    </>
  );
}

/** One of the two thin rings spreading from the handle when the drawer lands; the second starts 120ms later. */
function Ring({ ring, power, insetTop, index }: { ring: SharedValue<number>; power: SharedValue<number>; insetTop: number; index: number }) {
  const style = useAnimatedStyle(() => {
    const ms = ring.get() * 1020 - index * 120;
    const p = clamp(ms / (780 + index * 120));
    const e = 1 - Math.pow(1 - p, 3);
    const grow = 5 + 7 * power.get() - index * 1.5;
    const live = ring.get() < 1 && ms > 0;
    return {
      opacity: live ? 0.55 * (1 - index * 0.35) * (1 - e) : 0,
      transform: [{ scale: 0.3 + (grow - 0.3) * e }],
    };
  });
  return (
    <Animated.View
      style={[
        { position: "absolute", left: "50%", top: insetTop - 18, width: 40, height: 40, marginLeft: -20, borderRadius: 20, borderWidth: 1.5, borderColor: palette.blue, pointerEvents: "none" },
        style,
      ]}
    />
  );
}
