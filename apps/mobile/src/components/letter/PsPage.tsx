import type { LetterView } from "@fs/schema";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, palette } from "@/components/onboarding/kit";
import { PagerIcon } from "@/components/pager/icons";
import { usePillSpace } from "@/components/pager/Pill";
import { Mono } from "@/components/pager/PagerScreen";
import { clock, weekday } from "@/lib/format";
import { useSetLeanings } from "@/lib/letters";
import { PhotoBackdrop } from "./Photo";
import { ProgressBars } from "./ProgressBars";

const POSTBOX = {
  url: "https://images.unsplash.com/photo-1719003176895-20b3d05ea7de?fm=jpg&q=72&w=1200&fit=crop",
  credit: "Jack Lucas Smith on Unsplash",
  // The photographer's page isn't recorded anywhere yet; Unsplash itself until it is.
  creditUrl: "https://unsplash.com/",
};

/** The last page (board "P.S. 5", PsCountdown): recap, when the next letter comes, and "Tomorrow, more of". */
export function PsPage({ letter, page, pageCount }: { letter: LetterView; page: number; pageCount: number }) {
  const insets = useSafeAreaInsets();
  const { space } = usePillSpace();
  const ps = letter.postscript;
  const save = useSetLeanings(letter.id);
  const [chosen, setChosen] = useState<string[]>(ps.chosenLeanings);
  const [ownOpen, setOwnOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [noted, setNoted] = useState(ps.chosenLeanings.length > 0);

  // Always the postbox, as on the board: the last piece's photo read as a repeat of piece 3.
  const image = { url: POSTBOX.url, credit: POSTBOX.credit, creditUrl: POSTBOX.creditUrl };
  const next = ps.nextLetterAt ? new Date(ps.nextLetterAt) : null;
  // The suggestions, then the user's own words.
  const options = [...ps.leanings, ...chosen.filter((c) => !ps.leanings.includes(c))];

  function commit(list: string[]) {
    setChosen(list);
    setNoted(false);
    save.mutate(list, { onSuccess: () => setNoted(list.length > 0) });
  }
  const toggle = (l: string) => commit(chosen.includes(l) ? chosen.filter((c) => c !== l) : [...chosen, l]);
  function addOwn() {
    const v = draft.trim().slice(0, 80);
    if (!v) return;
    setDraft("");
    setOwnOpen(false);
    if (!chosen.includes(v)) commit([...chosen, v]);
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={{ flex: 1, overflow: "hidden" }}>
        <PhotoBackdrop image={image} topic="P.S." blurHeight="78%" />
        <View style={{ zIndex: 2, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: insets.top + 14, paddingHorizontal: 20, minHeight: 56 }}>
          <Mono color="rgba(255,255,255,0.92)">No. {letter.number} · Postscript</Mono>
          <ProgressBars page={page} count={pageCount} light />
        </View>
        <ScrollView
          style={{ zIndex: 2 }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1, justifyContent: "flex-end", gap: 14, paddingTop: 12, paddingHorizontal: 20, paddingBottom: space - 6 }}
        >
          <Mono color="rgba(255,255,255,0.82)">P.S.</Mono>
          {ps.recap && <Text style={{ fontFamily: font.body, fontSize: 18, lineHeight: 27, color: "#FFFFFF" }}>{ps.recap}</Text>}
          {next && (
            <Text accessibilityRole="header" style={{ marginTop: 10, fontFamily: font.display, fontSize: 46, lineHeight: 46, letterSpacing: -0.045 * 46, color: "#FFFFFF" }}>
              See you {weekday(next)}, {clock(next)}.
            </Text>
          )}
          <>
              <Mono color="rgba(255,255,255,0.82)" style={{ marginTop: 6 }}>
                Tomorrow, more of
              </Mono>
              <View accessibilityRole="list" accessibilityLabel="What tomorrow's letter should have more of" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {options.map((l) => {
                  const on = chosen.includes(l);
                  return (
                    <Ghost key={l} on={on} onPress={() => toggle(l)} label={l}>
                      {on ? `✓ ${l}` : l}
                    </Ghost>
                  );
                })}
                {!ownOpen && (
                  <Ghost dashed onPress={() => setOwnOpen(true)} label="Add your own">
                    + Your own
                  </Ghost>
                )}
              </View>
          </>
          {ownOpen && (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TextInput
                autoFocus
                accessibilityLabel="Something else for tomorrow"
                value={draft}
                onChangeText={setDraft}
                onSubmitEditing={addOwn}
                returnKeyType="done"
                maxLength={80}
                placeholder="e.g. selling to clinics"
                placeholderTextColor="rgba(255,255,255,0.55)"
                style={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 46,
                  borderWidth: 1.5,
                  borderColor: "rgba(255,255,255,0.25)",
                  backgroundColor: "rgba(255,255,255,0.14)",
                  borderRadius: 999,
                  paddingHorizontal: 14,
                  fontFamily: font.body,
                  fontSize: 15,
                  color: "#FFFFFF",
                }}
              />
              <Ghost onPress={addOwn} label="Add">
                Add
              </Ghost>
            </View>
          )}
          {save.isError ? (
            <Text accessibilityRole="alert" style={{ fontFamily: font.body, fontSize: 14, color: "#FFB79A" }}>
              Couldn&apos;t save that. Tap again to retry.
            </Text>
          ) : noted && chosen.length > 0 ? (
            <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <PagerIcon name="check" size={15} color={palette.blueMid} />
              <Text style={{ fontFamily: font.body, fontSize: 14, color: "rgba(255,255,255,0.88)" }}>Noted for {next ? weekday(next) : "your next letter"}.</Text>
            </View>
          ) : null}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

/** .ghost / .ghost.on: outlined white chips on the photo. */
function Ghost({ children, on, dashed, onPress, label }: { children: string; on?: boolean; dashed?: boolean; onPress: () => void; label: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-pressed={on}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        borderRadius: 999,
        borderWidth: 1.5,
        borderStyle: dashed ? "dashed" : "solid",
        borderColor: on ? "#FFFFFF" : "rgba(255,255,255,0.5)",
        backgroundColor: on ? "#FFFFFF" : "transparent",
        paddingHorizontal: 16,
        justifyContent: "center",
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ fontFamily: font.bodySemi, fontSize: 14.5, color: on ? palette.ink : "#FFFFFF" }}>{children}</Text>
    </Pressable>
  );
}
