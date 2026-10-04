import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import { View } from "react-native";
import { Body, Button, Card, ErrorBanner, Heading, Screen, Small, Title } from "@/components/ui";
import { authClient } from "@/lib/auth";
import { presetLabel } from "@/lib/onboarding";
import { useProfile } from "@/lib/profile";
import { useSources } from "@/lib/sources";
import { space, useColors } from "@/lib/theme";

function greeting(date = new Date()) {
  const h = date.getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default function Today() {
  const { data: session } = authClient.useSession();
  const sources = useSources();
  const schedule = useProfile().data?.schedule;
  const list = sources.data ?? [];
  const active = list.filter((s) => !s.blocked);
  const collected = active.reduce((n, s) => n + s.itemCount, 0);
  const name = session?.user.name && !session.user.name.includes("@") ? session.user.name : null;

  const steps = [
    {
      done: active.length > 0,
      title: "Add a few sources",
      detail: active.length ? `${active.length} source${active.length === 1 ? "" : "s"} added` : "Sites, newsletters, feeds or YouTube channels you trust.",
    },
    {
      done: collected > 0,
      title: "Collect pieces from them",
      detail: collected ? `${collected} piece${collected === 1 ? "" : "s"} collected so far` : "We check your sources every few minutes once they're added.",
    },
    {
      done: !!schedule,
      title: "Choose when your letter arrives",
      detail: schedule?.preset ? `Arrives ${presetLabel(schedule.preset)}` : "Set it in Preferences.",
    },
  ];

  return (
    <Screen edges="both" refreshing={sources.isRefetching} onRefresh={() => void sources.refetch()}>
      <View style={{ gap: space.xs }}>
        <Small>{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</Small>
        <Title>
          {greeting()}
          {name ? `, ${name}` : ""}
        </Title>
      </View>

      {sources.error && <ErrorBanner message={sources.error.message} onRetry={() => void sources.refetch()} />}

      <Card style={{ gap: space.md }}>
        <Heading>Getting your first letter ready</Heading>
        <Body muted>Each letter is a handful of pieces picked for your goals, with a line on why each one is worth it.</Body>
        <View style={{ gap: space.md, marginTop: space.sm }}>
          {steps.map((s, i) => (
            <Step key={s.title} index={i + 1} {...s} />
          ))}
        </View>
        {active.length === 0 ? (
          <Button title="Add your first source" icon="add" onPress={() => router.push("/sources/add")} />
        ) : (
          <Button title="Manage sources" variant="secondary" onPress={() => router.push("/sources")} />
        )}
      </Card>
    </Screen>
  );
}

function Step({ index, done, title, detail }: { index: number; done: boolean; title: string; detail: string }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", gap: space.md }} accessible accessibilityLabel={`Step ${index}: ${title}. ${done ? "Done." : ""} ${detail}`}>
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: done ? c.accent : c.surfaceMuted,
        }}
      >
        {done ? <Ionicons name="checkmark" size={18} color={c.accentText} /> : <Small muted={false}>{index}</Small>}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Body style={{ fontWeight: "600" }}>{title}</Body>
        <Small>{detail}</Small>
      </View>
    </View>
  );
}
