import Ionicons from "@expo/vector-icons/Ionicons";
import type { ForwardingConfirmation, NewsletterSender } from "@fs/schema";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Switch, Text, View } from "react-native";
import { font, palette } from "@/components/onboarding/kit";
import { Body, Button, Card, Divider, EmptyState, ErrorBanner, Heading, Kicker, Screen, Small, space, TAP } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { confirm } from "@/lib/confirm";
import { useFollowSender, useNewsletters, useRotateAddress } from "@/lib/newsletters";
import { timeAgo } from "@/lib/sources";

type Provider = "gmail" | "outlook";

const STEPS: Record<Provider, { title: string; steps: string[]; note: string }> = {
  gmail: {
    title: "Gmail",
    steps: [
      "On a computer, open Gmail’s Settings (the gear) → See all settings → Forwarding and POP/IMAP → Add a forwarding address. Paste your address.",
      "Gmail emails a confirmation code to your address. It shows up on this page within a minute: copy it into Gmail and choose Verify.",
      "Make a filter: in Gmail’s search bar, open the search options, put the newsletter’s address in From (several with OR), then Create filter → Forward it to → your address.",
    ],
    note: "Leave Gmail’s forwarding switch on “Disable forwarding”: the filter forwards only what it matches. Tick “Skip the Inbox” if you only want to read them here.",
  },
  outlook: {
    title: "Outlook",
    steps: [
      "In Outlook on the web, open Settings → Mail → Rules → Add new rule.",
      "Condition: From, and the newsletter’s address. Action: Forward to, and paste your address. Save.",
    ],
    note: "Work and school accounts (Microsoft 365) often block forwarding outside the organisation; your admin decides. Outlook doesn’t send a confirmation code.",
  },
};

/**
 * Newsletters by email: the user's personal address, how to forward to it
 * from Gmail or Outlook, Gmail's confirmation code when it arrives (polled),
 * the senders received so far, and a new address on request.
 */
export default function NewsletterForwarding() {
  const view = useNewsletters({ poll: true });
  const rotate = useRotateAddress();
  const follow = useFollowSender();
  const [provider, setProvider] = useState<Provider>("gmail");

  if (view.isPending) return <ActivityIndicator color={palette.muted} style={{ marginTop: space.xxl }} accessibilityLabel="Loading your address" />;
  if (!view.data) {
    const notSetUp = view.error instanceof ApiError && view.error.code === "NOT_CONFIGURED";
    return (
      <Screen>
        {notSetUp ? (
          <EmptyState
            icon="mail-outline"
            title="Not set up yet"
            body="Newsletter forwarding needs an email domain on this server (see docs/imports/README.md). Until then, import newsletters that have a feed, like Substack."
          >
            <Button title="Back" variant="secondary" onPress={() => router.back()} />
          </EmptyState>
        ) : (
          <ErrorBanner message={view.error?.message ?? "Couldn’t load your address"} onRetry={() => void view.refetch()} />
        )}
      </Screen>
    );
  }

  const { address, confirmations, senders, skipped } = view.data;

  async function newAddress() {
    const ok = await confirm({
      title: "Get a new address?",
      message: "Your current address stops working straight away. Update your forwarding address and filters in Gmail or Outlook to the new one. Senders you already get stay.",
      confirmLabel: "Get new address",
    });
    if (ok) rotate.mutate();
  }

  return (
    <Screen refreshing={view.isRefetching && !view.isFetchedAfterMount} onRefresh={() => void view.refetch()}>
      <Body muted>Forward newsletters to your own address, and every issue becomes a piece your letters can pick from, like anything else you follow.</Body>

      <Card style={{ gap: space.md }}>
        <Kicker>Your address</Kicker>
        <Text selectable accessibilityLabel={`Your address: ${address.email}`} style={{ fontFamily: font.mono, fontSize: 15, lineHeight: 21, color: palette.ink }}>
          {address.email}
        </Text>
        <CopyButton value={address.email} title="Copy address" />
        <Small>It’s yours alone and hard to guess. Anything sent to it lands in your pool, so share it only with Gmail, Outlook and newsletters.</Small>
      </Card>

      {confirmations.map((c) => (
        <ConfirmationCard key={c.id} confirmation={c} />
      ))}

      <View style={{ gap: space.sm }}>
        <Heading>Set up forwarding</Heading>
        <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: space.sm }}>
          {(Object.keys(STEPS) as Provider[]).map((p) => {
            const on = provider === p;
            return (
              <Pressable
                key={p}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => setProvider(p)}
                style={({ pressed }) => ({
                  minHeight: TAP,
                  paddingHorizontal: 18,
                  borderRadius: 999,
                  borderWidth: 1.5,
                  borderColor: on ? palette.ink : palette.line,
                  backgroundColor: on ? palette.ink : palette.surface,
                  justifyContent: "center",
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Text style={{ fontFamily: font.bodySemi, fontSize: 15, color: on ? palette.onBlue : palette.ink }}>{STEPS[p].title}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <Card style={{ gap: space.md }}>
        {STEPS[provider].steps.map((step, i) => (
          <View key={step} style={{ flexDirection: "row", gap: space.md, alignItems: "flex-start" }}>
            <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: palette.blueTint, alignItems: "center", justifyContent: "center", marginTop: 1 }}>
              <Text style={{ fontFamily: font.bodySemi, fontSize: 13.5, color: palette.blueInk }}>{i + 1}</Text>
            </View>
            <Body style={{ flex: 1 }}>{step}</Body>
          </View>
        ))}
        <Small>{STEPS[provider].note}</Small>
      </Card>
      <Small>You can also subscribe to a newsletter with your address directly.</Small>

      <View style={{ gap: space.sm }}>
        <Heading>Received so far</Heading>
        {senders.length === 0 ? (
          <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }} accessibilityLiveRegion="polite">
            <ActivityIndicator size="small" color={palette.muted} />
            <Small style={{ flex: 1 }}>Waiting for your first newsletter. This page updates on its own.</Small>
          </View>
        ) : (
          <Card style={{ paddingVertical: space.xs, gap: 0 }}>
            {senders.map((s, i) => (
              <View key={s.sourceId}>
                {i > 0 && <Divider />}
                <SenderRow sender={s} onFollow={(following) => follow.mutate({ sourceId: s.sourceId, following })} />
              </View>
            ))}
          </Card>
        )}
        {follow.error && <ErrorBanner message={follow.error.message} />}
        {skipped > 0 && (
          <Small>
            {skipped} {skipped === 1 ? "email" : "emails"} in the last 30 days {skipped === 1 ? "wasn’t" : "weren’t"} added: too short to read, from a sender you stopped following, or not a newsletter.
          </Small>
        )}
      </View>

      <View style={{ gap: space.sm, marginTop: space.md }}>
        {rotate.error && <ErrorBanner message={rotate.error.message} />}
        <Button title="Get a new address" icon="refresh-outline" variant="secondary" loading={rotate.isPending} onPress={() => void newAddress()} />
        <Small>If your address gets passed around or spam starts arriving, a new one stops the old one at once.</Small>
      </View>
    </Screen>
  );
}

/** A copy button that says "Copied" for a moment (announced to screen readers). */
function CopyButton({ value, title }: { value: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <Button
      title={copied ? "Copied" : title}
      icon={copied ? "checkmark" : "copy-outline"}
      variant="secondary"
      accessibilityLiveRegion="polite"
      onPress={async () => {
        await Clipboard.setStringAsync(value);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2_000);
      }}
    />
  );
}

function ConfirmationCard({ confirmation: c }: { confirmation: ForwardingConfirmation }) {
  const gmail = c.provider === "gmail";
  return (
    <Card style={{ backgroundColor: palette.blueCard, borderColor: palette.blueCard, gap: space.md }} accessibilityLiveRegion="polite">
      <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
        <Ionicons name="key-outline" size={22} color={palette.blue} />
        <Heading style={{ flex: 1 }}>{gmail ? "Paste this code in Gmail" : "Confirm forwarding in Outlook"}</Heading>
      </View>
      {c.code && (
        <Text selectable accessibilityLabel={`Confirmation code ${c.code.split("").join(" ")}`} style={{ fontFamily: font.mono, fontSize: 28, lineHeight: 34, letterSpacing: 2, color: palette.ink }}>
          {c.code}
        </Text>
      )}
      <Small muted={false} style={{ color: palette.cardInk }}>
        {c.requestedBy ? `${c.requestedBy} asked to forward here` : "A forwarding request arrived"} · {timeAgo(c.receivedAt)}.{" "}
        {gmail ? "In Gmail’s Forwarding settings, enter the code and choose Verify, or open the link." : ""}
      </Small>
      {c.code && <CopyButton value={c.code} title="Copy code" />}
      {c.url && <Button title="Open the confirmation link" icon="open-outline" variant="secondary" onPress={() => void Linking.openURL(c.url!)} />}
    </Card>
  );
}

function SenderRow({ sender: s, onFollow }: { sender: NewsletterSender; onFollow: (following: boolean) => void }) {
  const detail = [s.sender, `${s.itemCount} piece${s.itemCount === 1 ? "" : "s"}`, s.lastReceivedAt ? `last ${timeAgo(s.lastReceivedAt)}` : null].filter(Boolean).join(" · ");
  return (
    <View style={{ minHeight: 60, flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.sm, opacity: s.following ? 1 : 0.6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${s.title}. ${detail}`}
        accessibilityHint="Opens the source"
        onPress={() => router.push({ pathname: "/sources/[id]", params: { id: s.sourceId } })}
        style={({ pressed }) => ({ flex: 1, flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TAP, opacity: pressed ? 0.6 : 1 })}
      >
        <Ionicons name="mail-outline" size={20} color={palette.blue} />
        <View style={{ flex: 1, gap: 2 }}>
          <Body style={{ fontFamily: font.bodySemi }} numberOfLines={2}>
            {s.title}
          </Body>
          <Small numberOfLines={2}>{detail}</Small>
        </View>
      </Pressable>
      <Switch
        accessibilityLabel={`Follow ${s.title}`}
        value={s.following}
        onValueChange={onFollow}
        trackColor={{ true: palette.blue, false: palette.lineSoft }}
      />
    </View>
  );
}
