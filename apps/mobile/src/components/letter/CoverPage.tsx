import type { LetterView } from "@fs/schema";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, palette } from "@/components/onboarding/kit";
import { usePillSpace } from "@/components/pager/Pill";
import { AgentLine, Display, Mono } from "@/components/pager/PagerScreen";
import { dayAndTime, greeting, longDate } from "@/lib/format";
import { TINTS } from "./Photo";
import { PieceIcon } from "./PieceIcon";
import { ProgressBars } from "./ProgressBars";

/** Page 1 of a letter: date, greeting, "Letter No. N", headline, the post office's line and the contents. */
export function CoverPage({ letter, pageCount, onPiece }: { letter: LetterView; pageCount: number; onPiece: (position: number) => void }) {
  const insets = useSafeAreaInsets();
  const { space } = usePillSpace();
  return (
    <View style={{ flex: 1, backgroundColor: palette.ground }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: insets.top + 14, paddingHorizontal: 20, minHeight: 56 }}>
        <Mono>Founder Signal · No. {letter.number}</Mono>
        <ProgressBars page={0} count={pageCount} />
      </View>
      <ScrollView contentContainerStyle={{ gap: 18, paddingTop: 12, paddingHorizontal: 20, paddingBottom: space }}>
        <View style={{ gap: 4 }}>
          <Text style={{ fontFamily: font.body, fontSize: 16, color: palette.muted }}>{longDate(letter.localDate)}</Text>
          <Text style={{ fontFamily: font.bodySemi, fontSize: 16, color: palette.ink }}>{greeting()}</Text>
        </View>
        <Mono color={palette.blue}>
          {letter.isTest ? "Test letter" : `Letter No. ${letter.number}`}
          {letter.deliveredAt ? ` · arrived ${dayAndTime(letter.deliveredAt)}` : ""}
        </Mono>
        <Display size={52} lineHeight={54}>
          {letter.headline}
        </Display>
        <AgentLine>{letter.intro}</AgentLine>
        {letter.whyThisMix && <AgentLine>{letter.whyThisMix}</AgentLine>}
        <View accessibilityRole="list" style={{ borderTopWidth: 1, borderTopColor: palette.cardRule }}>
          {letter.pieces.map((p, i) => (
            <Pressable
              key={p.itemId}
              accessibilityRole="button"
              accessibilityLabel={`Piece ${p.position}: ${p.title}, ${p.minutes} minutes${p.kind === "video" ? ", video" : ""}`}
              onPress={() => onPiece(p.position)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                minHeight: 56,
                paddingVertical: 6,
                borderBottomWidth: 1,
                borderBottomColor: palette.cardRule,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <PieceIcon icon={p.icon} tint={TINTS[i % 3]} />
              <Text style={{ flex: 1, fontFamily: font.bodySemi, fontSize: 15, lineHeight: 19.5, color: palette.ink, opacity: p.skipped ? 0.5 : 1 }}>{p.title}</Text>
              <Text style={{ fontFamily: font.body, fontSize: 13, color: palette.muted }}>
                {p.completed || p.verdict ? "✓ " : ""}
                {p.minutes} min
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
