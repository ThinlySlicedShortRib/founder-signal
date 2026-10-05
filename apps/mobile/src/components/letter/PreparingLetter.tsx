import type { LetterStage } from "@fs/schema";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { ArtHero, useHeroStatusBar } from "@/components/art/ArtHero";
import { STYLES } from "@/components/art/styles";
import { useArt } from "@/components/art/useArt";
import { font, palette } from "@/components/onboarding/kit";
import { BoardIcon } from "@/components/onboarding/icons";
import { usePillSpace } from "@/components/pager/Pill";
import { AgentLine, Display, Mono, PagerScreen } from "@/components/pager/PagerScreen";
import { greeting, longDate, localDay } from "@/lib/format";

/** What the post office is doing, step by step. A letter that didn't search the web starts at "writing". */
const STEPS: { stage: LetterStage; label: string }[] = [
  { stage: "searching", label: "Searching the web for you" },
  { stage: "reading", label: "Reading what I found" },
  { stage: "writing", label: "Writing your letter" },
];

/**
 * Today while a letter is being put together now (the first letter after
 * onboarding, or a test letter): where it's got to, updating on its own,
 * until it opens here. Same page as EmptyToday, under the same pill.
 */
export function PreparingLetter({ stage, isTest }: { stage: LetterStage | null; isTest: boolean }) {
  const { space } = usePillSpace();
  const at = stage === "sent" ? STEPS.length : Math.max(0, STEPS.findIndex((s) => s.stage === stage));
  const current = stage === "sent" ? "It's ready. Opening it now." : `${STEPS[at]!.label}…`;

  const day = localDay();
  const art = useArt({ seed: day, date: day, number: isTest ? null : 1 });
  const text = STYLES[art.style].text;
  const bar = useHeroStatusBar(art);

  return (
    <PagerScreen current="today" kicker="Today" title={stage === "sent" ? "Ready" : "Writing"} statusBar={bar.barStyle}>
      <ScrollView onScroll={bar.onScroll} scrollEventThrottle={32} contentContainerStyle={{ gap: 18, paddingHorizontal: 20, paddingBottom: space }}>
        <View style={{ marginHorizontal: -20 }}>
          <ArtHero art={art} drift onHeight={bar.onHeroHeight}>
            <Mono color={text.accent}>{isTest ? "Test letter" : "Letter No. 1"}</Mono>
            <Display size={38} lineHeight={40} color={text.primary}>
              {isTest ? "Your test letter is on its way." : "Your first letter is being put together."}
            </Display>
            <Text style={{ fontFamily: font.body, fontSize: 16, lineHeight: 22, color: text.secondary }}>
              <Text style={{ fontFamily: font.bodySemi, color: text.primary }}>{greeting()}</Text> · {longDate(day)}
            </Text>
          </ArtHero>
        </View>

        {/* The current step is announced as it changes; the list is for sighted users. */}
        <View accessibilityLiveRegion="polite" accessible accessibilityLabel={current} style={{ gap: 12, paddingVertical: 4 }}>
          {STEPS.map((s, i) => {
            const done = i < at;
            const now = i === at && stage !== null;
            return (
              <View key={s.stage} importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 28 }}>
                <View style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center" }}>
                  {done ? (
                    <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: palette.blue, alignItems: "center", justifyContent: "center" }}>
                      <BoardIcon name="check" size={14} color={palette.onBlue} />
                    </View>
                  ) : now ? (
                    <ActivityIndicator color={palette.blue} />
                  ) : (
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: palette.line }} />
                  )}
                </View>
                <Text style={{ flex: 1, fontFamily: now ? font.bodySemi : font.body, fontSize: 16, lineHeight: 22, color: done || now ? palette.ink : palette.muted }}>
                  {s.label}
                </Text>
              </View>
            );
          })}
        </View>

        <AgentLine>
          {isTest
            ? "It usually takes a minute or two, a few more when I search the web first. It'll open here when it's ready."
            : "You don't follow anything yet, so I'm looking around the web for pieces that fit what you told me. It usually takes a few minutes, and it'll open here when it's ready."}
        </AgentLine>
      </ScrollView>
    </PagerScreen>
  );
}
