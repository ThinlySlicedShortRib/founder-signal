import { createContext, memo, type ReactNode, type RefObject, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { type SharedValue, useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { palette } from "@/components/onboarding/kit";
import { kvGet, kvSet } from "@/lib/kv";
import { EMPTY_GEO, type FocusGeo, pickFocus, readingLine, toGeo } from "./focus-math";

// ── The setting (per device) ─────────────────────────────────────────────────

/** "Dim others" recedes every other block; "Tint" and "Margin rule" mark the focused one instead. */
export type FocusStyle = "dim" | "tint" | "rule";
export type FocusSetting = { on: boolean; style: FocusStyle };

export const FOCUS_STYLE_LABEL: Record<FocusStyle, string> = { dim: "Dim others", tint: "Tint", rule: "Margin rule" };
const ORDER: FocusStyle[] = ["dim", "tint", "rule"];

/** The tray's cycle: Dim others → Tint → Margin rule → Off → Dim others. */
export function nextFocusSetting(s: FocusSetting): FocusSetting {
  if (!s.on) return { on: true, style: "dim" };
  const i = ORDER.indexOf(s.style);
  return i === ORDER.length - 1 ? { on: false, style: s.style } : { on: true, style: ORDER[i + 1]! };
}

const KEY = "fs.reader.focus";
let current: FocusSetting = { on: true, style: "dim" };
let loaded = false;
const listeners = new Set<() => void>();

function setFocusSetting(next: FocusSetting) {
  current = next;
  loaded = true;
  listeners.forEach((l) => l());
  void kvSet(KEY, JSON.stringify(next));
}

/** The focus highlight setting, shared by every reader on screen and remembered on the device. */
export function useFocusSetting(): [FocusSetting, (s: FocusSetting) => void] {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  useEffect(() => {
    if (loaded) return;
    loaded = true;
    void kvGet(KEY).then((raw) => {
      if (!raw) return;
      try {
        const v = JSON.parse(raw) as Partial<FocusSetting>;
        if (typeof v.on === "boolean" && v.style && ORDER.includes(v.style)) {
          current = { on: v.on, style: v.style };
          listeners.forEach((l) => l());
        }
      } catch {
        // A bad value keeps the default.
      }
    });
  }, []);
  return [value, setFocusSetting];
}

// ── Tracking the focused block ───────────────────────────────────────────────

type Entry = { media: boolean; ref: RefObject<View | null> };

type FocusCtx = {
  /** The data index of the focused block; -1 when nothing is (off, or the article not reached yet). */
  focused: SharedValue<number>;
  /** The one focused before, so only the two blocks changing animate. */
  prev: SharedValue<number>;
  style: FocusStyle | null;
  animate: boolean;
  register: (index: number, entry: Entry) => () => void;
  /** Something moved or resized: measure again (debounced). */
  changed: () => void;
};

const FocusContext = createContext<FocusCtx | null>(null);
export const FocusProvider = FocusContext.Provider;

/**
 * Works out, on the UI thread, which block is under the reading line. Block offsets are measured
 * (relative to the article) only when something lays out again, never per scroll; per frame the
 * reaction is a binary search and React hears nothing: blocks read `focused` in their
 * own animated styles.
 */
export function useFocusTracker({
  articleRef,
  setting,
  reduceMotion,
  scrollY,
  viewH,
  contentH,
  articleTop,
  startY,
  reading,
  flow,
  headMin,
  headMax,
}: {
  articleRef: RefObject<View | null>;
  setting: FocusSetting;
  reduceMotion: boolean;
  scrollY: SharedValue<number>;
  viewH: SharedValue<number>;
  contentH: SharedValue<number>;
  /** Where the article starts in the scroll content. */
  articleTop: SharedValue<number>;
  startY: SharedValue<number>;
  /** 1 once the article is reached (with a lead). */
  reading: SharedValue<number>;
  flow: boolean;
  headMin: number;
  headMax: number;
}) {
  const entries = useRef(new Map<number, Entry>());
  const geo = useSharedValue<FocusGeo>(EMPTY_GEO);
  const focused = useSharedValue(-1);
  const prev = useSharedValue(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const on = setting.on;

  const measure = useCallback(() => {
    timer.current = null;
    const article = articleRef.current;
    if (!article) return;
    const all = [...entries.current.entries()];
    const out: { index: number; top: number; height: number }[] = [];
    let pending = all.length;
    const done = () => {
      pending -= 1;
      if (pending === 0) geo.set(toGeo(out));
    };
    if (!pending) return geo.set(EMPTY_GEO);
    for (const [index, e] of all) {
      const node = e.ref.current;
      if (!node) {
        done();
        continue;
      }
      node.measureLayout(
        article,
        (_x, y, _w, h) => {
          out.push({ index, top: y, height: h });
          done();
        },
        done,
      );
    }
  }, [geo, articleRef]);

  const changed = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(measure, 80);
  }, [measure]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const register = useCallback(
    (index: number, entry: Entry) => {
      entries.current.set(index, entry);
      changed();
      return () => {
        if (entries.current.get(index) === entry) entries.current.delete(index);
        changed();
      };
    },
    [changed],
  );

  useAnimatedReaction(
    () => {
      if (!on || (flow && reading.get() !== 1)) return -1;
      const g = geo.get();
      const n = g.top.length;
      if (!n) return -1;
      const y = scrollY.get();
      const top = articleTop.get();
      const line = readingLine({
        y,
        viewH: viewH.get(),
        contentH: contentH.get(),
        headerBottom: flow ? headMin : Math.max(headMin, headMax - y),
        startY: flow ? startY.get() : 0,
        firstMid: top + (g.top[0]! + g.bottom[0]!) / 2,
        lastMid: top + (g.top[n - 1]! + g.bottom[n - 1]!) / 2,
      });
      return pickFocus(g, line - top);
    },
    (now, before) => {
      if (now === before) return;
      prev.set(focused.get());
      focused.set(now);
    },
    [on, flow, headMin, headMax],
  );

  const ctx = useMemo<FocusCtx>(
    () => ({ focused, prev, style: on ? setting.style : null, animate: !reduceMotion, register, changed }),
    [focused, prev, on, setting.style, reduceMotion, register, changed],
  );
  return ctx;
}

// ── A focusable block ────────────────────────────────────────────────────────

function countRender() {
  const g = globalThis as { __focusBlockRenders?: number };
  g.__focusBlockRenders = (g.__focusBlockRenders ?? 0) + 1;
}

const DIM = 0.4;
/** Images and tables recede less: a picture at 40% reads as broken. */
const DIM_MEDIA = 0.65;
const FADE = { duration: 220 };

/**
 * Wraps one block of the article. The block's own render never changes with focus: only the
 * opacity of its content and of its marker (the tint behind it, or the rule in the margin) are
 * animated, from `focused`. Plain views and opacity leave screen readers' order and focus alone.
 */
export const FocusBlock = memo(function FocusBlock({ index, media = false, children }: { index: number; media?: boolean; children: ReactNode }) {
  const ctx = useContext(FocusContext);
  const ref = useRef<View>(null);
  // A dev-only count of committed block renders, to check scrolling never re-renders the article.
  useEffect(() => {
    if (__DEV__) countRender();
  });

  const register = ctx?.register;
  useEffect(() => register?.(index, { media, ref }), [register, index, media]);

  const focused = ctx?.focused;
  const prev = ctx?.prev;
  const style = ctx?.style ?? null;
  const animate = !!ctx?.animate;

  const contentStyle = useAnimatedStyle(() => {
    const f = focused ? focused.get() : -1;
    const p = prev ? prev.get() : -1;
    const target = style !== "dim" || f < 0 || f === index ? 1 : media ? DIM_MEDIA : DIM;
    // Only the block leaving focus and the one arriving (or all, when focus switches on or off) animate.
    if (!animate || (f >= 0 && p >= 0 && f !== index && p !== index)) return { opacity: target };
    return { opacity: withTiming(target, FADE) };
  }, [style, index, media, animate]);

  const markStyle = useAnimatedStyle(() => {
    const f = focused ? focused.get() : -1;
    const p = prev ? prev.get() : -1;
    const target = (style === "tint" && !media) || style === "rule" ? (f === index ? 1 : 0) : 0;
    if (!animate || (f >= 0 && p >= 0 && f !== index && p !== index)) return { opacity: target };
    return { opacity: withTiming(target, FADE) };
  }, [style, index, media, animate]);

  return (
    <View ref={ref} collapsable={false} onLayout={ctx?.changed}>
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[style === "rule" ? s.rule : style === "tint" && !media ? s.tint : s.none, markStyle]}
      />
      <Animated.View style={contentStyle}>{children}</Animated.View>
    </View>
  );
});

const s = StyleSheet.create({
  none: { position: "absolute", width: 0, height: 0, pointerEvents: "none" },
  // Soft blue behind the block, reaching a little past the text so it isn't touched.
  tint: { position: "absolute", top: -7, bottom: -7, left: -10, right: -10, borderRadius: 12, backgroundColor: palette.blueTint, pointerEvents: "none" },
  // A thin rule in the article's 20px left margin.
  rule: { position: "absolute", top: 3, bottom: 3, left: -13, width: 3, borderRadius: 2, backgroundColor: palette.blue, pointerEvents: "none" },
});
