import type { DevDiscoveryRun, DevLetter, DevState } from "@fs/schema";
import { router } from "expo-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Chip, font, InlineError, OButton, palette } from "@/components/onboarding/kit";
import { PagerIcon } from "@/components/pager/icons";
import { usePillSpace } from "@/components/pager/Pill";
import { AgentLine, Display, Mono, PagerScreen } from "@/components/pager/PagerScreen";
import { confirm } from "@/lib/confirm";
import {
  letterInProgress,
  looksStalled,
  runInProgress,
  useDevAccounts,
  useDevDiscovery,
  useDevLetter,
  useDevState,
  useForgetLetters,
  useRefreshSources,
  useResetAccount,
  useRestartOnboarding,
  useSwitchAccount,
} from "@/lib/dev";
import { clock, plural } from "@/lib/format";
import { LETTER_KEYS } from "@/lib/letters";
import { queryClient } from "@/lib/query";

/** Letters that can be opened in the reader. */
const OPENABLE = new Set(["ready", "sent", "short_sent"]);

/**
 * Dev tools (development builds against a local API): walk the whole flow by
 * hand. Redo onboarding, run discovery, make a letter, and see what the
 * pipeline did. The actions are picked up by the local worker.
 */
export default function DevTools() {
  const insets = useSafeAreaInsets();
  const { space } = usePillSpace();
  const state = useDevState();
  const s = state.data;
  const [manualRefresh, setManualRefresh] = useState(false);

  // Today and the library follow along when a letter is delivered while this screen is open.
  const delivered = s?.letters.filter((l) => l.deliveredAt).length ?? 0;
  const lastDelivered = useRef(delivered);
  useEffect(() => {
    if (delivered === lastDelivered.current) return;
    lastDelivered.current = delivered;
    void queryClient.invalidateQueries({ queryKey: LETTER_KEYS.today });
    void queryClient.invalidateQueries({ queryKey: LETTER_KEYS.list });
  }, [delivered]);

  async function refresh() {
    setManualRefresh(true);
    await state.refetch();
    setManualRefresh(false);
  }

  if (!__DEV__) {
    return (
      <PagerScreen current={null} kicker="Local" title="Dev tools">
        <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
          <Text style={{ fontFamily: font.body, fontSize: 16, color: palette.promptInk, textAlign: "center" }}>Dev tools are only in development builds.</Text>
        </View>
      </PagerScreen>
    );
  }

  return (
    <PagerScreen current={null} kicker="Local" title="Dev tools">
      <ScrollView
        contentContainerStyle={{ gap: 28, paddingTop: insets.top + 22, paddingHorizontal: 20, paddingBottom: space }}
        refreshControl={<RefreshControl refreshing={manualRefresh} onRefresh={refresh} tintColor={palette.muted} />}
      >
        <View style={{ gap: 12 }}>
          <Mono>Dev tools · local API only</Mono>
          <Display size={56} lineHeight={58}>
            Walk the flow
          </Display>
          <WorkerLine state={s} />
        </View>

        {state.isPending ? (
          <ActivityIndicator color={palette.muted} accessibilityLabel="Loading" />
        ) : state.isError ? (
          <InlineError message={state.error.message} onRetry={() => void state.refetch()} />
        ) : (
          <>
            <StatusSection state={s!} />
            <AccountsSection current={s!.user.email} />
            <OnboardingSection />
            <LettersSection letters={s!.letters} />
            <DiscoverySection runs={s!.discoveryRuns} />
            <SourcesSection state={s!} />
          </>
        )}
      </ScrollView>
    </PagerScreen>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────────

function Section({ kicker, title, children }: { kicker: string; title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Mono>{kicker}</Mono>
        <Display size={30} lineHeight={32}>
          {title}
        </Display>
      </View>
      {children}
    </View>
  );
}

/** "Is the worker running?": always a line, louder when work has waited and nothing moved. */
function WorkerLine({ state }: { state: DevState | undefined }) {
  // Re-checks the stall every few seconds even when nothing refetches.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);
  const last = state?.lastWorkerActivityAt ? `Last worker activity ${ago(state.lastWorkerActivityAt, now)}.` : "No worker activity for this account yet.";

  if (looksStalled(state, now)) {
    return <AgentLine>Nothing has moved for a while. Is the worker running? Start it with pnpm dev:workers. {last}</AgentLine>;
  }
  return (
    <Text style={{ fontFamily: font.body, fontSize: 15, lineHeight: 21.75, color: palette.promptInk }}>
      These actions are picked up by the local worker (pnpm dev:workers) within a few seconds. {last}
    </Text>
  );
}

function StatusSection({ state: s }: { state: DevState }) {
  const p = s.profile;
  const sched = s.schedule;
  return (
    <Section kicker="Status" title="This account">
      <View>
        <Row label="Signed in as" value={s.user.email} />
        <Row label="Onboarded" value={p?.onboardedAt ? `${dayTime(p.onboardedAt)} · profile v${p.version}` : "Not yet"} />
        <Row label="Role" value={p?.role ?? "—"} />
        <Row label="Lately" value={p?.lately ? `“${p.lately}”` : "—"} />
        <Row label="Topics" value={p?.topics.length ? p.topics.map((t) => (t.origin === "learned" ? `${t.topic} (learned)` : t.topic)).join(", ") : "—"} />
        <Row
          label="Import"
          value={s.latestImport ? `${s.latestImport.assistant} · ${s.latestImport.method}${s.latestImport.model ? ` (${s.latestImport.model})` : ""} · ${dayTime(s.latestImport.createdAt)}` : "None"}
        />
        {s.latestImport && <Detail>{s.latestImport.excerpt}</Detail>}
        <Row
          label="Schedule"
          value={
            sched
              ? [
                  sched.preset ?? "custom",
                  `${sched.localTime} ${sched.timeZone}`,
                  sched.paused ? "paused" : null,
                  sched.skipNext ? "skipping next" : null,
                  sched.nextRunAt ? `next ${dayTime(sched.nextRunAt)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Not set"
          }
        />
        <Row label="Reviews" value={String(s.counts.reviews)} />
        <Row label="Events" value={String(s.counts.interactions)} />
        <Row label="Letters" value={String(s.counts.letters)} />
      </View>
    </Section>
  );
}

/** The local mock accounts (seed:personas); tapping one signs in as it. */
function AccountsSection({ current }: { current: string }) {
  const accounts = useDevAccounts();
  const switchTo = useSwitchAccount();

  return (
    <Section kicker="Accounts" title="Sign in as">
      {accounts.isPending ? (
        <ActivityIndicator color={palette.muted} accessibilityLabel="Loading accounts" />
      ) : accounts.isError ? (
        <InlineError message={accounts.error.message} onRetry={() => void accounts.refetch()} />
      ) : (
        <View style={{ gap: 8 }}>
          {accounts.data.map((a) => {
            const on = a.email === current;
            const busy = switchTo.isPending && switchTo.variables === a.email;
            return (
              <Pressable
                key={a.email}
                accessibilityRole="button"
                accessibilityLabel={`Sign in as ${a.name || a.email}`}
                accessibilityState={{ selected: on, busy, disabled: on || switchTo.isPending }}
                disabled={on || switchTo.isPending}
                onPress={() => switchTo.mutate(a.email, { onSuccess: () => router.replace("/") })}
                style={({ pressed }) => ({
                  minHeight: 56,
                  borderRadius: 14,
                  borderWidth: 1.5,
                  borderColor: on ? palette.ink : palette.line,
                  backgroundColor: palette.surface,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  opacity: pressed ? 0.8 : 1,
                })}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontFamily: font.bodySemi, fontSize: 15, color: palette.ink }}>{a.name || a.email.split("@")[0]}</Text>
                  <Text style={{ fontFamily: font.body, fontSize: 13, lineHeight: 18, color: palette.muted }}>
                    {a.email} · {a.onboarded ? (a.role ?? "onboarded") : "not onboarded"}
                  </Text>
                </View>
                {busy ? <ActivityIndicator color={palette.muted} /> : on ? <Mono color={palette.blue}>Signed in</Mono> : null}
              </Pressable>
            );
          })}
          {!accounts.data.length && <Hint>No mock accounts yet: run pnpm --filter @fs/workers seed:personas.</Hint>}
        </View>
      )}
      {switchTo.isError && <InlineError message={switchTo.error.message} />}
    </Section>
  );
}

function OnboardingSection() {
  const restart = useRestartOnboarding();
  const reset = useResetAccount();

  // The app's guard switches to onboarding once the profile in the cache says it isn't done.
  const toOnboarding = () => setTimeout(() => router.replace("/onboarding"), 0);

  async function resetEverything() {
    const ok = await confirm({
      title: "Reset everything?",
      message: "Deletes this account's profile, sources, reviews, letters and discovery. You stay signed in and start onboarding from scratch.",
      confirmLabel: "Reset",
    });
    if (ok) reset.mutate(undefined, { onSuccess: toOnboarding });
  }

  return (
    <Section kicker="Onboarding" title="Start over">
      <OButton title="Restart onboarding" kind="secondary" loading={restart.isPending} onPress={() => restart.mutate(undefined, { onSuccess: toOnboarding })} />
      <Hint>Keeps everything, so the answers are filled in.</Hint>
      <OButton title="Reset everything" kind="secondary" loading={reset.isPending} onPress={resetEverything} />
      <Hint>A brand-new account under the same sign-in.</Hint>
      {restart.isError && <InlineError message={restart.error.message} />}
      {reset.isError && <InlineError message={reset.error.message} />}
    </Section>
  );
}

function LettersSection({ letters }: { letters: DevLetter[] }) {
  const create = useDevLetter();
  const forget = useForgetLetters();
  const [includeReviews, setIncludeReviews] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function forgetLetters() {
    const ok = await confirm({
      title: "Forget delivered letters?",
      message: includeReviews
        ? "Deletes this account's letters, their reading events and its reviews, so every piece can be picked again."
        : "Deletes this account's letters and their reading events, so delivered pieces can be picked again. Reviews stay.",
      confirmLabel: "Forget",
    });
    if (!ok) return;
    forget.mutate(
      { includeReviews },
      { onSuccess: (r) => setDone(`Forgot ${plural(r.letters, "letter")}, ${plural(r.items, "piece")}, ${plural(r.interactions, "event")}${includeReviews ? ` and ${plural(r.reviews, "review")}` : ""}.`) },
    );
  }

  return (
    <Section kicker="Letters" title="Make a letter">
      <OButton title="New letter" loading={create.isPending && !create.variables?.discoverFirst} disabled={create.isPending} onPress={() => create.mutate({ discoverFirst: false })} />
      <OButton
        title="New letter with discovery first"
        kind="secondary"
        loading={create.isPending && !!create.variables?.discoverFirst}
        disabled={create.isPending}
        onPress={() => create.mutate({ discoverFirst: true })}
      />
      {create.isError && <InlineError message={create.error.message} />}

      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Chip label="Also forget reviews" on={includeReviews} onPress={() => setIncludeReviews((v) => !v)} />
      </View>
      <OButton title="Forget delivered letters" kind="secondary" loading={forget.isPending} onPress={forgetLetters} />
      {forget.isError && <InlineError message={forget.error.message} />}
      {done && <Hint>{done}</Hint>}

      <View>
        <Mono style={{ marginTop: 4 }}>Latest letters</Mono>
        {letters.length === 0 ? <Empty>No letters yet.</Empty> : letters.map((l) => <LetterRow key={l.id} letter={l} />)}
      </View>
    </Section>
  );
}

function LetterRow({ letter: l }: { letter: DevLetter }) {
  const openable = OPENABLE.has(l.status);
  const title = l.number ? `No. ${l.number}` : l.isTest ? "Test letter" : "Letter";
  const status = l.waitingOnDiscovery ? "waiting for discovery" : l.status.replace(/_/g, " ");
  const details = [
    l.isTest && l.number ? "test" : null,
    plural(l.pieceCount, "piece"),
    l.generation ? `${l.generation.method}${l.generation.model ? ` (${l.generation.model})` : ""}` : null,
    l.deliveredAt ? `delivered ${dayTime(l.deliveredAt)}` : `made ${dayTime(l.createdAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const body = (
    <>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontFamily: font.display, fontSize: 20, letterSpacing: -0.4, color: palette.ink }}>{title}</Text>
          <StatusBadge label={status} busy={letterInProgress(l.status)} bad={l.status === "failed"} />
        </View>
        <Text style={{ fontFamily: font.body, fontSize: 13, lineHeight: 18, color: palette.muted }}>{details}</Text>
        {l.failureReason && <Text style={{ fontFamily: font.body, fontSize: 13, lineHeight: 18, color: palette.no }}>{l.failureReason}</Text>}
      </View>
      {openable && <PagerIcon name="chevron-right" size={16} color={palette.muted} />}
    </>
  );
  const rowStyle = { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, minHeight: 64, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: palette.rule };
  if (!openable) {
    return (
      <View accessible accessibilityLabel={`${title}, ${status}, ${details}`} style={rowStyle}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${title}, ${status}, ${details}`}
      onPress={() => router.push({ pathname: "/letters/[id]", params: { id: l.id } })}
      style={({ pressed }) => [rowStyle, { opacity: pressed ? 0.6 : 1 }]}
    >
      {body}
    </Pressable>
  );
}

function DiscoverySection({ runs }: { runs: DevDiscoveryRun[] }) {
  const start = useDevDiscovery();
  return (
    <Section kicker="Discovery" title="Search the web">
      <OButton title="Run discovery now" kind="secondary" loading={start.isPending} disabled={runs.some((r) => runInProgress(r.status))} onPress={() => start.mutate()} />
      <Hint>Uses real web searches (billed) unless the results are cached.</Hint>
      {start.isError && <InlineError message={start.error.message} />}
      <View style={{ gap: 18 }}>
        <Mono style={{ marginTop: 4 }}>Latest runs</Mono>
        {runs.length === 0 ? <Empty>No discovery runs yet.</Empty> : runs.map((r) => <RunCard key={r.id} run={r} />)}
      </View>
    </Section>
  );
}

function RunCard({ run: r }: { run: DevDiscoveryRun }) {
  const kind = r.occurrenceId.startsWith("dev#") ? "Dev run" : r.occurrenceId.startsWith("manual#") ? "CLI run" : `For ${r.occurrenceId}`;
  const summary = [
    r.queryMethod ? `queries by ${r.queryMethod}` : null,
    `${r.queriesGenerated} generated`,
    `${r.searchesRun} searched`,
    `${r.cacheHits} cached`,
    `${r.itemsLinked} linked`,
    `${r.itemsQueued} new`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={{ gap: 8, backgroundColor: palette.panel, borderRadius: 16, padding: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ fontFamily: font.display, fontSize: 18, letterSpacing: -0.36, color: palette.ink }}>{kind}</Text>
        <StatusBadge label={r.status} busy={runInProgress(r.status)} bad={r.status === "failed"} />
      </View>
      <Text style={{ fontFamily: font.body, fontSize: 13, lineHeight: 18, color: palette.muted }}>
        Started {dayTime(r.createdAt)}
        {r.finishedAt ? `, finished ${dayTime(r.finishedAt)}` : ""} · {summary}
      </Text>
      {r.error && <Text style={{ fontFamily: font.body, fontSize: 13, lineHeight: 18, color: palette.no }}>{r.error}</Text>}
      {r.queries.map((q) => (
        <View key={q.id} accessible accessibilityLabel={`Query ${q.text}, ${q.status}`} style={{ gap: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: palette.lineSoft }}>
          <Text style={{ fontFamily: font.bodySemi, fontSize: 15, lineHeight: 20, color: palette.ink }}>{q.text}</Text>
          <Mono>
            {q.status.replace(/_/g, " ")} · {q.origin}
            {q.resultCount !== null ? ` · ${q.resultCount} results · ${q.acceptedCount ?? 0} new` : ""}
          </Mono>
          {q.found.map((f) => (
            <Text key={f.itemId} style={{ fontFamily: font.body, fontSize: 13, lineHeight: 18, color: palette.soft }}>
              {"↳ "}
              {f.title}
              <Text style={{ color: palette.muted }}>
                {" "}
                · {f.publisher} · {f.status}
                {f.statusReason ? ` (${f.statusReason})` : ""}
              </Text>
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function SourcesSection({ state: s }: { state: DevState }) {
  const refresh = useRefreshSources();
  const byStatus = Object.entries(s.counts.sourceItems)
    .map(([status, n]) => `${n} ${status.replace(/_/g, " ")}`)
    .join(" · ");
  return (
    <Section kicker="Sources" title="Fetch now">
      <OButton title="Fetch my sources now" kind="secondary" loading={refresh.isPending} disabled={!s.counts.followedSources} onPress={() => refresh.mutate()} />
      {refresh.data && <Hint>{plural(refresh.data.sources, "source")} due now; the worker sweeps within a few seconds.</Hint>}
      {refresh.isError && <InlineError message={refresh.error.message} />}
      <View>
        <Row label="Followed" value={plural(s.counts.followedSources, "source")} />
        <Row label="Their items" value={byStatus || "None"} />
        <Row label="Discovered" value={plural(s.counts.discoveredItems, "page")} />
      </View>
    </Section>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12, minHeight: 44, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: palette.rule }}
    >
      <Text style={{ fontFamily: font.bodySemi, fontSize: 15, lineHeight: 20, color: palette.ink }}>{label}</Text>
      <Text style={{ flexShrink: 1, textAlign: "right", fontFamily: font.body, fontSize: 14, lineHeight: 20, color: palette.muted }}>{value}</Text>
    </View>
  );
}

function StatusBadge({ label, busy, bad }: { label: string; busy: boolean; bad: boolean }) {
  const bg = bad ? palette.orangeTint : busy ? palette.blueTint : palette.grey;
  const fg = bad ? palette.no : busy ? palette.blueInk : palette.muted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: bg, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 }}>
      {busy && <ActivityIndicator size="small" color={fg} style={{ transform: [{ scale: 0.6 }], width: 12, height: 12 }} />}
      <Mono color={fg}>{label}</Mono>
    </View>
  );
}

const Hint = ({ children }: { children: ReactNode }) => (
  <Text style={{ marginTop: -4, fontFamily: font.body, fontSize: 13, lineHeight: 18, color: palette.muted }}>{children}</Text>
);
const Detail = ({ children }: { children: ReactNode }) => (
  <Text style={{ paddingVertical: 8, fontFamily: font.body, fontSize: 13, lineHeight: 18, color: palette.soft, borderBottomWidth: 1, borderBottomColor: palette.rule }}>{children}</Text>
);
const Empty = ({ children }: { children: ReactNode }) => (
  <Text style={{ marginTop: 10, fontFamily: font.body, fontSize: 15, color: palette.muted }}>{children}</Text>
);

/** "Oct 4 18:02" */
function dayTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${clock(d)}`;
}

/** "12s ago", "4 min ago", or the time. */
function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return dayTime(iso);
}
