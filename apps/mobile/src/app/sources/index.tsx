import Ionicons from "@expo/vector-icons/Ionicons";
import type { SourceView } from "@fs/schema";
import { router, Stack } from "expo-router";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Badge, Body, Button, Card, EmptyState, ErrorBanner, Screen, Small } from "@/components/ui";
import { fetchHealth, rightsLabel, TYPE_ICON, TYPE_LABEL, useSources } from "@/lib/sources";
import { space, TAP, useColors } from "@/lib/theme";

export default function Sources() {
  const c = useColors();
  const sources = useSources();
  const list = sources.data ?? [];

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add a source"
              onPress={() => router.push("/sources/add")}
              style={{ minWidth: TAP, minHeight: TAP, alignItems: "center", justifyContent: "center" }}
            >
              <Ionicons name="add" size={28} color={c.accent} />
            </Pressable>
          ),
        }}
      />
      <Screen refreshing={sources.isRefetching} onRefresh={() => void sources.refetch()}>
        {sources.error && <ErrorBanner message={sources.error.message} onRetry={() => void sources.refetch()} />}
        {sources.isPending ? (
          <ActivityIndicator color={c.textMuted} style={{ marginTop: space.xxl }} accessibilityLabel="Loading sources" />
        ) : list.length === 0 ? (
          <EmptyState
            icon="library-outline"
            title="No sources yet"
            body="Add the sites, newsletters and channels you already trust. Founder Signal also finds new ones for you as it learns what you like."
          >
            <Button title="Add a source" icon="add" onPress={() => router.push("/sources/add")} />
          </EmptyState>
        ) : (
          <>
            <Small>Pull down to refresh. Feeds are checked about once an hour.</Small>
            {list.map((s) => (
              <SourceCard key={s.id} source={s} />
            ))}
          </>
        )}
      </Screen>
    </>
  );
}

function SourceCard({ source }: { source: SourceView }) {
  const c = useColors();
  const health = fetchHealth(source);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${source.title}, ${TYPE_LABEL[source.type]}${source.blocked ? ", paused" : ""}. ${source.itemCount} pieces. ${health.label}`}
      onPress={() => router.push({ pathname: "/sources/[id]", params: { id: source.id } })}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <Card style={{ flexDirection: "row", gap: space.md, opacity: source.blocked ? 0.6 : 1 }}>
        <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: c.surfaceMuted, alignItems: "center", justifyContent: "center" }}>
          <Ionicons name={TYPE_ICON[source.type]} size={22} color={c.accent} />
        </View>
        <View style={{ flex: 1, gap: space.xs }}>
          <Body style={{ fontWeight: "600" }} numberOfLines={2}>
            {source.title}
          </Body>
          <Small numberOfLines={1}>
            {TYPE_LABEL[source.type]}
            {source.publisher.name !== source.title ? ` · ${source.publisher.name}` : ""}
          </Small>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.xs }}>
            {source.blocked ? <Badge label="Paused" /> : <Badge label={health.label} tone={health.tone} />}
            <Badge label={`${source.itemCount} piece${source.itemCount === 1 ? "" : "s"}`} />
            <Badge label={rightsLabel(source.rights)} />
          </View>
        </View>
        <Ionicons name="chevron-forward" size={18} color={c.textMuted} style={{ alignSelf: "center" }} />
      </Card>
    </Pressable>
  );
}
