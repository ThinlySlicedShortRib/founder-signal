import Ionicons from "@expo/vector-icons/Ionicons";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Linking, Switch, View } from "react-native";
import { Badge, Body, Button, Card, ChoiceList, Divider, EmptyState, ErrorBanner, Heading, Row, Screen, Small, space, TAP, Title } from "@/components/ui";
import { font, palette } from "@/components/onboarding/kit";
import { confirm } from "@/lib/confirm";
import { fetchHealth, MODE_OPTIONS, rightsLabel, TYPE_ICON, TYPE_LABEL, timeAgo, useRemoveSource, useSource, useUpdateSource } from "@/lib/sources";

export default function SourceDetail() {
  const { id, added } = useLocalSearchParams<{ id: string; added?: string }>();
  const { data: source, isPending, refetch, isRefetching } = useSource(id);
  const update = useUpdateSource(id);
  const remove = useRemoveSource();

  if (isPending) return <ActivityIndicator color={palette.muted} style={{ marginTop: space.xxl }} />;
  if (!source) {
    return (
      <Screen>
        <EmptyState icon="help-circle-outline" title="Source not found" body="It may have been removed.">
          <Button title="Back to sources" variant="secondary" onPress={() => router.replace("/sources")} />
        </EmptyState>
      </Screen>
    );
  }

  const health = fetchHealth(source);
  const newsletter = source.type === "newsletter";

  async function removeSource() {
    const ok = await confirm({
      title: `Remove ${source!.title}?`,
      message: "Your letters will stop drawing from it. Pieces you've saved stay in your library.",
      confirmLabel: "Remove",
    });
    if (!ok) return;
    await remove.mutateAsync(source!.id);
    router.back();
  }

  return (
    <>
      <Stack.Screen options={{ title: "Source" }} />
      <Screen refreshing={isRefetching} onRefresh={() => void refetch()}>
        {added && (
          <Card style={{ backgroundColor: palette.blueCard, borderColor: palette.blueCard, flexDirection: "row", gap: space.sm, alignItems: "center" }}>
            <Ionicons name="checkmark-circle" size={22} color={palette.blue} />
            <Body style={{ flex: 1 }}>Added. We’ll start collecting from it within a few minutes.</Body>
          </Card>
        )}
        {update.error && <ErrorBanner message={update.error.message} />}

        <View style={{ gap: space.sm }}>
          <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
            <Ionicons name={TYPE_ICON[source.type]} size={20} color={palette.blue} />
            <Small>
              {[TYPE_LABEL[source.type], source.publisher.name !== source.title ? source.publisher.name : null, source.creator && source.creator !== source.publisher.name ? source.creator : null]
                .filter(Boolean)
                .join(" · ")}
            </Small>
          </View>
          <Title>{source.title}</Title>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
            {source.blocked ? <Badge label="Paused" /> : <Badge label={health.label} tone={health.tone} />}
            <Badge label={`${source.itemCount} piece${source.itemCount === 1 ? "" : "s"} collected`} />
          </View>
        </View>

        <Card>
          <Heading>How to use it</Heading>
          <ChoiceList label="How to use this source" value={source.mode} onChange={(mode) => update.mutate({ mode })} options={MODE_OPTIONS} />
        </Card>

        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TAP }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Body style={{ fontFamily: font.bodySemi }}>{newsletter ? "Stop following" : "Pause this source"}</Body>
              <Small>{newsletter ? "Its emails are ignored and it's left out of letters." : "Stop using it in letters without removing it."}</Small>
            </View>
            <Switch
              accessibilityLabel={newsletter ? "Stop following this newsletter" : "Pause this source"}
              value={source.blocked}
              onValueChange={(blocked) => update.mutate({ blocked })}
              trackColor={{ true: palette.blue, false: palette.lineSoft }}
            />
          </View>
        </Card>

        <Card>
          <Heading>Details</Heading>
          {newsletter ? (
            <Row icon="mail-outline" label="From" detail={source.url.replace(/^mailto:/, "")} />
          ) : (
            <Row icon="link-outline" label="Link" detail={source.url} onPress={() => void Linking.openURL(/^https?:/i.test(source.url) ? source.url : `https://${source.url}`)} />
          )}
          <Divider />
          <Row icon="document-lock-outline" label="What we keep" detail={rightsDetail(source.rights)} trailing={<Badge label={rightsLabel(source.rights)} />} />
          <Divider />
          <Row icon="refresh-outline" label={newsletter ? "Last email" : "Last checked"} detail={source.lastFetchedAt ? timeAgo(source.lastFetchedAt) : "Not yet"} />
        </Card>

        <Button title="Remove source" variant="danger" icon="trash-outline" onPress={removeSource} loading={remove.isPending} />
      </Screen>
    </>
  );
}

function rightsDetail(rights: { display: string; offlineAllowed: boolean }) {
  if (rights.display === "link_only") return "Title and link only; you read it on the publisher's site.";
  if (rights.display === "excerpt_only") return "A short digest, clearly labelled, with a link to the original.";
  return rights.offlineAllowed ? "The full text, readable in the app and offline." : "The full text, readable in the app.";
}
