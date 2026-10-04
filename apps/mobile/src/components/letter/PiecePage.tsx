import type { LetterPiece } from "@fs/schema";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, palette } from "@/components/onboarding/kit";
import { PagerIcon } from "@/components/pager/icons";
import { usePillSpace } from "@/components/pager/Pill";
import { Mono } from "@/components/pager/PagerScreen";
import { AuthorChip } from "./Author";
import { PhotoBackdrop } from "./Photo";
import { ProgressBars } from "./ProgressBars";

/** How much slower than the page the photo moves as it scrolls away. */
const PARALLAX = 0.45;

/**
 * One piece of the letter over its photo: the top of the piece's scroll, at
 * least a screen tall, with the article flowing on beneath it (the Reader's
 * `lead`). The photo scrolls at a little under half speed and stretches when
 * pulled down past the top; with Reduce Motion on it simply scrolls. Read
 * scrolls to the start of the article; on a video, the play button opens it.
 */
export function PiecePage({
  piece,
  letterNumber,
  pieceCount,
  page,
  pageCount,
  height,
  scrollY,
  onRead,
  onPlay,
  onSkip,
  onAuthor,
}: {
  piece: LetterPiece;
  letterNumber: number;
  pieceCount: number;
  page: number;
  pageCount: number;
  /** The screen's height: the page is at least this tall. */
  height: number;
  /** The piece's scroll offset, for the photo's parallax. */
  scrollY: SharedValue<number>;
  onRead: () => void;
  onPlay: () => void;
  onSkip: () => void;
  onAuthor: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { space } = usePillSpace();
  const reduceMotion = useReducedMotion();
  const video = piece.kind === "video";
  const len = `${piece.minutes} min`;

  const photoStyle = useAnimatedStyle(() => {
    const y = scrollY.get();
    // Pulled down past the top: grow to cover the gap rather than show the ground above.
    if (y < 0) return { transform: [{ translateY: y / 2 }, { scale: 1 - y / Math.max(1, height) }] };
    return { transform: [{ translateY: reduceMotion ? 0 : Math.min(y, height) * PARALLAX }, { scale: 1 }] };
  });

  return (
    <View
      style={{ minHeight: height, overflow: "hidden" }}
      accessibilityActions={[{ name: "activate", label: video ? "Watch" : "Read" }]}
      onAccessibilityAction={(e) => e.nativeEvent.actionName === "activate" && onRead()}
    >
      <Animated.View style={[StyleSheet.absoluteFill, photoStyle]}>
        <PhotoBackdrop image={piece.image} topic={piece.topic} variant="piece" />
      </Animated.View>

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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${video ? "Watch" : "Read"}, ${len}`}
            accessibilityHint={video ? "Scrolls to the chapters" : "Scrolls to the start of the article"}
            onPress={onRead}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 52, borderRadius: 999, backgroundColor: "#FFFFFF", paddingHorizontal: 20, opacity: pressed ? 0.88 : 1 })}
          >
            <Text style={{ fontFamily: font.bodySemi, fontSize: 16, color: palette.ink }}>
              {video ? "Watch" : "Read"} · {len}
            </Text>
            <PagerIcon name="down" size={18} color={palette.ink} />
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onSkip} style={{ marginLeft: "auto", minHeight: 44, justifyContent: "center" }}>
            <Text style={{ fontFamily: font.body, fontSize: 14, color: "rgba(255,255,255,0.75)", textDecorationLine: "underline" }}>Skip this one</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
