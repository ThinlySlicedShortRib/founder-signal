import type { ActivityMonth } from "@fs/schema";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, InlineError, palette } from "@/components/onboarding/kit";
import { PagerIcon } from "@/components/pager/icons";
import { usePillSpace } from "@/components/pager/Pill";
import { Display, Mono, PagerScreen, Segmented } from "@/components/pager/PagerScreen";
import { monthKey, parseDay, plural, shortDate } from "@/lib/format";
import { useActivity } from "@/lib/letters";

type View_ = "grid" | "list";

/** .c.l0–.c.l3 */
const LEVEL = [
  { bg: palette.surface, fg: palette.muted, border: palette.rule },
  { bg: palette.blueCard, fg: palette.ink },
  { bg: palette.blueMid, fg: palette.ink },
  { bg: palette.blue, fg: "#FFFFFF" },
] as const;
const WORDS = ["nothing", "a little", "some", "a lot"];

/** Activity (PagerActivity): a month of reading as a grid or a list. No streaks. */
export default function Activity() {
  const insets = useSafeAreaInsets();
  const { space } = usePillSpace();
  const now = new Date();
  const [month, setMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [view, setView] = useState<View_>("grid");
  const activity = useActivity(monthKey(month));
  const monthName = month.toLocaleDateString("en-US", { month: "long" });
  const isCurrent = monthKey(month) === monthKey(now);
  const heading = view === "grid" ? monthName : "Lately";
  const shift = (by: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + by, 1));
  const a = activity.data;

  return (
    <PagerScreen current="activity" kicker="Activity" title={heading}>
      <View style={{ paddingTop: insets.top + 22, paddingHorizontal: 20, gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Mono>Activity · {month.getFullYear()}</Mono>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <RoundButton icon="chevron-left" label="Previous month" onPress={() => shift(-1)} />
            <RoundButton icon="chevron-right" label="Next month" onPress={() => shift(1)} disabled={isCurrent} />
          </View>
        </View>
        <Display size={60} lineHeight={60}>
          {heading}
        </Display>
        <Text style={{ fontFamily: font.body, fontSize: 15, lineHeight: 21.75, color: palette.promptInk }}>
          {a
            ? a.activeDays
              ? `You read or reviewed something on ${plural(a.activeDays, "day")} in ${monthName}. No streaks to keep up. This is just what happened.`
              : `Nothing read or reviewed in ${monthName}${isCurrent ? " yet" : ""}. No streaks to keep up.`
            : " "}
        </Text>
        <Segmented<View_>
          label="View"
          value={view}
          onChange={setView}
          options={[
            ["grid", "Month grid"],
            ["list", "List"],
          ]}
        />
      </View>
      {activity.isPending ? (
        <ActivityIndicator color={palette.muted} style={{ marginTop: 40 }} accessibilityLabel="Loading" />
      ) : activity.isError ? (
        <View style={{ padding: 20 }}>
          <InlineError message={activity.error.message} onRetry={() => void activity.refetch()} />
        </View>
      ) : view === "grid" ? (
        <Grid activity={a!} month={month} bottom={space - 6} />
      ) : (
        <List activity={a!} bottom={space} />
      )}
    </PagerScreen>
  );
}

function Grid({ activity, month, bottom }: { activity: ActivityMonth; month: Date; bottom: number }) {
  const offset = (month.getDay() + 6) % 7; // Monday first
  const byDay = new Map(activity.days.map((d) => [d.day, d]));
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (number | null)[] = [...Array<null>(offset).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const rows = Array.from({ length: cells.length / 7 }, (_, r) => cells.slice(r * 7, r * 7 + 7));
  const key = monthKey(month);

  return (
    <View style={{ flex: 1, paddingTop: 14, paddingHorizontal: 12, paddingBottom: bottom, gap: 6 }}>
      <View style={{ flexDirection: "row", gap: 4 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <Mono key={i} style={{ flex: 1 }}>
            {d}
          </Mono>
        ))}
      </View>
      <View accessibilityRole="list" accessibilityLabel={month.toLocaleDateString("en-US", { month: "long", year: "numeric" })} style={{ flex: 1, gap: 4 }}>
        {rows.map((row, r) => (
          <View key={r} style={{ flex: 1, flexDirection: "row", gap: 4 }}>
            {row.map((n, c) => {
              if (n === null) return <View key={c} style={{ flex: 1 }} />;
              const day = `${key}-${String(n).padStart(2, "0")}`;
              const level = Math.max(0, Math.min(3, byDay.get(day)?.level ?? 0));
              const s = LEVEL[level]!;
              return (
                <View
                  key={c}
                  accessible
                  accessibilityLabel={`${shortDate(parseDay(day))}: ${WORDS[level]}`}
                  style={{
                    flex: 1,
                    borderRadius: 14,
                    paddingVertical: 6,
                    paddingHorizontal: 7,
                    backgroundColor: s.bg,
                    borderWidth: "border" in s ? 1.5 : 0,
                    borderColor: "border" in s ? s.border : undefined,
                  }}
                >
                  <Text style={{ fontFamily: font.display, fontSize: 20, letterSpacing: -0.4, color: s.fg }}>{n}</Text>
                </View>
              );
            })}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Text style={{ fontFamily: font.body, fontSize: 13, color: palette.muted }}>None</Text>
        {LEVEL.map((l, i) => (
          <View key={i} style={{ width: 14, height: 14, borderRadius: 4, backgroundColor: l.bg, borderWidth: i === 0 ? 1.5 : 0, borderColor: palette.lineSoft }} />
        ))}
        <Text style={{ fontFamily: font.body, fontSize: 13, color: palette.muted }}>A lot</Text>
      </View>
    </View>
  );
}

function List({ activity, bottom }: { activity: ActivityMonth; bottom: number }) {
  const rows = activity.days.filter((d) => d.read > 0 || d.reviewed > 0).sort((a, b) => b.day.localeCompare(a.day));
  return (
    <ScrollView contentContainerStyle={{ paddingTop: 6, paddingHorizontal: 20, paddingBottom: bottom }}>
      {rows.length === 0 ? (
        <Text style={{ marginTop: 12, fontFamily: font.body, fontSize: 16, color: palette.muted }}>Nothing this month yet.</Text>
      ) : (
        rows.map((d) => {
          const what = [d.read ? `${d.read} read` : null, d.reviewed ? `${d.reviewed} reviewed` : null].filter(Boolean).join(" · ");
          return (
            <View
              key={d.day}
              accessible
              accessibilityLabel={`${shortDate(d.day)}: ${what}`}
              style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 64, borderBottomWidth: 1, borderBottomColor: palette.rule }}
            >
              <Text style={{ fontFamily: font.display, fontSize: 24, letterSpacing: -0.48, color: palette.ink }}>{shortDate(d.day)}</Text>
              <Text style={{ fontFamily: font.body, fontSize: 14, color: palette.muted }}>{what}</Text>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

function RoundButton({ icon, label, onPress, disabled }: { icon: "chevron-left" | "chevron-right"; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        borderWidth: 1.5,
        borderColor: palette.lineSoft,
        backgroundColor: palette.surface,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.35 : pressed ? 0.7 : 1,
      })}
    >
      <PagerIcon name={icon} size={18} color={palette.ink} />
    </Pressable>
  );
}
