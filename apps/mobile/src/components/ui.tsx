import Ionicons from "@expo/vector-icons/Ionicons";
import type { ComponentProps, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextProps,
  View,
  type ViewProps,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, serif, space, TAP, useColors } from "@/lib/theme";

export type IconName = ComponentProps<typeof Ionicons>["name"];

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
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.background }}
      contentContainerStyle={{
        padding: space.lg,
        paddingTop: edges === "both" ? insets.top + space.lg : space.lg,
        paddingBottom: insets.bottom + space.xxl,
        width: "100%",
        maxWidth: 680,
        alignSelf: "center",
        gap: space.lg,
      }}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={c.textMuted} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

export function Title({ style, ...props }: TextProps) {
  const c = useColors();
  return <Text accessibilityRole="header" style={[{ fontFamily: serif, fontSize: 28, lineHeight: 34, color: c.text, fontWeight: "600" }, style]} {...props} />;
}

export function Heading({ style, ...props }: TextProps) {
  const c = useColors();
  return <Text accessibilityRole="header" style={[{ fontFamily: serif, fontSize: 20, lineHeight: 26, color: c.text, fontWeight: "600" }, style]} {...props} />;
}

export function Body({ style, muted, ...props }: TextProps & { muted?: boolean }) {
  const c = useColors();
  return <Text style={[{ fontSize: 16, lineHeight: 24, color: muted ? c.textMuted : c.text }, style]} {...props} />;
}

export function Small({ style, muted = true, ...props }: TextProps & { muted?: boolean }) {
  const c = useColors();
  return <Text style={[{ fontSize: 13, lineHeight: 18, color: muted ? c.textMuted : c.text }, style]} {...props} />;
}

export function Card({ style, children, ...props }: ViewProps) {
  const c = useColors();
  return (
    <View style={[{ backgroundColor: c.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: space.lg, gap: space.sm }, style]} {...props}>
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
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => ({ minHeight: TAP, flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.sm, opacity: pressed ? 0.6 : 1 })}
    >
      {icon && <Ionicons name={icon} size={22} color={c.accent} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Body>{label}</Body>
        {detail ? <Small numberOfLines={2}>{detail}</Small> : null}
      </View>
      {trailing}
      {onPress && <Ionicons name="chevron-forward" size={18} color={c.textMuted} />}
    </Pressable>
  );
}

export function Divider() {
  const c = useColors();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />;
}

type ButtonVariant = "primary" | "secondary" | "danger";

export function Button({
  title,
  variant = "primary",
  loading,
  icon,
  disabled,
  ...props
}: PressableProps & { title: string; variant?: ButtonVariant; loading?: boolean; icon?: IconName }) {
  const c = useColors();
  const palette = {
    primary: { bg: c.accent, fg: c.accentText, border: c.accent },
    secondary: { bg: "transparent", fg: c.text, border: c.border },
    danger: { bg: "transparent", fg: c.danger, border: c.danger },
  }[variant];
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      disabled={isDisabled}
      style={({ pressed }) => ({
        minHeight: TAP + 4,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.bg,
        paddingHorizontal: space.lg,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
        opacity: isDisabled ? 0.5 : pressed ? 0.8 : 1,
      })}
      {...props}
    >
      {loading ? <ActivityIndicator color={palette.fg} /> : icon ? <Ionicons name={icon} size={18} color={palette.fg} /> : null}
      <Text style={{ color: palette.fg, fontSize: 16, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
}

export function TextField({ label, error, hint, style, ...props }: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  const c = useColors();
  return (
    <View style={{ gap: space.xs }}>
      <Small muted={false} style={{ fontWeight: "600" }}>
        {label}
      </Small>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        placeholderTextColor={c.textMuted}
        style={[
          {
            minHeight: TAP + 4,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: error ? c.danger : c.border,
            backgroundColor: c.surface,
            paddingHorizontal: space.md,
            fontSize: 17,
            color: c.text,
          },
          style,
        ]}
        {...props}
      />
      {error ? (
        <Small style={{ color: c.danger }} accessibilityLiveRegion="polite">
          {error}
        </Small>
      ) : hint ? (
        <Small>{hint}</Small>
      ) : null}
    </View>
  );
}

export function EmptyState({ icon, title, body, children }: { icon: IconName; title: string; body: string; children?: ReactNode }) {
  const c = useColors();
  return (
    <Card style={{ alignItems: "center", paddingVertical: space.xxl, gap: space.md }}>
      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: c.accentSoft, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name={icon} size={26} color={c.accent} />
      </View>
      <Heading style={{ textAlign: "center" }}>{title}</Heading>
      <Body muted style={{ textAlign: "center", maxWidth: 420 }}>
        {body}
      </Body>
      {children ? <View style={{ alignSelf: "stretch", gap: space.sm, marginTop: space.sm }}>{children}</View> : null}
    </Card>
  );
}

export function Badge({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "accent" | "warning" | "danger" }) {
  const c = useColors();
  const colors = {
    neutral: { bg: c.surfaceMuted, fg: c.textMuted },
    accent: { bg: c.accentSoft, fg: c.accent },
    warning: { bg: c.warningSoft, fg: c.warning },
    danger: { bg: c.dangerSoft, fg: c.danger },
  }[tone];
  return (
    <View style={{ backgroundColor: colors.bg, borderRadius: 999, paddingHorizontal: space.sm, paddingVertical: 2, alignSelf: "flex-start" }}>
      <Text style={{ color: colors.fg, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const c = useColors();
  return (
    <View
      accessibilityRole="alert"
      style={{ backgroundColor: c.dangerSoft, borderRadius: radius.md, padding: space.md, flexDirection: "row", alignItems: "center", gap: space.sm }}
    >
      <Ionicons name="alert-circle" size={20} color={c.danger} />
      <Body style={{ flex: 1, color: c.danger }}>{message}</Body>
      {onRetry && (
        <Pressable accessibilityRole="button" onPress={onRetry} style={{ minHeight: TAP, justifyContent: "center", paddingHorizontal: space.sm }}>
          <Text style={{ color: c.danger, fontWeight: "600" }}>Retry</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Radio-style choice list (e.g. a source's mode). */
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
  const c = useColors();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ gap: space.sm }}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={`${o.title}. ${o.description}`}
            onPress={() => onChange(o.value)}
            style={{
              minHeight: TAP,
              flexDirection: "row",
              gap: space.md,
              padding: space.md,
              borderRadius: radius.md,
              borderWidth: selected ? 2 : 1,
              borderColor: selected ? c.accent : c.border,
              backgroundColor: selected ? c.accentSoft : c.surface,
            }}
          >
            <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={22} color={selected ? c.accent : c.textMuted} />
            <View style={{ flex: 1, gap: 2 }}>
              <Body style={{ fontWeight: "600" }}>{o.title}</Body>
              <Small>{o.description}</Small>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
