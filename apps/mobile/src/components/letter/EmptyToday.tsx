import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, InlineError, OButton, palette } from "@/components/onboarding/kit";
import { usePillSpace } from "@/components/pager/Pill";
import { AgentLine, Display, Mono, PagerScreen } from "@/components/pager/PagerScreen";
import { clock, greeting, longDate, localDay, weekday } from "@/lib/format";
import { useTestLetter } from "@/lib/letters";
import { presetLabel } from "@/lib/onboarding";
import { useProfile } from "@/lib/profile";

/** Today before the first letter: when it arrives, and a test letter to try the app now. */
export function EmptyToday({ polling, onPoll }: { polling: boolean; onPoll: () => void }) {
  const insets = useSafeAreaInsets();
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
        if (!res) {
          setNote("Test letters aren't switched on yet. Your first letter will still arrive on schedule.");
          return;
        }
        onPoll();
      },
    });
  }

  return (
    <PagerScreen current="today" kicker="Today" title="Soon">
      <ScrollView contentContainerStyle={{ gap: 18, paddingTop: insets.top + 22, paddingHorizontal: 20, paddingBottom: space }}>
        <View style={{ gap: 4 }}>
          <Text style={{ fontFamily: font.body, fontSize: 16, color: palette.muted }}>{longDate(localDay())}</Text>
          <Text style={{ fontFamily: font.bodySemi, fontSize: 16, color: palette.ink }}>{greeting()}</Text>
        </View>
        <Mono color={palette.blue}>{when ? `Letter No. 1 · arrives ${when}` : "Letter No. 1"}</Mono>
        <Display size={52} lineHeight={54}>
          {when ? `See you ${when}.` : "Your first letter is on its way."}
        </Display>
        <AgentLine>
          {schedule?.paused
            ? "Your letters are paused. Pick a schedule in Preferences and I'll start again."
            : schedule?.preset
              ? `I'm reading your sources now. Your first letter arrives ${presetLabel(schedule.preset)}${when ? `, starting ${when}` : ""}: a few pieces, and a line on why each one is worth it.`
              : "I'm reading your sources now. Choose when your letter arrives in Preferences and the first one will follow."}
        </AgentLine>
        <OButton title={polling ? "Writing your test letter…" : "Send me a test letter"} loading={test.isPending || polling} onPress={sendTest} style={PILL_BUTTON} />
        {polling && (
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <ActivityIndicator color={palette.muted} />
            <Text style={{ flex: 1, fontFamily: font.body, fontSize: 14, color: palette.muted }}>It usually takes a minute or two. It&apos;ll open here when it&apos;s ready.</Text>
          </View>
        )}
        {note && <AgentLine>{note}</AgentLine>}
        {test.isError && <InlineError message={test.error.message} onRetry={sendTest} />}
        <OButton title="Your sources" kind="secondary" onPress={() => router.push("/sources")} style={PILL_BUTTON} />
      </ScrollView>
    </PagerScreen>
  );
}

/** The pager boards' buttons are pills (.btn), not onboarding's rounded rectangles. */
const PILL_BUTTON = { borderRadius: 999, minHeight: 52 };
