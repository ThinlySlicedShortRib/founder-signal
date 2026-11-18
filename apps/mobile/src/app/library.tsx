import { type Href, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PodcastsTab } from "@/components/library/PodcastsTab";
import { TINTS } from "@/components/letter/Photo";
import { font, InlineError, palette } from "@/components/onboarding/kit";
import { PagerIcon } from "@/components/pager/icons";
import { usePillSpace } from "@/components/pager/Pill";
import { Display, Mono, PagerScreen, Segmented } from "@/components/pager/PagerScreen";
import { plural, savedWhen, shortDate } from "@/lib/format";
import { useLetters, useSaved, useTodayLetter } from "@/lib/letters";
import { keepOnTouchElsewhere, tasks as episodeTasks } from "@/lib/listen";
import { podcastLibrary, setPillRowPlaybackOnly } from "@/lib/podcasts";
import { snapshotGroups } from "@/lib/podcast-library";

type Tab = "saved" | "letters" | "podcasts";
const HEADINGS: Record<Tab, string> = { saved: "Saved", letters: "Letters", podcasts: "Podcasts" };

/** Library (PagerLibrary): saved pieces and past letters as big tinted tiles, and the episodes you've made or played. */
export default function Library() {
  const insets = useSafeAreaInsets();
  const { space } = usePillSpace();
  // Opened from the pill's panel ("All episodes in Podcasts"): on the Podcasts tab.
  const params = useLocalSearchParams<{ tab?: string; at?: string }>();
  const [tab, setTab] = useState<Tab>(params.tab === "podcasts" ? "podcasts" : "saved");
  const saved = useSaved();
  const letters = useLetters();
  const today = useTodayLetter();
  const heading = HEADINGS[tab];
  const q = tab === "saved" ? saved : letters;
  // The Podcasts tab's groups, taken as it opens (rows don't jump between groups while it's open).
  const [groups, setGroups] = useState(() => snapshotGroups(podcastLibrary.entries()));
  const switchTab = (t: Tab) => {
    if (t === "podcasts" && tab !== "podcasts") setGroups(snapshotGroups(podcastLibrary.entries()));
    setTab(t);
  };
  // Asked again while the screen is open: the tab switches (the focus effect below takes its groups).
  const asked = params.tab === "podcasts" ? (params.at ?? null) : null;
  const [seenAsk, setSeenAsk] = useState(asked);
  if (asked !== seenAsk) {
    setSeenAsk(asked);
    if (asked) setTab("podcasts");
  }
  // Coming back to the screen on the Podcasts tab opens it afresh; and while it shows, the pill's row is for playback only.
  useFocusEffect(
    useCallback(() => {
      if (tab !== "podcasts") return;
      setGroups(snapshotGroups(podcastLibrary.entries()));
      setPillRowPlaybackOnly(true);
      return () => setPillRowPlaybackOnly(false);
    }, [tab]),
  );

  return (
    <PagerScreen current="library" kicker="Library" title={heading}>
      <View style={{ flex: 1 }} onStartShouldSetResponderCapture={keepOnTouchElsewhere}>
        <ScrollView
          onScrollBeginDrag={() => {
            if (episodeTasks.anyConfirm()) episodeTasks.dismiss({ scroll: true });
          }}
          contentContainerStyle={{ gap: 12, paddingTop: insets.top + 22, paddingHorizontal: 16, paddingBottom: space }}
        >
          <Mono style={{ paddingHorizontal: 4 }}>Library</Mono>
          <Display size={56} lineHeight={58} style={{ paddingHorizontal: 4 }}>
            {heading}
          </Display>
          <Segmented<Tab>
            label="Show"
            value={tab}
            onChange={switchTab}
            options={[
              ["saved", "Saved"],
              ["letters", "Letters"],
              ["podcasts", "Podcasts"],
            ]}
          />
          {tab === "podcasts" ? (
            <PodcastsTab groups={groups} />
          ) : q.isPending ? (
            <ActivityIndicator color={palette.muted} style={{ marginTop: 32 }} accessibilityLabel="Loading" />
          ) : q.isError ? (
            <InlineError message={q.error.message} onRetry={() => void q.refetch()} />
          ) : tab === "saved" ? (
            saved.data!.length === 0 ? (
              <Empty text="Nothing saved yet. Tap the bookmark in the pill while you read, and it'll be kept here." />
            ) : (
              <>
                {saved.data!.map((s, i) => (
                  <Tile
                    key={s.itemId}
                    tint={TINTS[i % 3]!}
                    href={{ pathname: "/items/[id]", params: { id: s.itemId } }}
                    label={`${s.title}. ${s.topic ?? ""} ${s.minutes ? `${s.minutes} minutes` : ""}, ${savedWhen(s.savedAt)}`}
                    top={<Mono color={palette.promptInk}>{s.topic ?? (s.kind === "video" ? "Video" : "Article")}</Mono>}
                    title={s.title}
                    meta={[s.minutes ? `${s.minutes} min${s.kind === "video" ? " video" : ""}` : null, savedWhen(s.savedAt)].filter(Boolean).join(" · ")}
                  />
                ))}
                {saved.data!.some((s) => s.offline) && (
                  <Text style={{ marginTop: 4, textAlign: "center", fontFamily: font.body, fontSize: 14, color: palette.muted }}>Saved pieces are kept for reading offline.</Text>
                )}
              </>
            )
          ) : letters.data!.length === 0 ? (
            <Empty text="Your letters will be kept here once the first one arrives." />
          ) : (
            letters.data!.map((l, i) => (
              <Tile
                key={l.id}
                tint={TINTS[i % 3]!}
                href={l.id === today.data?.id ? "/" : { pathname: "/letters/[id]", params: { id: l.id } }}
                label={`Letter number ${l.number}: ${l.headline}. ${shortDate(l.localDate)}, ${plural(l.pieceCount, "piece")}`}
                top={<Display size={56} lineHeight={52}>{l.isTest ? "Test" : `No. ${l.number}`}</Display>}
                title={l.headline}
                meta={`${shortDate(l.localDate)} · ${plural(l.pieceCount, "piece")}`}
              />
            ))
          )}
        </ScrollView>
      </View>
    </PagerScreen>
  );
}

/** .tile: a tinted card, kicker and → at the top, a big title and a meta line under it. */
function Tile({ tint, href, label, top, title, meta }: { tint: string; href: Href; label: string; top: React.ReactNode; title: string; meta: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={() => router.push(href)}
      style={({ pressed }) => ({ minHeight: 140, borderRadius: 24, padding: 18, gap: 16, justifyContent: "space-between", backgroundColor: tint, opacity: pressed ? 0.85 : 1 })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        {top}
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center" }}>
          <PagerIcon name="arrow-right" size={18} color={palette.blue} />
        </View>
      </View>
      <View style={{ gap: 6 }}>
        <Text style={{ fontFamily: font.display, fontSize: 26, lineHeight: 27.3, letterSpacing: -0.65, color: palette.ink }}>{title}</Text>
        <Text style={{ fontFamily: font.body, fontSize: 14, color: palette.promptInk }}>{meta}</Text>
      </View>
    </Pressable>
  );
}

function Empty({ text }: { text: string }) {
  return <Text style={{ marginTop: 12, paddingHorizontal: 4, fontFamily: font.body, fontSize: 16, lineHeight: 23, color: palette.muted }}>{text}</Text>;
}
