import type { LetterPiece } from "@fs/schema";
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { font, palette } from "@/components/onboarding/kit";
import { PagerIcon } from "@/components/pager/icons";
import { usePillSpace } from "@/components/pager/Pill";
import { Mono } from "@/components/pager/PagerScreen";
import { Avatar, PhotoBackdrop } from "./Photo";
import { ProgressBars } from "./ProgressBars";

/** Past this, letting go opens the piece (PagerToday: THRESHOLD). */
export const PULL_THRESHOLD = 140;
/** The sheet filling the screen before the reader takes over. */
export const RISE_MS = 320;
const RISE_EASING = Easing.bezier(0.2, 0.8, 0.2, 1);

/**
 * One piece of the letter over its photo. Pull up anywhere on the page and a
 * white sheet rises with the finger ("Keep pulling to read"); past 140px it
 * says "Release to read" and resists; let go past it and the sheet fills the
 * screen and the reader opens; short of it, it springs back. The Read button
 * plays the same rise. With Reduce Motion on, both open the reader at once.
 */
export function PiecePage({
  piece,
  letterNumber,
  pieceCount,
  page,
  pageCount,
  onRead,
  onSkip,
  onAuthor,
}: {
  piece: LetterPiece;
  letterNumber: number;
  pieceCount: number;
  page: number;
  pageCount: number;
  onRead: () => void;
  onSkip: () => void;
  onAuthor: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { space } = usePillSpace();
  const reduceMotion = useReducedMotion();
  const pull = useSharedValue(0);
  const entering = useSharedValue(false);
  const height = useSharedValue(800);
  const [ready, setReady] = useState(false);
  const video = piece.kind === "video";
  const len = `${piece.minutes} min`;

  const open = useCallback(() => onRead(), [onRead]);

  // The sheet fills the screen, then the reader takes over. Runs on either thread.
  const fill = useCallback(() => {
    "worklet";
    entering.set(true);
    pull.set(
      withTiming(height.get(), { duration: RISE_MS, easing: RISE_EASING }, (done) => {
        if (done) scheduleOnRN(open);
      }),
    );
  }, [entering, pull, height, open]);

  const rise = useCallback(() => {
    if (entering.get()) return;
    if (reduceMotion) return open();
    fill();
  }, [entering, reduceMotion, open, fill]);

  const pan = Gesture.Pan()
    .activeOffsetY(-8)
    .failOffsetX([-24, 24])
    .onUpdate((e) => {
      if (entering.get()) return;
      const d = Math.max(0, -e.translationY);
      pull.set(d <= PULL_THRESHOLD ? d : PULL_THRESHOLD + (d - PULL_THRESHOLD) * 0.35);
    })
    .onEnd(() => {
      if (entering.get()) return;
      if (pull.get() < PULL_THRESHOLD) pull.set(withSpring(0, { damping: 22, stiffness: 260 }));
      else if (reduceMotion) scheduleOnRN(open);
      else fill();
    });

  useAnimatedReaction(
    () => pull.get() >= PULL_THRESHOLD,
    (now, before) => {
      if (now !== before) scheduleOnRN(setReady, now);
    },
  );

  const sheetStyle = useAnimatedStyle(() => ({ height: pull.get() }));
  const bodyStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.min(pull.get(), 400) * 0.45 }],
    opacity: entering.get() ? Math.max(0, 1 - pull.get() / 300) : 1 - (Math.min(pull.get(), PULL_THRESHOLD) / PULL_THRESHOLD) * 0.5,
  }));

  return (
    <GestureDetector gesture={pan}>
      <View
        style={{ flex: 1, overflow: "hidden" }}
        onLayout={(e) => {
          height.set(e.nativeEvent.layout.height);
        }}
        accessibilityActions={[{ name: "activate", label: video ? "Watch" : "Read" }]}
        onAccessibilityAction={(e) => e.nativeEvent.actionName === "activate" && rise()}
      >
        <PhotoBackdrop image={piece.image} topic={piece.topic} />

        <View style={{ zIndex: 2, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: insets.top + 14, paddingHorizontal: 20, minHeight: 56 }}>
          <Mono color="rgba(255,255,255,0.92)">
            No. {letterNumber} · Piece {piece.position} of {pieceCount}
          </Mono>
          <ProgressBars page={page} count={pageCount} light />
        </View>

        {/* The play button sits in the space above the text, so a long title never runs under it. */}
        <View style={{ flex: 1, zIndex: 2, alignItems: "center", justifyContent: "center", pointerEvents: "box-none" }}>
          {video && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Play the video"
              onPress={rise}
              style={{ width: 76, height: 76, borderRadius: 38, backgroundColor: "rgba(255,255,255,0.92)", alignItems: "center", justifyContent: "center" }}
            >
              <PagerIcon name="play" size={30} color={palette.ink} />
            </Pressable>
          )}
        </View>

        <Animated.View style={[{ zIndex: 2, gap: 14, paddingHorizontal: 20, paddingBottom: space - 6 }, bodyStyle]}>
          <Mono color="rgba(255,255,255,0.85)">
            {video ? "Video" : "Article"} · {len} · {piece.topic}
          </Mono>
          <Text accessibilityRole="header" style={{ fontFamily: font.display, fontSize: 40, lineHeight: 42, letterSpacing: -1.4, color: "#FFFFFF" }}>
            {piece.title}
          </Text>
          {piece.author && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`About the author, ${piece.author.name}`}
              onPress={onAuthor}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                alignSelf: "flex-start",
                maxWidth: "100%",
                backgroundColor: "rgba(255,255,255,0.14)",
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.2)",
                borderRadius: 999,
                paddingVertical: 5,
                paddingLeft: 5,
                paddingRight: 12,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <Avatar initials={piece.author.initials} keyStr={piece.author.key} />
              <View style={{ flexShrink: 1, minWidth: 0 }}>
                <Text style={{ fontFamily: font.bodySemi, fontSize: 14, lineHeight: 18, color: "#FFFFFF" }}>{piece.author.name}</Text>
                {piece.author.headline && (
                  <Text numberOfLines={1} style={{ fontFamily: font.body, fontSize: 12.5, lineHeight: 16, color: "rgba(255,255,255,0.78)" }}>
                    {piece.author.headline}
                  </Text>
                )}
              </View>
              <PagerIcon name="chevron-right" size={16} color="rgba(255,255,255,0.8)" />
            </Pressable>
          )}
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
              accessibilityHint="Or pull up anywhere on the page"
              onPress={rise}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 52, borderRadius: 999, backgroundColor: "#FFFFFF", paddingHorizontal: 20, opacity: pressed ? 0.88 : 1 })}
            >
              <Text style={{ fontFamily: font.bodySemi, fontSize: 16, color: palette.ink }}>
                {video ? "Watch" : "Read"} · {len}
              </Text>
              <PagerIcon name="up" size={18} color={palette.ink} />
            </Pressable>
            <Pressable accessibilityRole="button" onPress={onSkip} style={{ marginLeft: "auto", minHeight: 44, justifyContent: "center" }}>
              <Text style={{ fontFamily: font.body, fontSize: 14, color: "rgba(255,255,255,0.75)", textDecorationLine: "underline" }}>Skip this one</Text>
            </Pressable>
          </View>
        </Animated.View>

        {/* The reading sheet that rises with the finger (.pullsheet). */}
        <Animated.View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            {
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 4,
              pointerEvents: "none",
              backgroundColor: "#FFFFFF",
              borderTopLeftRadius: 26,
              borderTopRightRadius: 26,
              overflow: "hidden",
              alignItems: "center",
              gap: 10,
              boxShadow: "0 -10px 30px rgba(18,19,22,0.18)",
            },
            sheetStyle,
          ]}
        >
          <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: palette.lineSoft, marginTop: 9 }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <PagerIcon name="up" size={16} color={ready ? palette.blue : palette.ink} />
            <Text style={{ fontFamily: font.bodySemi, fontSize: 14, color: ready ? palette.blue : palette.ink }}>{ready ? "Release to read" : "Keep pulling to read"}</Text>
          </View>
          <View style={{ alignSelf: "stretch", paddingTop: 4, paddingHorizontal: 20, gap: 12 }}>
            <Mono>
              {video ? "Video" : "Article"} · {len}
            </Mono>
            <Text style={{ fontFamily: font.display, fontSize: 22, lineHeight: 24, letterSpacing: -0.66, color: palette.ink }}>{piece.title}</Text>
            <Text style={{ fontFamily: font.body, fontSize: 16, lineHeight: 24.8, color: palette.promptInk }}>{piece.summary}</Text>
          </View>
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
