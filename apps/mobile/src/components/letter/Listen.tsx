import { useEffect } from "react";
import { Text, View } from "react-native";
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { font, palette } from "@/components/onboarding/kit";
import { PagerIcon } from "@/components/pager/icons";
import { Mono } from "@/components/pager/PagerScreen";
import { useEpisodeTask } from "@/lib/listen";
import { EpisodeStrip } from "./EpisodeStatus";

/**
 * "Listen" (the podcast experiment): the piece as a short episode, two hosts
 * talking it through. In the article, under the byline: where a reader
 * starts an episode, and a mirror of the pill's status row while it's made,
 * ready, playing or done (the same `useEpisodeTask`, so they always agree).
 * Only for pieces the app may show in full.
 *
 * `flash` (a counter) rings the card once: the pill's row was tapped and
 * brought the reader here.
 */
export function ListenCard({ itemId, flash = 0 }: { itemId: string; flash?: number }) {
  const task = useEpisodeTask(itemId);
  const reduce = useReducedMotion();
  const ring = useSharedValue(0);
  useEffect(() => {
    if (!flash || reduce) return;
    ring.set(0);
    ring.set(withDelay(250, withTiming(1, { duration: 760, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.Never })));
  }, [flash, reduce, ring]);
  // A soft blue ring that spreads 9pt out from the card's edge and fades (the mock's box-shadow pulse).
  const ringStyle = useAnimatedStyle(() => {
    const p = ring.get();
    const out = 9 * p;
    return { opacity: p > 0 && p < 1 ? 0.45 * (1 - p) : 0, left: -out, right: -out, top: -out, bottom: -out, borderWidth: Math.max(0.01, out), borderRadius: 16 + out };
  });

  if (!task.available) return null;
  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderColor: palette.blueCard, backgroundColor: palette.blueTint, paddingTop: 11, paddingBottom: 12, paddingHorizontal: 13, gap: 9 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <PagerIcon name="headphones" size={16} strokeWidth={2.2} color={palette.blue} />
        <Text style={{ fontFamily: font.bodySemi, fontSize: 14, lineHeight: 17, color: palette.ink }}>Listen to this piece</Text>
        <Mono style={{ marginLeft: "auto", fontSize: 10 }} color={palette.muted}>
          Two hosts
        </Mono>
      </View>
      <View style={{ height: 40, flexDirection: "row", alignItems: "center" }}>
        <EpisodeStrip task={task} tone="light" card />
      </View>
      <Animated.View style={[{ position: "absolute", borderColor: palette.blue, pointerEvents: "none" }, ringStyle]} />
    </View>
  );
}
