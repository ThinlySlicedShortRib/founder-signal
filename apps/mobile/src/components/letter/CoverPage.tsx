import type { LetterView } from "@fs/schema";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ArtHero, useHeroStatusBar } from "@/components/art/ArtHero";
import { STYLES } from "@/components/art/styles";
import { useArt } from "@/components/art/useArt";
import { font, palette } from "@/components/onboarding/kit";
import { usePillSpace } from "@/components/pager/Pill";
import { AgentLine, Display, Mono } from "@/components/pager/PagerScreen";
import { dayAndTime, greeting, longDate } from "@/lib/format";
import { TINTS } from "./Photo";
import { ProgressBars } from "./ProgressBars";

/**
 * Page 1 of a letter, like a magazine cover: the day's art with the masthead,
 * "Letter No. N", the headline and the greeting on it; below, the post
 * office's note (two lines until "More") and the contents.
 */
export function CoverPage({ letter, pageCount, onPiece }: { letter: LetterView; pageCount: number; onPiece: (position: number) => void }) {
  const { space } = usePillSpace();
  const art = useArt({ seed: letter.id, date: letter.localDate, number: letter.isTest ? null : letter.number });
  const text = STYLES[art.style].text;
  const bar = useHeroStatusBar(art);
  return (
    <View style={{ flex: 1, backgroundColor: palette.ground }}>
      <StatusBar style={bar.barStyle} />
      <ScrollView onScroll={bar.onScroll} scrollEventThrottle={32} contentContainerStyle={{ gap: 18, paddingHorizontal: 20, paddingBottom: space }}>
        {/* Full bleed: the hero takes back the page's side padding. */}
        <View style={{ marginHorizontal: -20 }}>
          <ArtHero
            art={art}
            onHeight={bar.onHeroHeight}
            masthead={
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Mono color={text.secondary}>Founder Signal · No. {letter.number}</Mono>
                <ProgressBars page={0} count={pageCount} light={STYLES[art.style].tone === "dark"} />
              </View>
            }
          >
            <Mono color={text.accent}>
              {letter.isTest ? "Test letter" : `Letter No. ${letter.number}`}
              {letter.deliveredAt ? ` · arrived ${dayAndTime(letter.deliveredAt)}` : ""}
            </Mono>
            <Display size={38} lineHeight={40} color={text.primary}>
              {letter.headline}
            </Display>
            <Text style={{ fontFamily: font.body, fontSize: 16, lineHeight: 22, color: text.secondary }}>
              <Text style={{ fontFamily: font.bodySemi, color: text.primary }}>{greeting()}</Text> · {longDate(letter.localDate)}
            </Text>
          </ArtHero>
        </View>
        <Brief intro={letter.intro} why={letter.whyThisMix} />
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
              <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: TINTS[i % 3], alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontFamily: font.mono, fontSize: 12, color: palette.ink }}>{String(p.position).padStart(2, "0")}</Text>
              </View>
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

/** The intro, two lines until "More", which opens it and why this mix. */
function Brief({ intro, why }: { intro: string; why: string | null }) {
  const [open, setOpen] = useState(false);
  const more = !!why || intro.length > 90;
  return (
    <View style={{ gap: 8 }}>
      <AgentLine numberOfLines={open ? undefined : 2}>{intro}</AgentLine>
      {open && why && <AgentLine>{why}</AgentLine>}
      {more && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={open ? "Less" : why ? "More, and why this mix" : "More"}
          onPress={() => setOpen((o) => !o)}
          hitSlop={8}
          style={{ alignSelf: "flex-start", minHeight: 32, justifyContent: "center", paddingHorizontal: 4 }}
        >
          <Text style={{ fontFamily: font.bodySemi, fontSize: 14, color: palette.blue }}>{open ? "Less" : why ? "More · why this mix" : "More"}</Text>
        </Pressable>
      )}
    </View>
  );
}
