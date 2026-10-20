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
 *
 * `band` is a piece page's version: the hero takes the room its page leaves
 * (`flex: 1`, no minimum), the art is drawn at the cover's size (HERO.share of
 * the window) and pinned to the top, so the masthead keeps the same clear
 * zone as on the cover, and its foot fades into the art's own paper
 * (`band.fade`), the colour the page carries on below. `middle` sits in the
 * space between the masthead and the text (a video's play button). A page
 * that needs the paper colour first draws the band's scene itself
 * (`useBandScene`) and passes it in as `band.scene`.
 */
export function ArtHero({
  art,
  drift,
  masthead,
  middle,
  band,
  onHeight,
  children,
}: {
  art: ArtPick;
  drift?: boolean;
  masthead?: ReactNode;
  middle?: ReactNode;
  band?: { fade: number; bottomPad: number; scene?: Scene };
  onHeight?: (h: number) => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const style = STYLES[art.style];
  const coverHeight = Math.round(windowHeight * HERO.share);
  // A band always draws at the cover's height, whatever its own; the cover at its own size.
  const drawHeight = band ? coverHeight : size?.height;
  const given = band?.scene ?? null;
  const drawn = useMemo(
    () => (size && drawHeight && !given ? drawArt(art.style, { ...art, width: size.width, height: drawHeight }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [art.style, art.seed, art.date, art.number, size?.width, drawHeight, given],
  );
  const scene = given ?? drawn;
  const bg = scene?.background ?? style.base;
  const a = style.scrim;

  return (
    <View
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (!size || Math.round(width) !== size.width || Math.round(height) !== size.height) setSize({ width: Math.round(width), height: Math.round(height) });
        onHeight?.(height);
      }}
      style={band ? { flex: 1, minHeight: 0, backgroundColor: bg, overflow: "hidden" } : { minHeight: coverHeight, backgroundColor: style.base, overflow: "hidden" }}
    >
      {scene && size && <ArtCanvas scene={scene} box={size} drift={drift} />}
      {band && <LinearGradient pointerEvents="none" colors={[rgba(bg, 0), rgba(bg, 1)]} style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: band.fade }} />}
      <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: insets.top + HERO.mastHeight, backgroundColor: rgba(bg, a) }} />
      <LinearGradient pointerEvents="none" colors={[rgba(bg, a), rgba(bg, 0)]} style={{ position: "absolute", top: insets.top + HERO.mastHeight, left: 0, right: 0, height: HERO.fade }} />
      <View style={{ minHeight: insets.top + HERO.mastHeight, paddingTop: insets.top + 14, paddingHorizontal: 20 }}>{masthead}</View>
      <View style={{ flex: 1, minHeight: band ? 12 : 80, alignItems: "center", justifyContent: "center", pointerEvents: "box-none" }}>{middle}</View>
      <View style={{ gap: band ? 10 : 12, paddingTop: 8, paddingHorizontal: 20, paddingBottom: band ? band.bottomPad : HERO.bottomPad }}>
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: rgba(bg, a) }]} />
        <LinearGradient pointerEvents="none" colors={[rgba(bg, 0), rgba(bg, a)]} style={{ position: "absolute", top: -HERO.fade, left: 0, right: 0, height: HERO.fade }} />
        {children}
      </View>
    </View>
  );
}

/** A band's scene: drawn at the window's width and the cover's height (HERO.share), as ArtHero's `band` draws it. */
export function useBandScene(art: ArtPick): Scene {
  const { width, height } = useWindowDimensions();
  const h = Math.round(height * HERO.share);
  const w = Math.round(width);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => drawArt(art.style, { ...art, width: w, height: h }), [art.style, art.seed, art.date, art.number, w, h]);
}

/**
 * The scene as SVG, behind everything, covering `box` from the top: scaled up
 * (centred) only if the box is taller or wider than what was drawn, cropped
 * from the bottom if it's shorter. With `drift`, slowly breathing and sliding.
 */
function ArtCanvas({ scene, box, drift }: { scene: Scene; box: { width: number; height: number }; drift?: boolean }) {
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
  const k = Math.max(1, box.width / scene.width, box.height / scene.height);
  const [w, h] = [scene.width * k, scene.height * k];
  return (
    <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden style={[StyleSheet.absoluteFill, animated]}>
      <SvgXml xml={xml} width={w} height={h} style={{ position: "absolute", top: 0, left: (box.width - w) / 2 }} />
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
