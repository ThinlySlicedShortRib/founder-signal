import type { LetterView } from "@fs/schema";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ArtHero, useHeroStatusBar } from "@/components/art/ArtHero";
import { STYLES } from "@/components/art/styles";
import { useArt } from "@/components/art/useArt";
import { font, palette } from "@/components/onboarding/kit";
import { usePillSpace } from "@/components/pager/Pill";
import { Display, Mono } from "@/components/pager/PagerScreen";
import { dayAndTime, greeting, longDate } from "@/lib/format";
import { AuthorChip } from "./Author";
import { PieceIcon } from "./PieceIcon";
import { ProgressBars } from "./ProgressBars";

/**
 * Page 1 of a letter, like a magazine cover: the day's art with the masthead,
 * "Letter No. N", the headline and the greeting on it; below, the post
 * office's note (in full, with "why this mix" opening inside it) and the contents.
 */
export function CoverPage({
  letter,
  pageCount,
  onPiece,
  onAuthor,
}: {
  letter: LetterView;
  pageCount: number;
  onPiece: (position: number) => void;
  onAuthor: (author: NonNullable<LetterView["pieces"][number]["author"]>) => void;
}) {
  const { space } = usePillSpace();
  const art = useArt({ seed: letter.id, date: letter.localDate, number: letter.isTest ? null : letter.number, sequence: letter.isTest ? null : letter.number });
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
            {/* Board "Home A": the headline at Bricolage 500, lighter than the pager boards' 700. */}
            <Display size={38} lineHeight={40} color={text.primary} style={{ fontFamily: font.displayMedium }}>
              {letter.headline}
            </Display>
            <Text style={{ fontFamily: font.body, fontSize: 16, lineHeight: 22, color: text.secondary }}>
              <Text style={{ fontFamily: font.bodySemi, color: text.primary }}>{greeting()}</Text> · {longDate(letter.localDate)}
            </Text>
          </ArtHero>
        </View>
        <Brief intro={letter.intro} why={letter.whyThisMix} />
        <View accessibilityRole="list" style={{ borderTopWidth: 1, borderTopColor: palette.cardRule }}>
          {letter.pieces.map((p) => (
            <Pressable
              key={p.itemId}
              accessibilityRole="button"
              accessibilityLabel={`Piece ${p.position}: ${p.title}, ${p.minutes} minutes${p.kind === "video" ? ", video" : ""}`}
              onPress={() => onPiece(p.position)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 12,
                minHeight: 56,
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: palette.cardRule,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <PieceIcon icon={p.icon} />
              {/* Board "Home A": a lighter title, with the reader's author chip under it. */}
              <View style={{ flex: 1, gap: 8, opacity: p.skipped ? 0.5 : 1 }}>
                <Text style={{ fontFamily: font.bodyMedium, fontSize: 15, lineHeight: 19.5, color: palette.ink }}>{p.title}</Text>
                {p.author && <AuthorChip author={p.author} onPress={() => onAuthor(p.author!)} />}
              </View>
              <Text style={{ fontFamily: font.body, fontSize: 13, lineHeight: 19.5, color: palette.muted }}>
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

/**
 * The intro (a personal hook, up to ~200 characters) in full, in the
 * post office's orange card. When there's a "why this mix", a small control
 * at the card's bottom right opens it inside the same card, below the intro.
 */
function Brief({ intro, why }: { intro: string; why: string | null }) {
  const [open, setOpen] = useState(false);
  const text = { flexShrink: 1, fontFamily: font.body, fontSize: 15, lineHeight: 21.75, color: palette.noteInk } as const;
  return (
    <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", backgroundColor: palette.noteBg, borderRadius: 16, paddingTop: 13, paddingBottom: why ? 2 : 13, paddingHorizontal: 14 }}>
      <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: palette.orange, marginTop: 2 }} />
      <View style={{ flex: 1, gap: 8 }}>
        <Text style={text}>{intro}</Text>
        {open && !!why && <Text style={text}>{why}</Text>}
        {!!why && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Why this mix"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen((o) => !o)}
            hitSlop={4}
            style={({ pressed }) => ({ alignSelf: "flex-end", minHeight: 44, minWidth: 44, justifyContent: "center", paddingHorizontal: 4, marginTop: -8, opacity: pressed ? 0.6 : 1 })}
          >
            <Text style={{ fontFamily: font.bodySemi, fontSize: 14, color: palette.noteInk }}>{open ? "Less ▴" : "Why this mix ▾"}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
