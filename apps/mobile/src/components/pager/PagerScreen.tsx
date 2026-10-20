import { StatusBar } from "expo-status-bar";
import { type ReactNode, useState } from "react";
import { ActivityIndicator, Pressable, Text, type TextProps, View } from "react-native";
import { font, palette } from "@/components/onboarding/kit";
import { type Destination, MenuSheet } from "./MenuSheet";
import { MenuToggle, Pill, PillLabel } from "./Pill";

/** Library, Activity and Preferences (and Dev tools): the page, the pill (label + menu) and the menu sheet. */
export function PagerScreen({
  current,
  kicker,
  title,
  statusBar = "dark",
  children,
}: {
  /** Null for a page that isn't one of the menu's destinations. */
  current: Destination | null;
  /** The pill's small label, e.g. "Library". */
  kicker: string;
  /** The pill's value, e.g. "Saved". */
  title: string;
  /** Light over dark art at the top of the page (Today's hero). */
  statusBar?: "dark" | "light";
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <View style={{ flex: 1, backgroundColor: palette.ground }}>
      <StatusBar style={statusBar} />
      {children}
      <MenuSheet open={menuOpen} onClose={() => setMenuOpen(false)} current={current} />
      <Pill label="Navigation" mode="screen">
        <PillLabel kicker={kicker} value={title} />
        <MenuToggle open={menuOpen} onPress={() => setMenuOpen((o) => !o)} />
      </Pill>
    </View>
  );
}

/** .mono: JetBrains Mono 11, uppercase, 0.08em. */
export function Mono({ style, color, ...props }: TextProps & { color?: string }) {
  return <Text style={[{ fontFamily: font.mono, fontSize: 11, lineHeight: 15, letterSpacing: 0.88, textTransform: "uppercase", color: color ?? palette.muted }, style]} {...props} />;
}

/** .hd: Bricolage 700 at -0.03em. Line height defaults to the boards' 1.0 (plus room for descenders). */
export function Display({ size, lineHeight, color, style, ...props }: TextProps & { size: number; lineHeight?: number; color?: string }) {
  return (
    <Text
      accessibilityRole="header"
      style={[{ fontFamily: font.display, fontSize: size, lineHeight: lineHeight ?? Math.round(size * 1.04), letterSpacing: -0.03 * size, color: color ?? palette.ink }, style]}
      {...props}
    />
  );
}

/** .seg2: the switch (Saved / Letters / Podcasts, Month grid / List). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={{ flexDirection: "row", borderWidth: 1.5, borderColor: palette.ink, borderRadius: 999, padding: 3, gap: 3 }}
    >
      {options.map(([v, l]) => {
        const on = v === value;
        return (
          <Pressable
            key={v}
            accessibilityRole="tab"
            aria-selected={on}
            onPress={() => onChange(v)}
            style={{ flex: 1, minHeight: 40, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: on ? palette.ink : "transparent" }}
          >
            <Text style={{ fontFamily: font.bodySemi, fontSize: 15, color: on ? "#FFFFFF" : palette.ink }}>{l}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** .agent: the post office's voice, an orange dot on light orange. */
export function AgentLine({ children, numberOfLines }: { children: ReactNode; numberOfLines?: number }) {
  return (
    <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", backgroundColor: palette.noteBg, borderRadius: 16, paddingVertical: 13, paddingHorizontal: 14 }}>
      <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: palette.orange, marginTop: 2 }} />
      <Text numberOfLines={numberOfLines} style={{ flex: 1, fontFamily: font.body, fontSize: 15, lineHeight: 21.75, color: palette.noteInk }}>
        {children}
      </Text>
    </View>
  );
}

/** A whole page that's loading or failed, under the same pill and menu. */
export function PageState({ current, kicker, error, onRetry }: { current: Destination; kicker: string; error?: string | null; onRetry?: () => void }) {
  return (
    <PagerScreen current={current} kicker={kicker} title={error ? "Not loaded" : "Loading"}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 14 }}>
        {error ? (
          <>
            <Text style={{ fontFamily: font.body, fontSize: 16, lineHeight: 23, color: palette.promptInk, textAlign: "center" }}>{error}</Text>
            {onRetry && (
              <Pressable accessibilityRole="button" onPress={onRetry} style={{ minHeight: 44, justifyContent: "center" }}>
                <Text style={{ fontFamily: font.bodySemi, fontSize: 15, color: palette.blue }}>Try again</Text>
              </Pressable>
            )}
          </>
        ) : (
          <ActivityIndicator color={palette.muted} accessibilityLabel="Loading" />
        )}
      </View>
    </PagerScreen>
  );
}
