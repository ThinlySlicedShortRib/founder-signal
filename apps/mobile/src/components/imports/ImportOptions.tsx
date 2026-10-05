import Ionicons from "@expo/vector-icons/Ionicons";
import type { HandlePlatform } from "@fs/schema";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { font, palette } from "@/components/onboarding/kit";
import { Body, Button, Card, ErrorBanner, type IconName, Small, space, TAP, TextField } from "@/components/ui";
import { connectYouTube, HANDLE_FORMS, pickOpmlFile, useImportHandle, useImportOpml, useImportOptions } from "@/lib/imports";

type Option = "opml" | "youtube" | HandlePlatform | "newsletters";

const OPTIONS: readonly { value: Option; icon: IconName; title: string; detail: string }[] = [
  { value: "opml", icon: "document-attach-outline", title: "Upload an OPML file", detail: "From Feedly, Inoreader, Readwise Reader, NetNewsWire, Overcast or Apple Podcasts" },
  { value: "youtube", icon: "logo-youtube", title: "YouTube subscriptions", detail: "Connect your Google account once; we only read the channels you subscribe to" },
  { value: "substack", icon: "mail-outline", title: "Substack", detail: "The newsletters your profile shows you subscribe to" },
  { value: "bluesky", icon: "at-outline", title: "Bluesky", detail: "The people you follow, and their websites" },
  { value: "mastodon", icon: "chatbubbles-outline", title: "Mastodon", detail: "The people you follow, and their websites" },
  { value: "newsletters", icon: "mail-unread-outline", title: "Newsletters (email)", detail: "Forward newsletters from Gmail or Outlook to your own address" },
];

/**
 * "Import what you follow": the ways in. Each import ends on the checklist
 * (`onImported`); nothing is added from here. Newsletters by email has its
 * own screen (`onNewsletters`; the option is hidden without it). Reusable
 * from onboarding later: it has no screen chrome of its own.
 */
export function ImportOptions({
  onImported,
  onNewsletters,
  initialError,
}: {
  onImported: (importId: string) => void;
  onNewsletters?: () => void;
  initialError?: string | null;
}) {
  const [open, setOpen] = useState<Option | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);

  return (
    <View style={{ gap: space.md }}>
      {error && <ErrorBanner message={error} />}
      {OPTIONS.filter((o) => o.value !== "newsletters" || onNewsletters).map((o) => {
        const expanded = open === o.value;
        const opensScreen = o.value === "newsletters";
        return (
          <Card key={o.value} style={{ padding: 0, gap: 0, borderColor: expanded ? palette.blue : palette.rule, borderWidth: expanded ? 1.5 : 1 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={opensScreen ? undefined : { expanded }}
              accessibilityLabel={`${o.title}. ${o.detail}`}
              onPress={() => {
                setError(null);
                if (opensScreen) onNewsletters?.();
                else setOpen(expanded ? null : o.value);
              }}
              style={({ pressed }) => ({ minHeight: 64, flexDirection: "row", alignItems: "center", gap: space.md, padding: 16, opacity: pressed ? 0.7 : 1 })}
            >
              <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: palette.grey, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name={o.icon} size={22} color={palette.blue} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Body style={{ fontFamily: font.bodySemi }}>{o.title}</Body>
                <Small>{o.detail}</Small>
              </View>
              <Ionicons name={opensScreen ? "chevron-forward" : expanded ? "chevron-up" : "chevron-down"} size={18} color={palette.muted} />
            </Pressable>
            {expanded && (
              <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: space.md }}>
                {o.value === "opml" ? (
                  <OpmlForm onImported={onImported} />
                ) : o.value === "youtube" ? (
                  <YouTubeForm onImported={onImported} />
                ) : o.value !== "newsletters" ? (
                  <HandleForm platform={o.value} onImported={onImported} />
                ) : null}
              </View>
            )}
          </Card>
        );
      })}
      <Small>You’ll see everything we find and choose what to add. Nothing is added until you say so.</Small>
    </View>
  );
}

function OpmlForm({ onImported }: { onImported: (id: string) => void }) {
  const upload = useImportOpml();
  const [picking, setPicking] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function send(opml: string, filename?: string) {
    setError(null);
    try {
      const view = await upload.mutateAsync({ opml, filename });
      onImported(view.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function pick() {
    setError(null);
    setPicking(true);
    try {
      const file = await pickOpmlFile();
      if (file) await send(file.text, file.name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPicking(false);
    }
  }

  const busy = picking || upload.isPending;
  return (
    <>
      <Small>In your reader, look for Export or OPML in its settings, save the file, then choose it here.</Small>
      {error && <ErrorBanner message={error} />}
      {pasting ? (
        <>
          <TextField
            label="OPML"
            value={text}
            onChangeText={setText}
            placeholder={'<opml version="2.0">…'}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            style={{ minHeight: 140, paddingTop: 14, fontSize: 14, textAlignVertical: "top" }}
          />
          <Button title={upload.isPending ? "Reading it…" : "Find feeds"} loading={upload.isPending} disabled={!text.trim()} onPress={() => void send(text.trim())} />
        </>
      ) : (
        <Button title={upload.isPending ? "Reading your file…" : "Choose a file"} icon="folder-open-outline" loading={busy} onPress={() => void pick()} />
      )}
      <Pressable
        accessibilityRole="button"
        onPress={() => setPasting(!pasting)}
        style={({ pressed }) => ({ minHeight: TAP, justifyContent: "center", alignSelf: "center", opacity: pressed ? 0.6 : 1 })}
      >
        <Small style={{ color: palette.blue, fontFamily: font.bodySemi }}>{pasting ? "Choose a file instead" : "Paste the OPML text instead"}</Small>
      </Pressable>
    </>
  );
}

function YouTubeForm({ onImported }: { onImported: (id: string) => void }) {
  const options = useImportOptions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = options.data?.youtube.configured;

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      const result = await connectYouTube();
      if (!result) return;
      if ("error" in result) setError(result.error);
      else onImported(result.importId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (configured === false) {
    return (
      <Small>
        Connect YouTube isn’t set up on this server yet: it needs a Google OAuth client (see docs/imports/README.md). Until then, add channels one at a time
        from Add a source, or import an OPML file.
      </Small>
    );
  }
  return (
    <>
      <Small>
        You’ll sign in with Google and allow read-only access to YouTube. We read your subscriptions once and don’t keep access to your account.
      </Small>
      {__DEV__ && Platform.OS !== "web" && (
        <Small>In development, Google only returns to localhost: connect from the web app (localhost:8081) or the simulator.</Small>
      )}
      {error && <ErrorBanner message={error} />}
      <Button title={busy ? "Waiting for Google…" : "Connect YouTube"} icon="logo-google" loading={busy || options.isPending} onPress={() => void connect()} />
    </>
  );
}

function HandleForm({ platform, onImported }: { platform: HandlePlatform; onImported: (id: string) => void }) {
  const find = useImportHandle();
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const form = HANDLE_FORMS[platform];

  async function submit() {
    if (!handle.trim()) return setError("Type your handle");
    setError(null);
    try {
      const view = await find.mutateAsync({ platform, handle: handle.trim() });
      onImported(view.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <TextField
        label={form.label}
        value={handle}
        onChangeText={(v) => {
          setHandle(v);
          setError(null);
        }}
        placeholder={form.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={Platform.OS === "ios" ? "twitter" : "default"}
        returnKeyType="search"
        onSubmitEditing={() => void submit()}
        error={error}
        hint={form.hint}
        autoFocus
      />
      <Button title={find.isPending ? "Looking… this can take a few seconds" : "Find what I follow"} loading={find.isPending} onPress={() => void submit()} />
    </>
  );
}
