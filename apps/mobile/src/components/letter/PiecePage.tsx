import type { LetterPiece } from "@fs/schema";
import { useEffect, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { cancelAnimation, Easing, type SharedValue, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { ArtHero, useBandScene } from "@/components/art/ArtHero";
import { pickPieceArt, STYLES } from "@/components/art/styles";
import { font, palette } from "@/components/onboarding/kit";
import { PagerIcon } from "@/components/pager/icons";
import { usePillSpace } from "@/components/pager/Pill";
import { Mono } from "@/components/pager/PagerScreen";
import { AuthorChip } from "./Author";
import { ProgressBars } from "./ProgressBars";

/** A piece page's art band fades into the paper over its last 48pt. */
const BAND = { fade: 48, bottomPad: 14 } as const;

/**
 * One piece of the letter, a fixed full-screen layer under the article's
 * drawer (the Reader's `lead`). The piece's own generative art (never the
 * source article's image) sits in a band at the top with the masthead,
 * kicker and headline on it, like Today's cover; the band takes the room the
 * text leaves, and below it the page is the art's own paper, ink on light.
 * Dragging up anywhere on it, or tapping Read article, brings the drawer up;
 * the Read and Listen row fades as it comes (`progress`). Skipping is in the
 * reader's More tray. On a video, the play
 * button (on the art) opens it on YouTube.
 */
export function PiecePage({
  piece,
  letter,
  letterNumber,
  pieceCount,
  page,
  pageCount,
  height,
  progress,
  onRead,
  onPlay,
  onListen,
  listening = false,
  onAuthor,
}: {
  piece: LetterPiece;
  /** What the piece's art is picked from: the letter's id, day and place in the sequence (its number; none for a test letter). */
  letter: { id: string; date: string; sequence: number | null };
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
  /** Its episode is being made, ready or playing: the headphones button turns blue. */
  listening?: boolean;
  onAuthor: () => void;
}) {
  const { space, statusH } = usePillSpace();
  const reduceMotion = useReducedMotion();
  // The text lifts to clear the pill, and again (with the row, 220ms) while the pill carries a status.
  const lift = useSharedValue(statusH);
  useEffect(() => {
    lift.set(withTiming(statusH, { duration: reduceMotion ? 0 : 220, easing: Easing.bezier(0.2, 0.8, 0.2, 1) }));
  }, [statusH, reduceMotion, lift]);
  const liftStyle = useAnimatedStyle(() => ({ paddingBottom: space - statusH - 6 + lift.get() }));
  const video = piece.kind === "video";
  const len = `${piece.minutes} min`;
  const label = video ? "Watch" : "Read article";

  const actionsStyle = useAnimatedStyle(() => ({ opacity: 1 - Math.min(1, Math.max(0, progress.get() * 2.5)) }));

  const art = useMemo(
    () => pickPieceArt({ letterId: letter.id, date: letter.date, sequence: letter.sequence, itemId: piece.itemId, position: piece.position }),
    [letter.id, letter.date, letter.sequence, piece.itemId, piece.position],
  );
  const text = STYLES[art.style].text;
  const scene = useBandScene(art);
  const band = useMemo(() => ({ ...BAND, scene }), [scene]);
  // Below the band the page is the art's own paper, so the band has no edge.
  const paper = scene.background;

  return (
    <View
      style={{ height, overflow: "hidden", backgroundColor: paper }}
      accessibilityActions={[{ name: "activate", label }]}
      onAccessibilityAction={(e) => e.nativeEvent.actionName === "activate" && onRead()}
    >
      <ArtHero
        art={art}
        band={band}
        masthead={
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Mono color={text.secondary}>
              No. {letterNumber} · Piece {piece.position} of {pieceCount}
            </Mono>
            <ProgressBars page={page} count={pageCount} />
          </View>
        }
        middle={
          video && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Play on YouTube"
              onPress={onPlay}
              style={({ pressed }) => ({
                width: 76,
                height: 76,
                borderRadius: 38,
                backgroundColor: palette.ink,
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 8px 22px rgba(18,19,22,0.22)",
                opacity: pressed ? 0.88 : 1,
              })}
            >
              <PagerIcon name="play" size={30} color="#FFFFFF" />
            </Pressable>
          )
        }
      >
        <Mono color={text.secondary}>
          {video ? "Video" : "Article"} · {len} · {piece.topic}
        </Mono>
        <Text accessibilityRole="header" style={{ fontFamily: font.display, fontSize: 30, lineHeight: 33, letterSpacing: -1.05, color: text.primary }}>
          {piece.title}
        </Text>
      </ArtHero>

      <Animated.View style={[{ gap: 12, paddingHorizontal: 20, paddingTop: 2 }, liftStyle]}>
        {piece.author && <AuthorChip author={piece.author} onPress={onAuthor} />}
        {piece.whyPicked && (
          <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", backgroundColor: palette.orangeTint, borderWidth: 1, borderColor: palette.tints[1], borderRadius: 16, paddingVertical: 11, paddingHorizontal: 13 }}>
            <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: palette.orange, marginTop: 3 }} />
            <Text style={{ flex: 1, fontFamily: font.body, fontSize: 15, lineHeight: 21, color: palette.noteInk }}>{piece.whyPicked}</Text>
          </View>
        )}
        {piece.tag && (
          <View style={{ alignSelf: "flex-start", borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10, backgroundColor: palette.blueTint }}>
            <Text style={{ fontFamily: font.bodySemi, fontSize: 12.5, color: palette.blueInk }}>{piece.tag}</Text>
          </View>
        )}
        <Text numberOfLines={3} style={{ fontFamily: font.body, fontSize: 16.5, lineHeight: 24, color: palette.promptInk }}>
          {piece.summary}
        </Text>
        {/* Read at its own width, with the round Listen button beside it (skipping is in the reader's More tray). */}
        <Animated.View style={[{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2 }, actionsStyle]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={video ? "Opens the chapters" : "Opens the article"}
            onPress={onRead}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 52, borderRadius: 999, backgroundColor: palette.ink, paddingHorizontal: 20, opacity: pressed ? 0.88 : 1 })}
          >
            <RisingDot />
            <Text style={{ fontFamily: font.bodySemi, fontSize: 16, color: "#FFFFFF" }}>{label}</Text>
          </Pressable>
          {onListen && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Listen"
              accessibilityHint={listening ? "Goes to the episode's Listen card" : "Makes a short two-host episode of the piece"}
              accessibilityState={{ selected: listening }}
              onPress={onListen}
              style={({ pressed }) => ({
                width: 52,
                height: 52,
                borderRadius: 26,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: listening ? palette.blue : "#FFFFFF",
                borderWidth: 1,
                borderColor: listening ? palette.blue : palette.line,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <PagerIcon name="headphones" size={22} color={listening ? "#FFFFFF" : palette.ink} />
            </Pressable>
          )}
        </Animated.View>
      </Animated.View>
    </View>
  );
}

/** The mock's `cubic-bezier(.4,0,.2,1)`, applied per keyframe segment as CSS does. */
const dotEase = Easing.bezierFn(0.4, 0, 0.2, 1);

/**
 * The hint to swipe up, in the Read button: a small light-blue dot that keeps rising (fades in over
 * the first 15%, rises 11px by 65%, fades out by the end, every 1.6s). Still, 5px up, with Reduce Motion.
 *
 * The clock runs linearly from 0 to 1 and every cycle starts by snapping back to 0. A bare
 * `withRepeat(withTiming(1))` restarts from wherever the value was left, so once Fast Refresh (or any
 * re-run of the effect) cancelled it near the end of a cycle, it looped over the last sliver only: the
 * dot sat risen and nearly transparent, a dark speck on the ink button.
 */
function RisingDot() {
  const reduceMotion = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    t.set(withRepeat(withSequence(withTiming(0, { duration: 0 }), withTiming(1, { duration: 1600, easing: Easing.linear })), -1, false));
    return () => cancelAnimation(t);
  }, [reduceMotion, t]);
  const style = useAnimatedStyle(() => {
    if (reduceMotion) return { opacity: 1, transform: [{ translateY: -5 }] };
    const p = t.get();
    // Keyframes: opacity 0 → 1 (15%) → 1 (65%) → 0 (100%); rise 0 → 11 (65%) → 12 (100%).
    const opacity = p < 0.15 ? dotEase(p / 0.15) : p < 0.65 ? 1 : 1 - dotEase((p - 0.65) / 0.35);
    const rise = p < 0.65 ? 11 * dotEase(p / 0.65) : 11 + dotEase((p - 0.65) / 0.35);
    return { opacity, transform: [{ translateY: -rise }] };
  });
  return (
    <View aria-hidden style={{ width: 8, height: 18 }}>
      <Animated.View style={[{ position: "absolute", left: 1, bottom: 0, width: 6, height: 6, borderRadius: 3, backgroundColor: palette.blueMid }, style]} />
    </View>
  );
}
