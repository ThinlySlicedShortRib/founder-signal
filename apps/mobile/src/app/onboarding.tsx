import { topicsFromText } from "@fs/core";
import { type Assistant, type ImportProfileResult, type ProfileView, roles, type Topic, topics as allTopics, type UpdateProfileInput } from "@fs/schema";
import { StatusBar } from "expo-status-bar";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ImportStep, type ImportStage } from "@/components/onboarding/ImportStep";
import { Chip, Chips, InlineError, LinkButton, OButton, OText, font, usePalette } from "@/components/onboarding/kit";
import { BoardIcon } from "@/components/onboarding/icons";
import { LetterPreview } from "@/components/onboarding/LetterPreview";
import { type Clause, Sentence } from "@/components/onboarding/Sentence";
import {
  type Answers,
  answersFromImport,
  assistantLabel,
  buildPreview,
  isAnswered,
  LATELY_EXAMPLES,
  nextStep,
  PRESETS,
  presetLabel,
  quoteOf,
  STEP_ORDER,
  topicsText,
  type Step,
  withArticle,
} from "@/lib/onboarding";
import { useCompleteOnboarding, useImportProfile, useLatestImport, useProfile, useUpdateProfile, useUpdateSchedule } from "@/lib/profile";

/** Resumes where the user left off: everything answered so far is already saved. */
function answersFrom(profile: ProfileView | undefined): Answers {
  const topics = profile?.topics ?? [];
  const role = profile?.role ?? null;
  const started = !!(profile?.imported || role || profile?.lately || topics.length);
  return {
    importDone: started,
    imported: profile?.imported ?? null,
    role,
    lately: profile?.lately ?? null,
    // Topics come after lately, so having topics means lately was answered or skipped.
    latelySkipped: !profile?.lately && topics.length > 0,
    topics,
    platforms: profile?.platforms ?? [],
    // The schedule is the last answer: with a preset saved, only "Send my first letter" is left.
    preset: profile?.schedule?.preset ?? null,
  };
}

export default function Onboarding() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const profile = useProfile();
  const updateProfile = useUpdateProfile();
  const updateSchedule = useUpdateSchedule();
  const importProfile = useImportProfile();
  const complete = useCompleteOnboarding();

  const [answers, setAnswers] = useState<Answers>(() => answersFrom(profile.data));
  const [at, setAt] = useState<Step | null>(() => nextStep(answersFrom(profile.data)));
  const [importStage, setImportStage] = useState<ImportStage>(0);
  /** The screens the user came through, so Back returns to the one they actually saw. */
  const [history, setHistory] = useState<{ at: Step | null; importStage: ImportStage }[]>([]);
  const [assistant, setAssistant] = useState<Assistant>(profile.data?.imported?.assistant ?? "chatgpt");
  const [paste, setPaste] = useState("");
  const [importResult, setImportResult] = useState<ImportProfileResult | null>(null);
  const [draft, setDraft] = useState("");
  const [heard, setHeard] = useState<Topic[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const retry = useRef<(() => void) | null>(null);

  const latestImport = useLatestImport({ enabled: at === "import" });

  /** Saves in the background; the sentence moves on straight away. */
  function save(run: () => Promise<unknown>) {
    setSaveError(null);
    retry.current = () => save(run);
    run().catch((err: Error) => {
      setSaveError(`Couldn't save that: ${err.message}`);
    });
  }

  /** Moves to another blank (or the end), remembering where the user was. */
  function go(step: Step | null) {
    if (step === at) return;
    setHistory((h) => [...h, { at, importStage }]);
    setAt(step);
  }

  function answer(patch: Partial<Answers>, server?: UpdateProfileInput) {
    const next = { ...answers, ...patch };
    setAnswers(next);
    go(nextStep(next));
    if (server) save(() => updateProfile.mutateAsync(server));
  }

  function edit(step: Step) {
    if (step === "lately") setDraft(answers.lately ?? "");
    if (step === "import") setImportStage(0);
    go(step);
  }

  /**
   * Back: within the import, its previous screen; otherwise the screen the user
   * was on before this one. So after an import, Back from the first question
   * returns to the facts they kept, not to blanks the import filled in.
   */
  function goBack() {
    if (at === "import" && importStage > 0) {
      setImportStage((importStage - 1) as ImportStage);
      return;
    }
    const prev = history.at(-1);
    if (prev) {
      setHistory(history.slice(0, -1));
      if (prev.at === "lately") setDraft(answers.lately ?? "");
      setImportStage(prev.importStage);
      setAt(prev.at);
      return;
    }
    // Resumed mid-way (no history this session): the blank before this one.
    const before = at === null ? "time" : STEP_ORDER[STEP_ORDER.indexOf(at) - 1];
    if (!before) return;
    if (before === "lately") setDraft(answers.lately ?? "");
    setImportStage(before === "import" && importResult ? 3 : 0);
    setAt(before);
  }
  const canGoBack = at !== "import" || importStage > 0;

  // ── Steps ─────────────────────────────────────────────────────────────────

  async function readImport() {
    try {
      const result = await importProfile.mutateAsync({ assistant, text: paste });
      setImportResult(result);
      setImportStage(3);
    } catch {
      // Shown under the paste box via importProfile.error.
    }
  }

  function keepImport(kept: number[]) {
    const facts = (importResult?.facts ?? []).filter((_, i) => kept.includes(i));
    // Each kept fact fills its part of the form. Places they read are kept quietly; that's no longer asked.
    const patch = answersFromImport(facts, answers);
    const imported = { importId: importResult?.importId ?? null, assistant, facts };
    // The note is saved with the import; the copy on screen isn't needed any more.
    setPaste("");
    setHeard([]);
    answer(
      { ...patch, importDone: true, imported },
      { imported, role: patch.role, lately: patch.lately, topics: patch.topics, platforms: patch.platforms },
    );
  }

  function confirmLately() {
    const text = draft.trim();
    if (!text) return;
    const found = topicsFromText(text);
    setHeard(found);
    const topics = [...answers.topics, ...found.filter((t) => !answers.topics.includes(t))];
    // Topics are next either way: the user tweaks what was heard.
    setAnswers({ ...answers, lately: text, latelySkipped: false, topics });
    go("topics");
    save(() => updateProfile.mutateAsync({ lately: text, topics }));
  }

  function skipLately() {
    setHeard([]);
    setDraft("");
    setAnswers({ ...answers, lately: null, latelySkipped: true });
    go("topics");
    save(() => updateProfile.mutateAsync({ lately: null }));
  }

  function pickTime(preset: (typeof PRESETS)[number]["value"]) {
    const next = { ...answers, preset };
    setAnswers(next);
    go(nextStep(next));
    save(() => updateSchedule.mutateAsync(preset));
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const preview = buildPreview({
    answers,
    step: at,
    importStage,
    assistant,
    hasPaste: !!paste.trim(),
    draftingLately: !!draft.trim(),
    heard,
  });

  const idx = at ? STEP_ORDER.indexOf(at) : STEP_ORDER.length;
  const reached = (s: Step) => STEP_ORDER.indexOf(s) <= idx || isAnswered(answers, s);
  const shown = (s: Step, after: Step) => isAnswered(answers, after) && reached(s);
  const value = (s: Step, text: string) => (at === s ? null : text);

  const clauses: Clause[] = [
    { key: "role", lead: at === "role" || !answers.role ? "I'm a " : "I'm ", answer: answers.role ? value("role", withArticle(answers.role)) : null, onEdit: () => edit("role") },
  ];
  if (shown("lately", "role"))
    clauses.push({ key: "lately", lead: " Lately I've been into ", answer: value("lately", answers.lately ? quoteOf(answers.lately) : "a bit of everything"), onEdit: () => edit("lately") });
  if (shown("topics", "lately"))
    clauses.push({
      key: "topics",
      lead: " Send me more on ",
      answer: answers.topics.length ? value("topics", topicsText(answers.topics)) : null,
      onEdit: () => edit("topics"),
    });
  if (shown("time", "topics"))
    clauses.push({ key: "time", lead: " Send it ", answer: answers.preset ? value("time", presetLabel(answers.preset)) : null, onEdit: () => edit("time") });

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.ground }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <StatusBar style="dark" />
      <View style={{ flex: 1, width: "100%", maxWidth: 560, alignSelf: "center" }}>
        <View style={{ paddingTop: insets.top + 16, paddingHorizontal: 16 }}>
          <LetterPreview preview={preview} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 22, paddingTop: 16, paddingBottom: insets.bottom + 20, gap: 11 }}>
          {canGoBack && <BackButton onPress={goBack} />}
          {at !== "import" && (
            <>
              {answers.imported && answers.imported.facts.length > 0 && (
                <OText variant="mono" color={p.blue}>
                  Filled in from {assistantLabel(answers.imported.assistant)} · tap any blue answer to change it
                </OText>
              )}
              <Sentence clauses={clauses} />
            </>
          )}

          {at === "import" && (
            <ImportStep
              stage={importStage}
              setStage={setImportStage}
              assistant={assistant}
              setAssistant={setAssistant}
              paste={paste}
              setPaste={setPaste}
              result={importResult}
              reading={importProfile.isPending}
              readError={importProfile.error?.message ?? null}
              onRead={() => void readImport()}
              onKeep={keepImport}
              lastNote={latestImport.data ? { text: latestImport.data.text, assistant: latestImport.data.assistant } : null}
              onSkip={() => {
                setPaste("");
                answer({ importDone: true });
              }}
            />
          )}

          {at === "role" && (
            <ChoiceStep prompt="Pick one">
              {withOwn(roles, answers.role ? [answers.role] : []).map((r) => (
                <Chip key={r} label={r} on={answers.role === r} onPress={() => answer({ role: r }, { role: r })} />
              ))}
              <FreeText label="Your role in your own words" placeholder="Or in your own words, e.g. product designer" action="Use" onSubmit={(v) => answer({ role: v }, { role: v })} />
            </ChoiceStep>
          )}

          {at === "lately" && <LatelyStep draft={draft} setDraft={setDraft} onConfirm={confirmLately} onSkip={skipLately} />}

          {at === "topics" && (
            <ChoiceStep
              prompt={heard.length || answers.imported?.facts.length ? "Here's what I heard. Tweak it." : "Pick a few"}
              next={{ label: "Next", disabled: !answers.topics.length, onPress: () => answer({}, { topics: answers.topics }) }}
            >
              {withOwn(allTopics, answers.topics).map((t) => {
                const on = answers.topics.includes(t);
                return <Chip key={t} label={t} on={on} onPress={() => setAnswers({ ...answers, topics: on ? answers.topics.filter((x) => x !== t) : [...answers.topics, t] })} />;
              })}
              <FreeText
                label="Add a topic"
                placeholder="Add your own, e.g. vertical SaaS"
                action="Add"
                onSubmit={(v) => !hasText(answers.topics, v) && setAnswers({ ...answers, topics: [...answers.topics, v] })}
              />
            </ChoiceStep>
          )}

          {at === "time" && (
            <ChoiceStep prompt="When should it arrive?">
              {PRESETS.map((x) => (
                <Chip key={x.value} label={x.label} on={answers.preset === x.value} onPress={() => pickTime(x.value)} />
              ))}
            </ChoiceStep>
          )}

          {at === null && (
            <View style={{ flexGrow: 1, gap: 11 }}>
              <OText color={p.muted}>That’s everything I need. I’ll search the web for pieces that fit, and your first letter will be on Today in a few minutes. After that, it comes {answers.preset ? presetLabel(answers.preset) : "on your schedule"}.</OText>
              <View style={{ flexGrow: 1, minHeight: 12 }} />
              {complete.error && <InlineError message={complete.error.message} onRetry={() => complete.mutate()} />}
              {/* Finishing makes the first letter and flips the route guard, which opens Today. */}
              <OButton title="Send my first letter" loading={complete.isPending} onPress={() => complete.mutate()} />
            </View>
          )}

          {saveError && <InlineError message={saveError} onRetry={() => retry.current?.()} />}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

/** Not on the board: a quiet "‹ Back" in its link style, above the desk. */
function BackButton({ onPress }: { onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 2, alignSelf: "flex-start", minHeight: 32, marginLeft: -4, marginBottom: -6, opacity: pressed ? 0.6 : 1 })}
    >
      <BoardIcon name="chevron-left" size={18} color={p.soft} />
      <Text style={{ fontFamily: font.body, fontSize: 14, lineHeight: 19, color: p.soft }}>Back</Text>
    </Pressable>
  );
}

/** The suggestions, then the user's own answers that aren't among them. */
function withOwn(suggested: readonly string[], own: string[]): string[] {
  return [...suggested, ...own.filter((x) => !hasText(suggested, x))];
}

function hasText(xs: readonly string[], x: string) {
  return xs.some((y) => y.toLowerCase() === x.toLowerCase());
}

/** A one-line answer in the user's own words, beside the chips (.inp + .add on the canvas). */
function FreeText({ label, placeholder, action, onSubmit }: { label: string; placeholder: string; action: string; onSubmit: (value: string) => void }) {
  const p = usePalette();
  const [value, setValue] = useState("");
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onSubmit(v);
    setValue("");
  };
  return (
    <View style={{ flexDirection: "row", gap: 8, width: "100%" }}>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={setValue}
        onSubmitEditing={submit}
        returnKeyType="done"
        placeholder={placeholder}
        placeholderTextColor={p.muted}
        maxLength={60}
        style={{ flex: 1, minHeight: 44, borderWidth: 1.5, borderColor: p.line, borderRadius: 12, paddingVertical: 9, paddingHorizontal: 12, fontFamily: font.body, fontSize: 15, color: p.ink, backgroundColor: p.surface }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${action}: ${label}`}
        onPress={submit}
        style={({ pressed }) => ({ minHeight: 44, borderRadius: 12, paddingHorizontal: 14, justifyContent: "center", backgroundColor: p.grey, opacity: pressed ? 0.8 : 1 })}
      >
        <Text style={{ fontFamily: font.bodySemi, fontSize: 15, color: p.ink }}>{action}</Text>
      </Pressable>
    </View>
  );
}

function ChoiceStep({
  prompt,
  note,
  next,
  children,
}: {
  prompt: string;
  note?: string;
  next?: { label: string; disabled?: boolean; onPress: () => void };
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: 11, flexGrow: 1 }}>
      <OText variant="mono">{prompt}</OText>
      <Chips>{children}</Chips>
      {note && <OText variant="small">{note}</OText>}
      {next && (
        <>
          <View style={{ flexGrow: 1, minHeight: 8 }} />
          <OButton title={next.label} disabled={next.disabled} onPress={next.onPress} />
        </>
      )}
    </View>
  );
}

function LatelyStep({ draft, setDraft, onConfirm, onSkip }: { draft: string; setDraft: (v: string) => void; onConfirm: () => void; onSkip: () => void }) {
  const p = usePalette();
  return (
    <View style={{ gap: 11, flexGrow: 1 }}>
      <OText variant="mono" nativeID="lately-label">
        In your own words: a company, a project, a problem, anything
      </OText>
      <TextInput
        accessibilityLabelledBy="lately-label"
        accessibilityLabel="What you've been into lately"
        value={draft}
        onChangeText={setDraft}
        placeholder="e.g. how some company makes money, an open source project, what you're stuck on"
        placeholderTextColor={p.muted}
        multiline
        maxLength={500}
        textAlignVertical="top"
        style={{ minHeight: 80, borderWidth: 1.5, borderColor: p.line, borderRadius: 14, paddingVertical: 11, paddingHorizontal: 13, fontFamily: font.body, fontSize: 15, lineHeight: 21, color: p.ink, backgroundColor: p.surface }}
      />
      <View style={{ gap: 6 }}>
        {LATELY_EXAMPLES.map((e) => (
          <Pressable
            key={e}
            accessibilityRole="button"
            accessibilityHint="Use this example"
            onPress={() => setDraft(e)}
            style={({ pressed }) => ({ borderWidth: 1.5, borderStyle: "dashed", borderColor: p.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, minHeight: 44, justifyContent: "center", opacity: pressed ? 0.7 : 1 })}
          >
            <Text style={{ fontFamily: font.body, fontSize: 14, lineHeight: 19, color: p.soft }}>{e}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexGrow: 1, minHeight: 8 }} />
      <OButton title="That's it" disabled={!draft.trim()} onPress={onConfirm} />
      <LinkButton title="Nothing in particular right now" onPress={onSkip} />
    </View>
  );
}
