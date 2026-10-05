import type { LetterPiece } from "@fs/schema";
import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { cancelAnimation, Easing, type SharedValue, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, palette } from "@/components/onboarding/kit";
import { PagerIcon } from "@/components/pager/icons";
import { usePillSpace } from "@/components/pager/Pill";
import { Mono } from "@/components/pager/PagerScreen";
import { AuthorChip } from "./Author";
import { PhotoBackdrop } from "./Photo";
import { ProgressBars } from "./ProgressBars";

/**
 * One piece of the letter over its photo, a fixed full-screen layer under the
 * article's drawer (the Reader's `lead`). Dragging up anywhere on it, or
 * tapping Read article, brings the drawer up; the Read and Skip row fades as
 * it comes (`progress`). On a video, the play button opens it on YouTube.
 */
export function PiecePage({
  piece,
  letterNumber,
  pieceCount,
  page,
  pageCount,
  height,
  progress,
  onRead,
  onPlay,
  onListen,
  onSkip,
  onAuthor,
}: {
  piece: LetterPiece;
  letterNumber: number;
  pieceCount: number;
  page: number;
  pageCount: number;
  /** The screen's height. */
  height: number;
  /** How far the article's drawer is open, 0 → 1. */
  progress: SharedValue<number>;
  onRead: () => void;
  onPlay: () => void;
  /** Articles: hear it as a short episode instead. */
  onListen?: () => void;
  onSkip: () => void;
  onAuthor: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { space } = usePillSpace();
  const video = piece.kind === "video";
  const len = `${piece.minutes} min`;
  const label = video ? "Watch" : "Read article";

  const actionsStyle = useAnimatedStyle(() => ({ opacity: 1 - Math.min(1, Math.max(0, progress.get() * 2.5)) }));

  return (
    <View
      style={{ height, overflow: "hidden" }}
      accessibilityActions={[{ name: "activate", label }]}
      onAccessibilityAction={(e) => e.nativeEvent.actionName === "activate" && onRead()}
    >
      <View style={StyleSheet.absoluteFill}>
        <PhotoBackdrop image={piece.image} topic={piece.topic} variant="piece" />
      </View>

      <View style={{ zIndex: 2, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: insets.top + 14, paddingHorizontal: 20, minHeight: 56 }}>
        <Mono color="rgba(255,255,255,0.92)">
          No. {letterNumber} · Piece {piece.position} of {pieceCount}
        </Mono>
        <ProgressBars page={page} count={pageCount} light />
      </View>

      {/* The play button sits in the space above the text, so a long title never runs under it. */}
      <View style={{ flexGrow: 1, minHeight: video ? 100 : 0, zIndex: 2, alignItems: "center", justifyContent: "center", pointerEvents: "box-none" }}>
        {video && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Play on YouTube"
            onPress={onPlay}
            style={{ width: 76, height: 76, borderRadius: 38, backgroundColor: "rgba(255,255,255,0.92)", alignItems: "center", justifyContent: "center" }}
          >
            <PagerIcon name="play" size={30} color={palette.ink} />
          </Pressable>
        )}
      </View>

      <View style={{ zIndex: 2, gap: 14, paddingHorizontal: 20, paddingBottom: space - 6 }}>
        <Mono color="rgba(255,255,255,0.85)">
          {video ? "Video" : "Article"} · {len} · {piece.topic}
        </Mono>
        <Text accessibilityRole="header" style={{ fontFamily: font.display, fontSize: 30, lineHeight: 33, letterSpacing: -1.05, color: "#FFFFFF" }}>
          {piece.title}
        </Text>
        {piece.author && <AuthorChip author={piece.author} onPress={onAuthor} onPhoto />}
        {piece.whyPicked && (
          <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", backgroundColor: "rgba(255,255,255,0.14)", borderWidth: 1, borderColor: "rgba(255,255,255,0.18)", borderRadius: 16, paddingVertical: 12, paddingHorizontal: 13 }}>
            <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: palette.orange, marginTop: 2 }} />
            <Text style={{ flex: 1, fontFamily: font.body, fontSize: 15, lineHeight: 21.75, color: "#FFFFFF" }}>{piece.whyPicked}</Text>
          </View>
        )}
        {piece.tag && (
          <View style={{ alignSelf: "flex-start", borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10, backgroundColor: "#FFFFFF" }}>
            <Text style={{ fontFamily: font.bodySemi, fontSize: 12.5, color: palette.blueInk }}>{piece.tag}</Text>
          </View>
        )}
        <Text numberOfLines={4} style={{ fontFamily: font.body, fontSize: 18, lineHeight: 26, color: "rgba(255,255,255,0.92)" }}>
          {piece.summary}
        </Text>
        <Animated.View style={[{ flexDirection: "row", alignItems: "center", gap: 12 }, actionsStyle]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={video ? "Opens the chapters" : "Opens the article"}
            onPress={onRead}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 52, borderRadius: 999, backgroundColor: "#FFFFFF", paddingHorizontal: 20, opacity: pressed ? 0.88 : 1 })}
          >
            <RisingDot />
            <Text style={{ fontFamily: font.bodySemi, fontSize: 16, color: palette.ink }}>{label}</Text>
          </Pressable>
          {onListen && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Listen"
              accessibilityHint="Makes a short two-host episode of the piece"
              onPress={onListen}
              style={({ pressed }) => ({ width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.18)", borderWidth: 1, borderColor: "rgba(255,255,255,0.35)", opacity: pressed ? 0.8 : 1 })}
            >
              <PagerIcon name="headphones" size={22} color="#FFFFFF" />
            </Pressable>
          )}
          <Pressable accessibilityRole="button" onPress={onSkip} style={{ marginLeft: "auto", minHeight: 44, justifyContent: "center" }}>
            <Text style={{ fontFamily: font.body, fontSize: 14, color: "rgba(255,255,255,0.75)", textDecorationLine: "underline" }}>Skip this one</Text>
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}

/**
 * The hint to swipe up, in the Read button: a small blue dot that keeps rising (fades in over
 * the first 15%, rises 11px by 65%, fades out by the end, every 1.6s). Still, 5px up, with Reduce Motion.
 */
function RisingDot() {
  const reduceMotion = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    t.set(withRepeat(withTiming(1, { duration: 1600, easing: Easing.bezier(0.4, 0, 0.2, 1) }), -1, false));
    return () => cancelAnimation(t);
  }, [reduceMotion, t]);
  const style = useAnimatedStyle(() => {
    if (reduceMotion) return { opacity: 1, transform: [{ translateY: -5 }] };
    const p = t.get();
    const opacity = p < 0.15 ? p / 0.15 : p < 0.65 ? 1 : 1 - (p - 0.65) / 0.35;
    const rise = p < 0.65 ? 11 * (p / 0.65) : 11 + (p - 0.65) / 0.35;
    return { opacity, transform: [{ translateY: -rise }] };
  });
  return (
    <View aria-hidden style={{ width: 8, height: 18 }}>
      <Animated.View style={[{ position: "absolute", left: 1, bottom: 0, width: 6, height: 6, borderRadius: 3, backgroundColor: palette.blue }, style]} />
    </View>
  );
}
