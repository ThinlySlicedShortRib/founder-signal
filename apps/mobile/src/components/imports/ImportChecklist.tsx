import Ionicons from "@expo/vector-icons/Ionicons";
import type { ConfirmImportResult, ImportCandidate, SourceMode } from "@fs/schema";
import { useState } from "react";
import { ActivityIndicator, Pressable, SectionList, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, palette } from "@/components/onboarding/kit";
import { Badge, Body, Button, Card, ChoiceList, EmptyState, ErrorBanner, Heading, Kicker, Small, space, TAP, TextField, Title } from "@/components/ui";
import { candidateDetail, METHOD_LABEL, useConfirmImport, useImport } from "@/lib/imports";
import { MODE_OPTIONS } from "@/lib/sources";

/** Lists longer than this get a search box. */
const SEARCH_FROM = 12;

/**
 * The end of every import: what was found, as a checklist. New ones start
 * ticked, ones you already follow are shown but can't be ticked. "Add N of M"
 * adds only the ticked ones, with one follow mode for the batch, and then
 * shows what happened. Reusable from onboarding later (`onDone`).
 */
export function ImportChecklist({ importId, onDone }: { importId: string; onDone: () => void }) {
  const query = useImport(importId);
  if (query.isPending) return <ActivityIndicator color={palette.muted} style={{ marginTop: 48 }} accessibilityLabel="Loading what we found" />;
  if (!query.data) {
    return (
      <View style={{ padding: 20 }}>
        <ErrorBanner message={query.error?.message ?? "That import couldn't be found"} onRetry={() => void query.refetch()} />
      </View>
    );
  }
  // Keyed so the default selection is computed once per import.
  return <Checklist key={query.data.id} view={query.data} onDone={onDone} />;
}

function Checklist({ view, onDone }: { view: NonNullable<ReturnType<typeof useImport>["data"]>; onDone: () => void }) {
  const insets = useSafeAreaInsets();
  const confirm = useConfirmImport(view.id);
  const [selected, setSelected] = useState(() => new Set(view.candidates.filter((c) => !c.following).map((c) => c.key)));
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<SourceMode>("more_like_this");
  const [result, setResult] = useState<ConfirmImportResult | null>(null);

  const selectable = view.candidates.filter((c) => !c.following);
  const needle = search.trim().toLowerCase();
  const visible = needle
    ? view.candidates.filter((c) => `${c.title} ${c.detail ?? ""} ${c.url}`.toLowerCase().includes(needle))
    : view.candidates;
  const groups = new Map<string, ImportCandidate[]>();
  for (const c of visible) groups.set(c.group ?? "", [...(groups.get(c.group ?? "") ?? []), c]);
  const sections = [...groups].map(([title, data]) => ({ title, data }));
  const visibleSelectable = visible.filter((c) => !c.following);
  const allVisibleOn = visibleSelectable.length > 0 && visibleSelectable.every((c) => selected.has(c.key));

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function setVisible(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of visibleSelectable) {
        if (on) next.add(c.key);
        else next.delete(c.key);
      }
      return next;
    });
  }

  async function add() {
    try {
      setResult(await confirm.mutateAsync({ keys: [...selected], mode }));
    } catch {
      // Shown from confirm.error.
    }
  }

  if (result) return <Summary result={result} onDone={onDone} />;

  const header = (
    <View style={{ gap: space.md, paddingBottom: space.sm }}>
      <View style={{ gap: space.xs }}>
        <Kicker>From {METHOD_LABEL[view.method]}</Kicker>
        <Title style={{ fontSize: 28, lineHeight: 31 }}>{view.label}</Title>
        <Body muted>
          {!view.candidates.length
            ? "We didn’t find anything to add."
            : !selectable.length
              ? `You already follow all ${view.candidates.length}.`
              : `We found ${view.candidates.length}. ${selectable.length === view.candidates.length ? "Untick anything you don’t want in your letters." : `${view.candidates.length - selectable.length} you already follow.`}`}
        </Body>
      </View>
      {view.notes.map((n) => (
        <View key={n} style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
          <Ionicons name="information-circle-outline" size={18} color={palette.muted} style={{ marginTop: 1 }} />
          <Small style={{ flex: 1 }}>{n}</Small>
        </View>
      ))}
      {view.candidates.length > SEARCH_FROM && (
        <TextField label="Search" value={search} onChangeText={setSearch} placeholder="Name or site" autoCapitalize="none" autoCorrect={false} returnKeyType="search" />
      )}
      {visibleSelectable.length > 0 && (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Small accessibilityLiveRegion="polite">
            {selected.size} of {selectable.length} selected
          </Small>
          <Pressable
            accessibilityRole="button"
            onPress={() => setVisible(!allVisibleOn)}
            style={({ pressed }) => ({ minHeight: TAP, justifyContent: "center", paddingHorizontal: space.sm, opacity: pressed ? 0.6 : 1 })}
          >
            <Text style={{ fontFamily: font.bodySemi, fontSize: 14.5, color: palette.blue }}>
              {allVisibleOn ? (needle ? "Select none shown" : "Select none") : needle ? "Select all shown" : "Select all"}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );

  const footer = view.candidates.length ? (
    <View style={{ gap: space.md, paddingTop: space.xl }}>
      <Heading>How should we use them?</Heading>
      <ChoiceList label="How to use these sources" value={mode} onChange={setMode} options={MODE_OPTIONS} />
      <Small>Applies to the ones you add now; sources you already follow keep their setting. You can change each one later.</Small>
    </View>
  ) : (
    <EmptyState icon="search-outline" title="Nothing to add" body="Try another import, or add sources one at a time." />
  );

  return (
    <View style={{ flex: 1, backgroundColor: palette.ground }}>
      <SectionList
        sections={sections}
        keyExtractor={(c) => c.key}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={30}
        contentContainerStyle={{ padding: 20, paddingTop: 12, paddingBottom: 120 + insets.bottom, width: "100%", maxWidth: 680, alignSelf: "center" }}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ListEmptyComponent={needle ? <Small style={{ paddingVertical: space.lg }}>Nothing matches “{search.trim()}”.</Small> : null}
        renderSectionHeader={({ section }) => (section.title ? <Kicker style={{ marginTop: space.lg, marginBottom: space.sm }}>{section.title}</Kicker> : <View style={{ height: space.sm }} />)}
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
        renderItem={({ item }) => <CandidateRow candidate={item} on={selected.has(item.key)} onToggle={() => toggle(item.key)} />}
      />
      {view.candidates.length > 0 && (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: 20,
            paddingTop: space.md,
            paddingBottom: insets.bottom + space.md,
            backgroundColor: palette.ground,
            borderTopWidth: 1,
            borderTopColor: palette.rule,
            gap: space.sm,
          }}
        >
          <View style={{ width: "100%", maxWidth: 640, alignSelf: "center", gap: space.sm }}>
            {confirm.error && <ErrorBanner message={confirm.error.message} />}
            {selectable.length === 0 ? (
              <Button title="Done" variant="secondary" onPress={onDone} />
            ) : (
              <Button
                title={confirm.isPending ? "Adding…" : `Add ${selected.size} of ${view.candidates.length}`}
                accessibilityLabel={`Add ${selected.size} of ${view.candidates.length} sources`}
                loading={confirm.isPending}
                disabled={!selected.size}
                onPress={() => void add()}
              />
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function CandidateRow({ candidate: c, on, onToggle }: { candidate: ImportCandidate; on: boolean; onToggle: () => void }) {
  const detail = candidateDetail(c);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: c.following ? true : on, disabled: c.following }}
      accessibilityLabel={`${c.title}. ${detail}${c.following ? ". Already following" : ""}`}
      disabled={c.following}
      onPress={onToggle}
      style={({ pressed }) => ({
        minHeight: 60,
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 16,
        borderWidth: 1.5,
        borderColor: on && !c.following ? palette.blue : palette.lineSoft,
        backgroundColor: c.following ? palette.panel : on ? palette.blueTint : palette.surface,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Ionicons
        name={c.kind === "youtube_channel" ? "logo-youtube" : c.check === "site" ? "globe-outline" : "newspaper-outline"}
        size={20}
        color={c.following ? palette.muted : palette.blue}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <Body style={{ fontFamily: font.bodySemi, color: c.following ? palette.muted : palette.ink }} numberOfLines={2}>
          {c.title}
        </Body>
        <Small numberOfLines={1}>{detail}</Small>
      </View>
      {c.following ? (
        <Badge label="Following" />
      ) : (
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            borderWidth: 1.5,
            borderColor: on ? palette.blue : palette.boxLine,
            backgroundColor: on ? palette.blue : palette.surface,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {on && <Ionicons name="checkmark" size={15} color={palette.onBlue} />}
        </View>
      )}
    </Pressable>
  );
}

function Summary({ result, onDone }: { result: ConfirmImportResult; onDone: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: palette.ground, padding: 20, paddingBottom: insets.bottom + 20, gap: space.lg, width: "100%", maxWidth: 680, alignSelf: "center" }}>
      <Card style={{ backgroundColor: palette.blueCard, borderColor: palette.blueCard, gap: space.md }} accessibilityRole="summary" accessibilityLiveRegion="polite">
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
          <Ionicons name="checkmark-circle" size={26} color={palette.blue} />
          <Heading style={{ flex: 1 }}>{result.added ? `Added ${result.added} source${result.added === 1 ? "" : "s"}` : "Nothing new added"}</Heading>
        </View>
        <Body>
          {result.added ? "We’ll start collecting from them within a few minutes." : ""}
          {result.alreadyFollowing ? ` ${result.alreadyFollowing} ${result.alreadyFollowing === 1 ? "was" : "were"} already in your sources.` : ""}
        </Body>
      </Card>
      {result.failed.length > 0 && (
        <Card>
          <Body style={{ fontFamily: font.bodySemi }}>
            {result.failed.length} couldn’t be added
          </Body>
          {result.failed.map((f) => (
            <Small key={f.key}>
              {f.title}: {f.message}
            </Small>
          ))}
        </Card>
      )}
      <Button title="Done" onPress={onDone} />
    </View>
  );
}
