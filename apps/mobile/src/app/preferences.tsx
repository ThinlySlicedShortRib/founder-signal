import { type DeliveryPreset, topics as catalog } from "@fs/schema";
import { router } from "expo-router";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SheetButton } from "@/components/letter/Author";
import { Chip, Chips, font, InlineError, palette } from "@/components/onboarding/kit";
import { PagerIcon } from "@/components/pager/icons";
import { usePillSpace } from "@/components/pager/Pill";
import { Display, Mono, PagerScreen } from "@/components/pager/PagerScreen";
import { Sheet } from "@/components/pager/Sheet";
import { authClient } from "@/lib/auth";
import { API_URL, APP_VERSION } from "@/lib/config";
import { confirm } from "@/lib/confirm";
import { plural } from "@/lib/format";
import { PRESETS, presetLabel, topicsText, withArticle } from "@/lib/onboarding";
import { useProfile, useUpdateProfile, useUpdateSchedule } from "@/lib/profile";
import { queryClient } from "@/lib/query";
import { fetchHealth, useSources } from "@/lib/sources";

/** Preferences (PagerPreferences): your brief in your own words, reading settings, account. */
export default function Preferences() {
  const insets = useSafeAreaInsets();
  const { space } = usePillSpace();
  const { data: session } = authClient.useSession();
  const profile = useProfile().data;
  const sources = useSources();
  const [sheet, setSheet] = useState<"topics" | "schedule" | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const list = sources.data ?? [];
  const needsLook = list.filter((s) => !s.blocked && fetchHealth(s).tone === "warning").length;
  const schedule = profile?.schedule;
  const when = schedule?.paused ? "Paused" : schedule?.preset ? PRESETS.find((p) => p.value === schedule.preset)!.when : "Not set";

  async function signOut() {
    const ok = await confirm({ title: "Sign out?", message: "You can sign back in with a code at any time.", confirmLabel: "Sign out" });
    if (!ok) return;
    setSigningOut(true);
    await authClient.signOut();
    queryClient.clear();
  }

  // "I'm a founder. Lately I've been into “…”. Send me more on …. Send it …."
  const brief: ReactNode[] = [];
  if (profile?.role) brief.push("I'm ", <Blue key="r">{withArticle(profile.role)}</Blue>, ". ");
  if (profile?.lately) brief.push("Lately I've been into ", <Blue key="l">“{profile.lately}”</Blue>, ". ");
  if (profile?.topics.length) brief.push("Send me more on ", <Blue key="t">{topicsText(profile.topics)}</Blue>, ". ");
  if (schedule?.preset) brief.push("Send it ", <Blue key="s">{presetLabel(schedule.preset)}</Blue>, ".");

  return (
    <PagerScreen current="preferences" kicker="Settings" title="Preferences">
      <ScrollView contentContainerStyle={{ gap: 18, paddingTop: insets.top + 22, paddingHorizontal: 20, paddingBottom: space }}>
        <Mono>Preferences</Mono>
        <Display size={56} lineHeight={58}>
          Your brief
        </Display>
        <Text style={{ fontFamily: font.displayMedium, fontSize: 24, lineHeight: 32.4, letterSpacing: -0.36, color: palette.ink }}>
          {brief.length ? brief : "Tell me what you're working on and I'll pick better pieces."}
        </Text>

        <View>
          <Mono>Reading</Mono>
          <PrefRow
            label="Sources"
            detail={sources.data ? (list.length ? `${plural(list.length, "source")}${needsLook ? ` · ${needsLook} needs a look` : ""}` : "None yet") : "…"}
            onPress={() => router.push("/sources")}
          />
          <PrefRow label="Goals and topics" detail={profile?.topics.length ? plural(profile.topics.length, "topic") : "None yet"} onPress={() => setSheet("topics")} />
          <PrefRow label="Schedule" detail={when} onPress={() => setSheet("schedule")} />
        </View>

        <View>
          <Mono>Account</Mono>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, minHeight: 64, borderBottomWidth: 1, borderBottomColor: palette.rule }}>
            <Text numberOfLines={1} style={{ flex: 1, fontFamily: font.display, fontSize: 18, letterSpacing: -0.36, color: palette.ink }}>
              {session?.user.email}
            </Text>
            <Pressable accessibilityRole="button" onPress={signOut} disabled={signingOut} style={{ minHeight: 44, justifyContent: "center" }}>
              <Text style={{ fontFamily: font.bodySemi, fontSize: 15, color: palette.blue }}>{signingOut ? "Signing out…" : "Sign out"}</Text>
            </Pressable>
          </View>
        </View>

        <Text style={{ textAlign: "center", fontFamily: font.body, fontSize: 12.5, color: palette.offText }}>
          Founder Signal {APP_VERSION}
          {__DEV__ ? ` · ${API_URL}` : ""}
        </Text>
      </ScrollView>

      <TopicsSheet open={sheet === "topics"} current={profile?.topics ?? []} onClose={() => setSheet(null)} />
      <ScheduleSheet open={sheet === "schedule"} current={schedule?.preset ?? null} onClose={() => setSheet(null)} />
    </PagerScreen>
  );
}

const Blue = ({ children }: { children: ReactNode }) => <Text style={{ fontFamily: font.display, color: palette.blue }}>{children}</Text>;

/** .prow: a big label and a muted detail, tappable. */
function PrefRow({ label, detail, onPress }: { label: string; detail: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${detail}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        minHeight: 64,
        borderBottomWidth: 1,
        borderBottomColor: palette.rule,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ fontFamily: font.display, fontSize: 24, letterSpacing: -0.48, color: palette.ink }}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: font.body, fontSize: 14, color: palette.muted }}>
          {detail}
        </Text>
        <PagerIcon name="chevron-right" size={16} color={palette.muted} />
      </View>
    </Pressable>
  );
}

function TopicsSheet({ open, current, onClose }: { open: boolean; current: string[]; onClose: () => void }) {
  const update = useUpdateProfile();
  const [picked, setPicked] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const chosen = picked ?? current;
  const options = [...catalog, ...chosen.filter((t) => !(catalog as readonly string[]).includes(t))];
  const toggle = (t: string) => setPicked(chosen.includes(t) ? chosen.filter((x) => x !== t) : [...chosen, t]);

  function close() {
    setPicked(null);
    setDraft("");
    onClose();
  }
  function add() {
    const t = draft.trim().slice(0, 60);
    if (t && !chosen.some((x) => x.toLowerCase() === t.toLowerCase())) setPicked([...chosen, t]);
    setDraft("");
  }
  function save() {
    if (!picked) return close();
    update.mutate({ topics: picked }, { onSuccess: close });
  }

  return (
    <Sheet open={open} onClose={close} label="Goals and topics">
      <Mono>Send me more on</Mono>
      <Display size={30} lineHeight={32}>
        Goals and topics
      </Display>
      <Chips>
        {options.map((t) => (
          <Chip key={t} label={t} on={chosen.includes(t)} onPress={() => toggle(t)} />
        ))}
      </Chips>
      <TextInput
        accessibilityLabel="Add a topic of your own"
        placeholder="+ Your own"
        placeholderTextColor={palette.muted}
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={add}
        returnKeyType="done"
        maxLength={60}
        style={{ minHeight: 46, borderWidth: 1.5, borderStyle: "dashed", borderColor: palette.line, borderRadius: 999, paddingHorizontal: 15, fontFamily: font.body, fontSize: 15, color: palette.ink }}
      />
      {update.isError && <InlineError message={update.error.message} />}
      <View style={{ flexDirection: "row" }}>
        <SheetButton title={update.isPending ? "Saving…" : "Done"} primary onPress={save} />
      </View>
    </Sheet>
  );
}

function ScheduleSheet({ open, current, onClose }: { open: boolean; current: DeliveryPreset | null; onClose: () => void }) {
  const update = useUpdateSchedule();
  return (
    <Sheet open={open} onClose={onClose} label="Schedule">
      <Mono>Send it</Mono>
      <Display size={30} lineHeight={32}>
        When should it arrive?
      </Display>
      {PRESETS.map((p) => {
        const on = p.value === current;
        return (
          <Pressable
            key={p.value}
            accessibilityRole="radio"
            aria-checked={on}
            onPress={() => update.mutate(p.value, { onSuccess: onClose })}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              minHeight: 56,
              borderRadius: 16,
              borderWidth: 1.5,
              borderColor: on ? palette.blue : palette.lineSoft,
              backgroundColor: on ? palette.blueCard : palette.surface,
              paddingHorizontal: 16,
            }}
          >
            <Text style={{ fontFamily: font.bodySemi, fontSize: 16, color: on ? palette.blueInk : palette.ink }}>
              {p.label[0]!.toUpperCase() + p.label.slice(1)}
            </Text>
            <Text style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: 0.88, textTransform: "uppercase", color: on ? palette.blueInk : palette.muted }}>{p.when}</Text>
          </Pressable>
        );
      })}
      {update.isError && <InlineError message={update.error.message} />}
    </Sheet>
  );
}
