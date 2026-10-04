import { useEffect, useState } from "react";
import { AccessibilityInfo, Animated, Text, View } from "react-native";
import type { Preview, StageIcon } from "@/lib/onboarding";
import { BoardIcon, type BoardIconName } from "./icons";
import { em, font, usePalette } from "./kit";

const ICON: Record<StageIcon, BoardIconName> = {
  envelope: "envelope",
  note: "note",
  pencil: "pencil",
  shield: "shield",
  stamp: "stamp",
  truck: "truck",
};

/** .prev: the letter being written as the user answers (design: "Letter card 1 · Tinted card, simple list"). */
export function LetterPreview({ preview }: { preview: Preview }) {
  const p = usePalette();
  const rule = { borderBottomWidth: 1, borderBottomColor: p.cardRule };
  return (
    <View
      accessible
      accessibilityLabel={`Your letter so far. ${preview.status}.${preview.when ? ` ${preview.when}.` : ""} ${preview.headline}. ${preview.items.map((i) => i.title).join(". ")}. ${preview.ps}`}
      // The board's card is 288px tall. On a phone a two-line headline plus a long P.S. needs more,
      // so that's the minimum and the card grows rather than letting the P.S. spill out of it.
      style={{ backgroundColor: p.blueCard, borderRadius: 24, paddingHorizontal: 18, paddingVertical: 16, gap: 10, minHeight: 288, overflow: "hidden" }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: p.surface, borderRadius: 999, paddingLeft: 9, paddingRight: 11, paddingVertical: 6, flexShrink: 1 }}>
          <BoardIcon name={ICON[preview.icon]} size={16} color={p.blue} />
          <Text numberOfLines={1} style={{ fontFamily: font.bodySemi, fontSize: 13, lineHeight: 17, color: p.ink, flexShrink: 1 }}>
            {preview.status}
          </Text>
          <Dots color={p.ink} />
        </View>
        {preview.when && (
          <Text numberOfLines={1} style={{ flexShrink: 0, fontFamily: font.mono, fontSize: 11, lineHeight: 15, letterSpacing: em(0.08, 11), textTransform: "uppercase", color: p.cardInk }}>
            {preview.when}
          </Text>
        )}
      </View>

      <Text numberOfLines={2} style={{ fontFamily: font.display, fontSize: 24, lineHeight: 25.92, letterSpacing: em(-0.025, 24), color: p.ink }}>
        {preview.headline}
      </Text>

      <View style={{ borderTopWidth: 1, borderTopColor: p.cardRule }}>
        {preview.items.map((it) => (
          <View key={it.title} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, ...rule }}>
            <BoardIcon name={it.video ? "video" : "article"} size={15} color={p.blue} />
            <Text numberOfLines={1} style={{ flex: 1, fontFamily: font.bodySemi, fontSize: 14.5, lineHeight: 18.85, color: p.ink }}>
              {it.title}
            </Text>
            <Text style={{ fontFamily: font.mono, fontSize: 12, lineHeight: 16, color: p.cardInk }}>{it.length}</Text>
          </View>
        ))}
        {Array.from({ length: preview.ghosts }, (_, i) => (
          <View key={i} style={{ paddingTop: 12, paddingBottom: 11, paddingLeft: 25, ...rule }}>
            <View style={{ height: 9, borderRadius: 5, backgroundColor: p.ghost, width: "65%" }} />
          </View>
        ))}
      </View>

      <View style={{ flexGrow: 1 }} />
      <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }} accessibilityLiveRegion="polite">
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.orange, marginTop: 6 }} />
        <Text numberOfLines={3} style={{ flex: 1, fontFamily: font.body, fontSize: 13, lineHeight: 18.2, color: p.cardInk }}>
          {preview.ps}
        </Text>
      </View>
    </View>
  );
}

/** .dots: "…" blinking in turn (1.4s, 0.2s apart); still when reduced motion is on. */
function Dots({ color }: { color: string }) {
  const [values] = useState(() => [0, 1, 2].map(() => new Animated.Value(0.2)));
  useEffect(() => {
    const loops: Animated.CompositeAnimation[] = [];
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled) return;
      if (reduce) return values.forEach((v) => v.setValue(1));
      values.forEach((v, i) => {
        // @keyframes blink { 40% { opacity: 1 } } over 1.4s, each dot 0.2s after the last.
        const loop = Animated.loop(
          Animated.sequence([
            Animated.timing(v, { toValue: 1, duration: 560, useNativeDriver: false }),
            Animated.timing(v, { toValue: 0.2, duration: 840, useNativeDriver: false }),
          ]),
        );
        const t = setTimeout(() => loop.start(), i * 200);
        loops.push({ start: () => {}, stop: () => (clearTimeout(t), loop.stop()), reset: () => {} });
      });
    });
    return () => {
      cancelled = true;
      loops.forEach((l) => l.stop());
    };
  }, [values]);
  return (
    <View style={{ flexDirection: "row", marginLeft: -7 }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {values.map((v, i) => (
        <Animated.Text key={i} style={{ opacity: v, color, fontFamily: font.bodySemi, fontSize: 13, lineHeight: 17 }}>
          .
        </Animated.Text>
      ))}
    </View>
  );
}
