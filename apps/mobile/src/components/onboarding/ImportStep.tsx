import type { Assistant, ImportProfileResult } from "@fs/schema";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  ASSISTANTS,
  assistantLabel,
  droppedSummary,
  EXAMPLE_ANSWER,
  FACT_KIND_LABEL,
  IMPORT_ASKS,
  IMPORT_AVOIDS,
  IMPORT_PROMPT,
} from "@/lib/onboarding";
import { BoardIcon, ShieldOutline } from "./icons";
import { Chip, Chips, InlineError, LinkButton, OButton, OText, em, font, usePalette } from "./kit";

export type ImportStage = 0 | 1 | 2 | 3;

const AREA = { borderWidth: 1.5, borderRadius: 14, paddingVertical: 11, paddingHorizontal: 13, fontFamily: font.body, fontSize: 15, lineHeight: 21 };

/**
 * "Skip the questions": choose an assistant, see exactly what the prompt asks
 * for, paste its answer back, untick anything. Claude reads the note into
 * facts that each fill part of the form; the note is saved with the import.
 */
export function ImportStep({
  stage,
  setStage,
  assistant,
  setAssistant,
  paste,
  setPaste,
  result,
  reading,
  readError,
  onRead,
  onKeep,
  onSkip,
  lastNote,
}: {
  stage: ImportStage;
  setStage: (s: ImportStage) => void;
  assistant: Assistant;
  setAssistant: (a: Assistant) => void;
  paste: string;
  setPaste: (v: string) => void;
  result: ImportProfileResult | null;
  reading: boolean;
  readError: string | null;
  onRead: () => void;
  onKeep: (keptIndexes: number[]) => void;
  onSkip: () => void;
  /** The note pasted last time, if any: it's saved with the import. */
  lastNote: { text: string; assistant: Assistant } | null;
}) {
  const p = usePalette();
  const name = assistantLabel(assistant);
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [unticked, setUnticked] = useState<Set<number>>(new Set());
  const h21 = { fontSize: 21, lineHeight: 25.2, letterSpacing: em(-0.015, 21) };

  if (stage === 0) {
    return (
      <View style={{ gap: 11, flexGrow: 1 }}>
        <OText variant="h">Skip the questions. Start with what your AI already knows about you.</OText>
        <OText color={p.muted}>We’ll give you a prompt to paste into your assistant. It writes a short note about your work and interests, and you paste that back here.</OText>
        <OText variant="mono" style={{ marginTop: 4 }}>
          Which one do you use most?
        </OText>
        <Chips>
          {ASSISTANTS.map((a) => (
            <Chip key={a.value} label={a.label} on={assistant === a.value} onPress={() => (setAssistant(a.value), setCopied(false))} />
          ))}
        </Chips>
        <View style={{ flexGrow: 1, minHeight: 12 }} />
        <OButton title="Get the prompt" onPress={() => setStage(1)} />
        <LinkButton title="I'd rather answer a few questions" onPress={onSkip} />
      </View>
    );
  }

  if (stage === 1) {
    return (
      <View style={{ gap: 11, flexGrow: 1 }}>
        <OText variant="h" style={h21}>
          Here’s exactly what we’ll ask {name}
        </OText>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <PromptColumn title="It asks for" items={IMPORT_ASKS} tone="yes" />
          <PromptColumn title="Told to leave out" items={IMPORT_AVOIDS} tone="no" />
        </View>
        <LinkButton title={showPrompt ? "Hide the full prompt" : "Read the full prompt"} tone="accent" align="start" compact onPress={() => setShowPrompt(!showPrompt)} />
        {showPrompt && (
          <ScrollView nestedScrollEnabled style={{ maxHeight: 150, flexGrow: 0, backgroundColor: p.surface, borderWidth: 1.5, borderColor: p.lineSoft, borderRadius: 14 }} contentContainerStyle={{ paddingVertical: 10, paddingHorizontal: 12 }}>
            <Text selectable style={{ fontFamily: font.body, fontSize: 12.5, lineHeight: 18.1, color: p.promptInk }}>
              {IMPORT_PROMPT}
            </Text>
          </ScrollView>
        )}
        <View style={{ flexGrow: 1, minHeight: 8 }} />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <OButton
            style={{ flex: 1 }}
            kind="secondary"
            title={copied ? "Copied" : "Copy prompt"}
            onPress={async () => {
              await Clipboard.setStringAsync(IMPORT_PROMPT);
              setCopied(true);
            }}
          />
          <OButton style={{ flex: 1 }} title={`Open ${name}`} onPress={() => void Linking.openURL(ASSISTANTS.find((a) => a.value === assistant)!.url)} />
        </View>
        <LinkButton title="I've got the answer" onPress={() => setStage(2)} />
      </View>
    );
  }

  if (stage === 2) {
    return (
      <View style={{ gap: 11, flexGrow: 1 }}>
        <OText variant="h" style={h21}>
          Paste what {name} wrote
        </OText>
        <OText variant="mono" nativeID="paste-label">
          We save your note so you can come back to it, and only use what you approve.
        </OText>
        <TextInput
          accessibilityLabel={`What ${name} wrote`}
          accessibilityLabelledBy="paste-label"
          value={paste}
          onChangeText={setPaste}
          placeholder="Paste here"
          placeholderTextColor={p.muted}
          multiline
          textAlignVertical="top"
          autoCorrect={false}
          style={{ ...AREA, minHeight: 150, maxHeight: 260, borderColor: p.line, color: p.ink, backgroundColor: p.surface }}
        />
        {lastNote && !paste.trim() ? (
          <LinkButton title="Use the note you pasted before" tone="accent" align="start" compact onPress={() => (setAssistant(lastNote.assistant), setPaste(lastNote.text))} />
        ) : (
          <LinkButton title="Use an example answer" align="start" compact onPress={() => setPaste(EXAMPLE_ANSWER)} />
        )}
        {readError && <InlineError message={readError} />}
        <View style={{ flexGrow: 1, minHeight: 8 }} />
        <OButton title={reading ? "Reading…" : "Read it"} disabled={!paste.trim()} loading={reading} onPress={onRead} />
      </View>
    );
  }

  // Stage 3: review.
  const facts = result?.facts ?? [];
  const dropped = droppedSummary(result?.dropped ?? []);
  const kept = facts.map((_, i) => i).filter((i) => !unticked.has(i));
  return (
    <View style={{ gap: 11, flexGrow: 1 }}>
      <OText variant="h" style={h21}>
        {facts.length ? "Here’s what I’d keep. Untick anything." : "There wasn’t much to keep."}
      </OText>
      {dropped && (
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", backgroundColor: p.orangeTint, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 }}>
          <ShieldOutline size={16} color={p.no} />
          <Text style={{ flex: 1, fontFamily: font.body, fontSize: 13, lineHeight: 18, color: p.droppedInk }}>{dropped}</Text>
        </View>
      )}
      {!facts.length && <OText color={p.muted}>{name}’s note didn’t say much about your work. You can answer a few quick questions instead.</OText>}
      {facts.map((f, i) => {
        const on = !unticked.has(i);
        // .keep.off also picks up the board's .off button colours: grey ground, grey text.
        const ink = on ? p.ink : p.offText;
        return (
          <Pressable
            key={`${f.kind}-${i}`}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`${FACT_KIND_LABEL[f.kind]}: ${f.text}`}
            onPress={() => {
              const next = new Set(unticked);
              if (on) next.add(i);
              else next.delete(i);
              setUnticked(next);
            }}
            style={{
              flexDirection: "row",
              gap: 10,
              alignItems: "flex-start",
              backgroundColor: on ? p.surface : p.off,
              borderWidth: 1.5,
              borderColor: p.lineSoft,
              borderRadius: 14,
              paddingHorizontal: 12,
              paddingVertical: 9,
              minHeight: 48,
              opacity: on ? 1 : 0.45,
            }}
          >
            <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 2, borderColor: p.blue, backgroundColor: on ? p.blue : "transparent", alignItems: "center", justifyContent: "center", marginTop: 1 }}>
              {on && <BoardIcon name="check" size={12} color={p.onBlue} strokeWidth={3.4} />}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <OText variant="mono" color={on ? p.muted : p.offText} style={{ textDecorationLine: on ? "none" : "line-through" }}>
                {FACT_KIND_LABEL[f.kind]}
              </OText>
              <Text style={{ fontFamily: font.body, fontSize: 15, lineHeight: 19.5, color: ink, textDecorationLine: on ? "none" : "line-through" }}>{f.text}</Text>
            </View>
          </Pressable>
        );
      })}
      <View style={{ flexGrow: 1, minHeight: 8 }} />
      {facts.length ? <OButton title="Keep these" onPress={() => onKeep(kept)} /> : <OButton title="Answer a few questions" onPress={onSkip} />}
    </View>
  );
}

/** .col.yes / .col.no */
function PromptColumn({ title, items, tone }: { title: string; items: string[]; tone: "yes" | "no" }) {
  const p = usePalette();
  const color = tone === "yes" ? p.blue : p.no;
  return (
    <View style={{ flex: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, gap: 5, backgroundColor: tone === "yes" ? p.blueTint : p.orangeTint }}>
      <OText variant="mono" color={color}>
        {title}
      </OText>
      {items.map((x) => (
        <View key={x} style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
          <View style={{ marginTop: 2 }}>
            <BoardIcon name={tone === "yes" ? "check" : "x"} size={14} color={color} strokeWidth={2.6} />
          </View>
          <Text style={{ flex: 1, fontFamily: font.body, fontSize: 13, lineHeight: 16.9, color: p.ink }}>{x}</Text>
        </View>
      ))}
    </View>
  );
}
