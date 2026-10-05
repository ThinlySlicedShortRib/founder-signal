import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { ArtHero, useHeroStatusBar } from "@/components/art/ArtHero";
import { STYLES } from "@/components/art/styles";
import { useArt } from "@/components/art/useArt";
import { font, InlineError, OButton } from "@/components/onboarding/kit";
import { usePillSpace } from "@/components/pager/Pill";
import { AgentLine, Display, Mono, PagerScreen } from "@/components/pager/PagerScreen";
import { clock, greeting, longDate, localDay, weekday } from "@/lib/format";
import { useTestLetter } from "@/lib/letters";
import { presetLabel } from "@/lib/onboarding";
import { useProfile } from "@/lib/profile";

/** What to say when the letter Today was following ended without being sent. */
const ENDED = {
  empty: "I couldn't find anything new for you this time. Add a source you like, or try again in a little while and I'll search again.",
  failed: "Something went wrong while I was putting your letter together. Try again in a minute.",
};

/**
 * Today before the first letter: when it arrives, and a test letter to try
 * the app now. `ended` says why the letter it was following (the first one,
 * or a test letter) didn't arrive.
 */
export function EmptyToday({ ended }: { ended: "empty" | "failed" | null }) {
  const { space } = usePillSpace();
  const schedule = useProfile().data?.schedule;
  const test = useTestLetter();
  const [note, setNote] = useState<string | null>(null);

  const next = schedule && !schedule.paused && schedule.nextRunAt ? new Date(schedule.nextRunAt) : null;
  const when = next ? `${weekday(next)}, ${clock(next)}` : null;

  function sendTest() {
    setNote(null);
    test.mutate(undefined, {
      onSuccess: (res) => {
        // Today follows the new letter from here (lib/letters.ts `trackLetter`).
        if (!res) setNote("Test letters aren't switched on yet. Your first letter will still arrive on schedule.");
      },
    });
  }

  const day = localDay();
  const art = useArt({ seed: day, date: day, number: 1 });
  const text = STYLES[art.style].text;
  const bar = useHeroStatusBar(art);

  return (
    <PagerScreen current="today" kicker="Today" title="Soon" statusBar={bar.barStyle}>
      <ScrollView onScroll={bar.onScroll} scrollEventThrottle={32} contentContainerStyle={{ gap: 18, paddingHorizontal: 20, paddingBottom: space }}>
        <View style={{ marginHorizontal: -20 }}>
          <ArtHero art={art} onHeight={bar.onHeroHeight}>
            <Mono color={text.accent}>{when ? `Letter No. 1 · arrives ${when}` : "Letter No. 1"}</Mono>
            <Display size={38} lineHeight={40} color={text.primary}>
              {when ? `See you ${when}.` : "Your first letter is on its way."}
            </Display>
            <Text style={{ fontFamily: font.body, fontSize: 16, lineHeight: 22, color: text.secondary }}>
              <Text style={{ fontFamily: font.bodySemi, color: text.primary }}>{greeting()}</Text> · {longDate(day)}
            </Text>
          </ArtHero>
        </View>
        {ended ? (
          <View accessibilityRole="alert">
            <AgentLine>{ENDED[ended]}</AgentLine>
          </View>
        ) : (
          <AgentLine>
            {schedule?.paused
              ? "Your letters are paused. Pick a schedule in Preferences and I'll start again."
              : schedule?.preset
                ? `I'm reading your sources now. Your first letter arrives ${presetLabel(schedule.preset)}${when ? `, starting ${when}` : ""}: a few pieces, and a line on why each one is worth it.`
                : "I'm reading your sources now. Choose when your letter arrives in Preferences and the first one will follow."}
          </AgentLine>
        )}
        <OButton title={ended ? "Try again" : "Send me a test letter"} loading={test.isPending} onPress={sendTest} style={PILL_BUTTON} />
        {note && <AgentLine>{note}</AgentLine>}
        {test.isError && <InlineError message={test.error.message} onRetry={sendTest} />}
        <OButton title="Your sources" kind="secondary" onPress={() => router.push("/sources")} style={PILL_BUTTON} />
      </ScrollView>
    </PagerScreen>
  );
}

/** The pager boards' buttons are pills (.btn), not onboarding's rounded rectangles. */
const PILL_BUTTON = { borderRadius: 999, minHeight: 52 };
