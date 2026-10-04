import { BricolageGrotesque_500Medium, BricolageGrotesque_700Bold } from "@expo-google-fonts/bricolage-grotesque";
import { InstrumentSans_400Regular, InstrumentSans_500Medium, InstrumentSans_600SemiBold } from "@expo-google-fonts/instrument-sans";
import { JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, type PressableProps, Text, type TextProps, View, type ViewStyle } from "react-native";

/**
 * The onboarding look, taken value for value from the design canvas (board 13,
 * FillInSwipe, and the cards it uses). The board is light only, so onboarding
 * is too: it doesn't follow the system's dark mode.
 */

export const ONBOARDING_FONTS = {
  BricolageGrotesque_500Medium,
  BricolageGrotesque_700Bold,
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
  JetBrainsMono_500Medium,
};

/**
 * Custom fonts carry their weight in the family name. The board loads
 * Bricolage at 500 and 700 only, so its 600 headings render at 700.
 */
export const font = {
  display: "BricolageGrotesque_700Bold",
  displayMedium: "BricolageGrotesque_500Medium",
  body: "InstrumentSans_400Regular",
  bodyMedium: "InstrumentSans_500Medium",
  bodySemi: "InstrumentSans_600SemiBold",
  mono: "JetBrainsMono_500Medium",
} as const;

const palette = {
  ground: "#FBFBFA",
  surface: "#FFFFFF",
  ink: "#121316",
  muted: "#5B5F68",
  /** Links, dashed examples, card sources. */
  soft: "#4A4E57",
  /** The full prompt's text. */
  promptInk: "#3A3D44",
  line: "#D6D8DE",
  lineSoft: "#E2E4E8",
  grey: "#EEF0F4",
  off: "#E6E8EC",
  offText: "#8A8E97",
  blue: "#2B4BFF",
  onBlue: "#FFFFFF",
  blueCard: "#DCE3FF",
  blueTint: "#EEF2FF",
  cardInk: "#4A5578",
  cardRule: "rgba(18,19,22,0.12)",
  ghost: "rgba(18,19,22,0.07)",
  /** The agent's voice. */
  orange: "#FF5A1F",
  blank: "#E8461A",
  orangeTint: "#FFF1EC",
  droppedInk: "#8A3B12",
  noteBg: "#FFF4EE",
  noteInk: "#3A2418",
  no: "#B4380F",
  yes: "#1F7A4D",
  scrim: "rgba(18,19,22,0.38)",
  tints: ["#DCE3FF", "#FFE3D6", "#ECEEF2", "#DCE3FF", "#FFE3D6"],
  pillOnTint: "rgba(255,255,255,0.7)",
  whyOnTint: "rgba(255,255,255,0.75)",
  stampBg: "rgba(255,255,255,0.9)",
};

export type OnboardingColors = typeof palette;

export function usePalette(): OnboardingColors {
  return palette;
}

/** CSS letter-spacing in em, as React Native points. */
export const em = (value: number, size: number) => value * size;

type Variant = "display" | "h" | "body" | "small" | "mono";

const VARIANTS = {
  display: { fontFamily: font.display, fontSize: 26, lineHeight: 28.6, letterSpacing: em(-0.02, 26) },
  // .h: Bricolage at 600 (rendered 700), 24px, line-height 1.2, -0.015em.
  h: { fontFamily: font.display, fontSize: 24, lineHeight: 28.8, letterSpacing: em(-0.015, 24) },
  body: { fontFamily: font.body, fontSize: 15, lineHeight: 21.75 },
  small: { fontFamily: font.body, fontSize: 13, lineHeight: 18 },
  mono: { fontFamily: font.mono, fontSize: 11, lineHeight: 15, letterSpacing: em(0.08, 11), textTransform: "uppercase" as const },
};

export function OText({ variant = "body", color, style, ...props }: TextProps & { variant?: Variant; color?: string }) {
  return (
    <Text
      accessibilityRole={variant === "display" || variant === "h" ? "header" : undefined}
      style={[VARIANTS[variant], { color: color ?? (variant === "mono" || variant === "small" ? palette.muted : palette.ink) }, style]}
      {...props}
    />
  );
}

/** .chip / .chip.on */
export function Chip({ label, on, onPress }: { label: string; on: boolean; onPress?: () => void }) {
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityState={onPress ? { selected: on } : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        borderRadius: 999,
        borderWidth: 1.5,
        borderColor: on ? palette.ink : palette.line,
        backgroundColor: on ? palette.ink : palette.surface,
        paddingHorizontal: 15,
        paddingVertical: 9,
        justifyContent: "center",
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ fontFamily: font.body, fontSize: 15, lineHeight: 20, color: on ? palette.onBlue : palette.ink }}>{label}</Text>
    </Pressable>
  );
}

export function Chips({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{children}</View>;
}

/** .btn.pri / .btn.sec / .btn.off */
export function OButton({
  title,
  kind = "primary",
  disabled,
  loading,
  style,
  ...props
}: Omit<PressableProps, "style"> & { title: string; kind?: "primary" | "secondary"; loading?: boolean; style?: ViewStyle }) {
  const off = disabled && !loading;
  const bg = off ? palette.off : kind === "primary" ? palette.blue : palette.grey;
  const fg = off ? palette.offText : kind === "primary" ? palette.onBlue : palette.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      disabled={disabled || loading}
      style={({ pressed }) => [
        { minHeight: 50, borderRadius: 14, backgroundColor: bg, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 16, opacity: pressed ? 0.88 : 1 },
        style,
      ]}
      {...props}
    >
      {loading && <ActivityIndicator color={fg} />}
      <Text style={{ fontFamily: font.bodySemi, fontSize: 16, lineHeight: 20, color: fg }}>{title}</Text>
    </Pressable>
  );
}

/** .link; `accent` is the blue "Read the full prompt" toggle. */
export function LinkButton({
  title,
  onPress,
  tone = "muted",
  align = "center",
  compact,
}: {
  title: string;
  onPress: () => void;
  tone?: "muted" | "accent";
  align?: "center" | "start";
  /** min-height 32 and no padding, as the board's inline links. */
  compact?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={compact ? 6 : 0}
      style={({ pressed }) => ({ minHeight: compact ? 32 : 44, justifyContent: "center", alignSelf: align === "start" ? "flex-start" : "center", opacity: pressed ? 0.6 : 1 })}
    >
      <Text style={{ fontFamily: tone === "accent" ? font.bodySemi : font.body, fontSize: 14, lineHeight: 19, color: tone === "accent" ? palette.blue : palette.soft }}>{title}</Text>
    </Pressable>
  );
}

/** .note: the agent's voice, an orange dot and a line on light orange. */
export function AgentNote({ children }: { children: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", backgroundColor: palette.noteBg, borderRadius: 14, paddingVertical: 11, paddingHorizontal: 13 }}>
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: palette.orange, marginTop: 1 }} />
      <Text style={{ flex: 1, fontFamily: font.body, fontSize: 15, lineHeight: 21.75, color: palette.noteInk }}>{children}</Text>
    </View>
  );
}

/** Not on the board (it has no failures); styled like its dropped-lines notice. */
export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View accessibilityRole="alert" style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: palette.orangeTint, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 }}>
      <Ionicons name="alert-circle-outline" size={16} color={palette.no} />
      <Text style={{ flex: 1, fontFamily: font.body, fontSize: 13, lineHeight: 18, color: palette.droppedInk }}>{message}</Text>
      {onRetry && <LinkButton title="Retry" tone="accent" compact onPress={onRetry} />}
    </View>
  );
}
