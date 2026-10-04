import { type Href, router } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { font, palette } from "@/components/onboarding/kit";
import { monthKey, plural } from "@/lib/format";
import { useActivity, useLetters, useSaved, useTodayLetter } from "@/lib/letters";
import { usePillSpace } from "./Pill";
import { Sheet } from "./Sheet";

export type Destination = "today" | "library" | "activity" | "preferences";

const HREF: Record<Destination, Href> = { today: "/", library: "/library", activity: "/activity", preferences: "/preferences" };

/** The big-type menu (.msheet): Today / Library / Activity / Preferences, the current one in blue. */
export function MenuSheet({ open, onClose, current }: { open: boolean; onClose: () => void; current: Destination | null }) {
  const { space } = usePillSpace();
  const today = useTodayLetter();
  const saved = useSaved({ enabled: open });
  const letters = useLetters({ enabled: open });
  const now = new Date();
  const activity = useActivity(monthKey(now), { enabled: open });

  const letter = today.data;
  const sub: Record<Destination, string> = {
    today: letter ? `No. ${letter.number} · ${plural(letter.pieces.length, "piece")}` : "Your next letter",
    library: [saved.data && `${saved.data.length} saved`, letters.data && plural(letters.data.length, "letter")].filter(Boolean).join(" · ") || "Saved and past letters",
    activity: activity.data ? `${plural(activity.data.activeDays, "day")} in ${now.toLocaleDateString("en-US", { month: "short" })}` : "What you've read",
    preferences: "Brief, sources, schedule",
  };

  function go(d: Destination) {
    onClose();
    if (d !== current) router.replace(HREF[d]);
  }

  return (
    <Sheet open={open} onClose={onClose} label="Menu" z={15} radius={28} scroll={false} style={{ paddingBottom: space }}>
      <View accessibilityRole="menu">
        {(Object.keys(HREF) as Destination[]).map((d) => {
          const on = d === current;
          return (
            <Pressable
              key={d}
              accessibilityRole="menuitem"
              accessibilityLabel={`${d[0]!.toUpperCase()}${d.slice(1)}, ${sub[d]}`}
              aria-current={on ? "page" : undefined}
              onPress={() => go(d)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "flex-end",
                justifyContent: "space-between",
                gap: 10,
                paddingVertical: 14,
                borderBottomWidth: 1,
                borderBottomColor: palette.rule,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ fontFamily: font.display, fontSize: 44, lineHeight: 46, letterSpacing: -0.035 * 44, color: on ? palette.blue : palette.ink }}>
                {d[0]!.toUpperCase() + d.slice(1)}
              </Text>
              <Text
                numberOfLines={2}
                style={{ flexShrink: 1, maxWidth: 150, paddingBottom: 8, textAlign: "right", fontFamily: font.mono, fontSize: 11, letterSpacing: 0.88, textTransform: "uppercase", color: palette.muted }}
              >
                {sub[d]}
              </Text>
            </Pressable>
          );
        })}
        {__DEV__ && (
          <Pressable
            accessibilityRole="menuitem"
            accessibilityLabel="Dev tools, local API only"
            onPress={() => {
              onClose();
              router.push("/dev");
            }}
            style={({ pressed }) => ({ minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 10, opacity: pressed ? 0.6 : 1 })}
          >
            <Text style={{ fontFamily: font.bodySemi, fontSize: 15, color: palette.ink }}>Dev tools</Text>
            <Text style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: 0.88, textTransform: "uppercase", color: palette.muted }}>Local only</Text>
          </Pressable>
        )}
      </View>
    </Sheet>
  );
}
