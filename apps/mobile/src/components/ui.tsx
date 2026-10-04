import Ionicons from "@expo/vector-icons/Ionicons";
import type { ComponentProps, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  type TextInputProps,
  type TextProps,
  View,
  type ViewProps,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, palette } from "@/components/onboarding/kit";

/**
 * Plain screens (Sources, Add source, Sign in, errors) in the Layout 6 look:
 * the kit's palette and fonts, white cards on the off-white ground, pill buttons.
 */

export type IconName = ComponentProps<typeof Ionicons>["name"];

/** Minimum tap target (build plan §8). */
export const TAP = 44;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Scrollable page with a readable max width (tablets, web) and optional pull-to-refresh. */
export function Screen({
  children,
  refreshing,
  onRefresh,
  edges = "bottom",
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Which safe-area edges this screen pads itself (headers usually handle the top). */
  edges?: "bottom" | "both";
}) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.ground }}
      contentContainerStyle={{
        padding: 20,
        paddingTop: edges === "both" ? insets.top + 22 : 12,
        paddingBottom: insets.bottom + space.xxl,
        width: "100%",
        maxWidth: 680,
        alignSelf: "center",
        gap: space.lg,
      }}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={palette.muted} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

export function Title({ style, ...props }: TextProps) {
  return <Text accessibilityRole="header" style={[{ fontFamily: font.display, fontSize: 34, lineHeight: 36, letterSpacing: -1, color: palette.ink }, style]} {...props} />;
}

export function Heading({ style, ...props }: TextProps) {
  return <Text accessibilityRole="header" style={[{ fontFamily: font.display, fontSize: 22, lineHeight: 26, letterSpacing: -0.45, color: palette.ink }, style]} {...props} />;
}

export function Body({ style, muted, ...props }: TextProps & { muted?: boolean }) {
  return <Text style={[{ fontFamily: font.body, fontSize: 16, lineHeight: 23, color: muted ? palette.muted : palette.ink }, style]} {...props} />;
}

export function Small({ style, muted = true, ...props }: TextProps & { muted?: boolean }) {
  return <Text style={[{ fontFamily: font.body, fontSize: 13.5, lineHeight: 19, color: muted ? palette.muted : palette.ink }, style]} {...props} />;
}

/** The boards' mono kicker. */
export function Kicker({ style, ...props }: TextProps) {
  return <Text style={[{ fontFamily: font.mono, fontSize: 11, lineHeight: 15, letterSpacing: 0.88, textTransform: "uppercase", color: palette.muted }, style]} {...props} />;
}

export function Card({ style, children, ...props }: ViewProps) {
  return (
    <View style={[{ backgroundColor: palette.surface, borderRadius: 20, borderWidth: 1, borderColor: palette.rule, padding: 18, gap: space.sm }, style]} {...props}>
      {children}
    </View>
  );
}

/** A tappable row inside a card or list: icon, label, detail, chevron. */
export function Row({
  icon,
  label,
  detail,
  onPress,
  accessibilityHint,
  trailing,
}: {
  icon?: IconName;
  label: string;
  detail?: string | null;
  onPress?: () => void;
  accessibilityHint?: string;
  trailing?: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => ({ minHeight: TAP, flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.sm, opacity: pressed ? 0.6 : 1 })}
    >
      {icon && <Ionicons name={icon} size={20} color={palette.blue} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Body style={{ fontFamily: font.bodySemi }}>{label}</Body>
        {detail ? <Small numberOfLines={2}>{detail}</Small> : null}
      </View>
      {trailing}
      {onPress && <Ionicons name="chevron-forward" size={18} color={palette.muted} />}
    </Pressable>
  );
}

export function Divider() {
  return <View style={{ height: 1, backgroundColor: palette.rule }} />;
}

type ButtonVariant = "primary" | "secondary" | "danger";

/** .btn.pri / .btn.sec: pill buttons. */
export function Button({
  title,
  variant = "primary",
  loading,
  icon,
  disabled,
  ...props
}: PressableProps & { title: string; variant?: ButtonVariant; loading?: boolean; icon?: IconName }) {
  const c = {
    primary: { bg: palette.blue, fg: palette.onBlue, border: palette.blue },
    secondary: { bg: palette.surface, fg: palette.ink, border: palette.lineSoft },
    danger: { bg: palette.surface, fg: palette.no, border: palette.lineSoft },
  }[variant];
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      aria-disabled={!!isDisabled}
      aria-busy={!!loading}
      disabled={isDisabled}
      style={({ pressed }) => ({
        minHeight: 52,
        borderRadius: 999,
        borderWidth: 1.5,
        borderColor: c.border,
        backgroundColor: c.bg,
        paddingHorizontal: 22,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
        opacity: isDisabled ? 0.5 : pressed ? 0.88 : 1,
      })}
      {...props}
    >
      {loading ? <ActivityIndicator color={c.fg} /> : icon ? <Ionicons name={icon} size={18} color={c.fg} /> : null}
      <Text style={{ color: c.fg, fontFamily: font.bodySemi, fontSize: 16 }}>{title}</Text>
    </Pressable>
  );
}

export function TextField({ label, error, hint, style, ...props }: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  return (
    <View style={{ gap: space.xs }}>
      <Kicker>{label}</Kicker>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        placeholderTextColor={palette.offText}
        style={[
          {
            minHeight: 52,
            borderRadius: 16,
            borderWidth: 1.5,
            borderColor: error ? palette.no : palette.lineSoft,
            backgroundColor: palette.surface,
            paddingHorizontal: 16,
            fontFamily: font.body,
            fontSize: 17,
            color: palette.ink,
          },
          style,
        ]}
        {...props}
      />
      {error ? (
        <Small style={{ color: palette.no }} accessibilityLiveRegion="polite">
          {error}
        </Small>
      ) : hint ? (
        <Small>{hint}</Small>
      ) : null}
    </View>
  );
}

export function EmptyState({ icon, title, body, children }: { icon: IconName; title: string; body: string; children?: ReactNode }) {
  return (
    <Card style={{ alignItems: "center", paddingVertical: space.xxl, gap: space.md }}>
      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: palette.blueCard, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name={icon} size={26} color={palette.blue} />
      </View>
      <Heading style={{ textAlign: "center" }}>{title}</Heading>
      <Body muted style={{ textAlign: "center", maxWidth: 420 }}>
        {body}
      </Body>
      {children ? <View style={{ alignSelf: "stretch", gap: space.sm, marginTop: space.sm }}>{children}</View> : null}
    </Card>
  );
}

/** .badge-like status chips. */
export function Badge({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "accent" | "warning" | "danger" }) {
  const c = {
    neutral: { bg: palette.grey, fg: palette.promptInk },
    accent: { bg: palette.blueCard, fg: palette.blueInk },
    warning: { bg: palette.orangeTint, fg: palette.droppedInk },
    danger: { bg: palette.orangeTint, fg: palette.no },
  }[tone];
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: "flex-start" }}>
      <Text style={{ color: c.fg, fontFamily: font.bodySemi, fontSize: 12.5 }}>{label}</Text>
    </View>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: palette.orangeTint, borderRadius: 14, padding: space.md, flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Ionicons name="alert-circle-outline" size={20} color={palette.no} />
      <Body style={{ flex: 1, color: palette.droppedInk, fontSize: 15 }}>{message}</Body>
      {onRetry && (
        <Pressable accessibilityRole="button" onPress={onRetry} style={{ minHeight: TAP, justifyContent: "center", paddingHorizontal: space.sm }}>
          <Text style={{ color: palette.blue, fontFamily: font.bodySemi }}>Retry</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Radio-style choice list (a source's mode), styled like the reasons sheet's options. */
export function ChoiceList<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; title: string; description: string }[];
  label: string;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ gap: space.sm }}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            aria-checked={selected}
            accessibilityLabel={`${o.title}. ${o.description}`}
            onPress={() => onChange(o.value)}
            style={{
              minHeight: 56,
              flexDirection: "row",
              gap: space.md,
              padding: 14,
              borderRadius: 16,
              borderWidth: 1.5,
              borderColor: selected ? palette.blue : palette.lineSoft,
              backgroundColor: selected ? palette.blueCard : palette.surface,
            }}
          >
            <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={22} color={selected ? palette.blue : palette.boxLine} />
            <View style={{ flex: 1, gap: 2 }}>
              <Body style={{ fontFamily: font.bodySemi, color: selected ? palette.blueInk : palette.ink }}>{o.title}</Body>
              <Small>{o.description}</Small>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
