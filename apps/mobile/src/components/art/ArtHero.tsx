import { LinearGradient } from "expo-linear-gradient";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type NativeScrollEvent, type NativeSyntheticEvent, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SvgXml } from "react-native-svg";
import { font } from "@/components/onboarding/kit";
import { rgba } from "./colors";
import { HERO } from "./layout";
import { type Scene, toSvg } from "./scene";
import { drawArt, STYLES } from "./styles";
import type { ArtPick } from "./useArt";

const FONTS = { display: font.display, mono: font.mono };
/** How far the drifting art is scaled up, so its edges never show. */
const DRIFT_SCALE = 1.08;

/**
 * Today's hero: the day's art filling a band at the top (at least 60% of the
 * screen), with the masthead on a scrim at the top and the cover's text on a
 * scrim at the bottom. The scrims are the art's own background colour at the
 * style's `scrim` opacity, enough for 4.5:1 whatever is drawn behind them.
 * The art is decorative: hidden from screen readers. `drift` moves it slowly
 * (not with Reduce Motion).
 */
export function ArtHero({ art, drift, masthead, onHeight, children }: { art: ArtPick; drift?: boolean; masthead?: ReactNode; onHeight?: (h: number) => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const style = STYLES[art.style];
  const scene = useMemo(
    () => (size ? drawArt(art.style, { ...art, width: size.width, height: size.height }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [art.style, art.seed, art.date, art.number, size?.width, size?.height],
  );
  const bg = scene?.background ?? style.base;
  const a = style.scrim;

  return (
    <View
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (!size || Math.round(width) !== size.width || Math.round(height) !== size.height) setSize({ width: Math.round(width), height: Math.round(height) });
        onHeight?.(height);
      }}
      style={{ minHeight: Math.round(windowHeight * HERO.share), backgroundColor: style.base, overflow: "hidden" }}
    >
      {scene && <ArtCanvas scene={scene} drift={drift} />}
      <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: insets.top + HERO.mastHeight, backgroundColor: rgba(bg, a) }} />
      <LinearGradient pointerEvents="none" colors={[rgba(bg, a), rgba(bg, 0)]} style={{ position: "absolute", top: insets.top + HERO.mastHeight, left: 0, right: 0, height: HERO.fade }} />
      <View style={{ minHeight: insets.top + HERO.mastHeight, paddingTop: insets.top + 14, paddingHorizontal: 20 }}>{masthead}</View>
      <View style={{ flex: 1, minHeight: 80 }} />
      <View style={{ gap: 12, paddingTop: 8, paddingHorizontal: 20, paddingBottom: HERO.bottomPad }}>
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: rgba(bg, a) }]} />
        <LinearGradient pointerEvents="none" colors={[rgba(bg, 0), rgba(bg, a)]} style={{ position: "absolute", top: -HERO.fade, left: 0, right: 0, height: HERO.fade }} />
        {children}
      </View>
    </View>
  );
}

/** The scene as SVG, behind everything; with `drift`, slowly breathing and sliding. */
function ArtCanvas({ scene, drift }: { scene: Scene; drift?: boolean }) {
  const xml = useMemo(() => toSvg(scene, FONTS), [scene]);
  const reduceMotion = useReducedMotion();
  const moving = !!drift && !reduceMotion;
  const t = useSharedValue(0);
  useEffect(() => {
    if (!moving) return;
    t.value = withRepeat(withTiming(1, { duration: 9000, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(t);
  }, [moving, t]);
  const animated = useAnimatedStyle(() => ({
    transform: moving ? [{ scale: DRIFT_SCALE + t.value * 0.03 }, { translateX: (t.value - 0.5) * 18 }, { translateY: (0.5 - t.value) * 10 }] : [],
  }));
  return (
    <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden style={[StyleSheet.absoluteFill, animated]}>
      <SvgXml xml={xml} width={scene.width} height={scene.height} />
    </Animated.View>
  );
}

/**
 * The status bar over a hero: the art's tone while the hero is under it, dark
 * once the page has scrolled past onto the light ground.
 */
export function useHeroStatusBar(art: ArtPick) {
  const insets = useSafeAreaInsets();
  const [past, setPast] = useState(false);
  const heroHeight = useRef(0);
  return {
    barStyle: (past || STYLES[art.style].tone === "light" ? "dark" : "light") as "dark" | "light",
    onHeroHeight: (h: number) => {
      heroHeight.current = h;
    },
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => setPast(e.nativeEvent.contentOffset.y > heroHeight.current - insets.top - 8),
  };
}
