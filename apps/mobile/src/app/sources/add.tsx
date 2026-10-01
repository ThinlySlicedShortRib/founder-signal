import type { SourceMode } from "@fs/schema";
import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform } from "react-native";
import { Body, Button, ChoiceList, Heading, Screen, Small, TextField } from "@/components/ui";
import { MODE_OPTIONS, useAddSource } from "@/lib/sources";
import { space, useColors } from "@/lib/theme";

export default function AddSource() {
  const c = useColors();
  const add = useAddSource();
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<SourceMode>("more_like_this");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!url.trim()) return setError("Paste a link");
    setError(null);
    try {
      const source = await add.mutateAsync({ url: url.trim(), mode });
      router.replace({ pathname: "/sources/[id]", params: { id: source.id, added: "1" } });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.background }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen>
        <Body muted>Paste a site, a feed, a single article or a YouTube channel. We’ll work out the rest.</Body>
        <TextField
          label="Link"
          value={url}
          onChangeText={(v) => {
            setUrl(v);
            setError(null);
          }}
          placeholder="example.com or a link to an article"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
          returnKeyType="done"
          onSubmitEditing={submit}
          error={error}
          autoFocus
        />
        <Heading style={{ marginTop: space.sm }}>How should we use it?</Heading>
        <ChoiceList label="How to use this source" value={mode} onChange={setMode} options={MODE_OPTIONS} />
        <Small>You can change this later.</Small>
        <Button title={add.isPending ? "Checking the link…" : "Add source"} onPress={submit} loading={add.isPending} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
