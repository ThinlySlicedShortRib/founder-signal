import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, palette } from "@/components/onboarding/kit";
import { PagerIcon, type PagerIconName } from "./icons";

/**
 * The floating dark pill (.pill on the boards): every screen's navigation and,
 * while reading, every action. It sits 22px above the bottom edge, or just
 * above the home indicator.
 */

export function usePillSpace() {
  const insets = useSafeAreaInsets();
  const bottom = insets.bottom > 0 ? insets.bottom + 6 : 22;
  /** Padding to leave under scrolling content so its end clears the pill (the boards' 104–110px). */
  return { bottom, space: bottom + 88 };
}

export function Pill({ children, label, z = 20 }: { children: ReactNode; label: string; z?: number }) {
  const { bottom } = usePillSpace();
  return (
    <View style={{ pointerEvents: "box-none", position: "absolute", left: 0, right: 0, bottom, alignItems: "center", zIndex: z }}>
      <View
        accessibilityRole="toolbar"
        accessibilityLabel={label}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 2,
          backgroundColor: palette.pill,
          borderRadius: 999,
          padding: 5,
          boxShadow: "0 12px 30px rgba(18,19,22,0.22)",
          maxWidth: "94%",
        }}
      >
        {children}
      </View>
    </View>
  );
}

/** .pb: a 44px round button; `blue` is the menu or tray button, `dim` an end of the pager. */
export function PillButton({
  icon,
  label,
  onPress,
  blue,
  dim,
  filled,
  expanded,
  pressed: isPressed,
}: {
  icon: PagerIconName;
  label: string;
  onPress?: () => void;
  blue?: boolean;
  dim?: boolean;
  filled?: boolean;
  expanded?: boolean;
  /** For toggles such as Save. */
  pressed?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-disabled={dim}
      aria-expanded={expanded}
      aria-pressed={isPressed}
      disabled={dim || !onPress}
      onPress={onPress}
      hitSlop={2}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: blue ? palette.blue : "transparent",
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <PagerIcon name={icon} color={dim ? palette.muted : "#FFFFFF"} filled={filled} />
    </Pressable>
  );
}

/** .pl: a mono kicker over the current page, e.g. TODAY / 2 / 5. */
export function PillLabel({ kicker, value }: { kicker: string; value: string }) {
  return (
    <View accessible accessibilityLabel={`${kicker}, ${value}`} style={{ minWidth: 92, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontFamily: font.mono, fontSize: 10, lineHeight: 12, letterSpacing: 0.8, textTransform: "uppercase", color: palette.pillMuted }}>{kicker}</Text>
      <Text numberOfLines={1} style={{ fontFamily: font.bodySemi, fontSize: 15, lineHeight: 18, color: "#FFFFFF" }}>
        {value}
      </Text>
    </View>
  );
}

/** .pv: a text button in the pill ("Not for me", "Worth it", "Piece 2 ↓"). */
export function PillAction({ title, onPress, primary, label }: { title: string; onPress: () => void; primary?: boolean; label?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        borderRadius: 999,
        paddingHorizontal: 16,
        justifyContent: "center",
        backgroundColor: primary ? palette.blue : "transparent",
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ fontFamily: font.bodySemi, fontSize: 15, lineHeight: 19, color: "#FFFFFF" }}>{title}</Text>
    </Pressable>
  );
}

/** .grow: the status part of the pill (progress ring + time left, or the verdict). */
export function PillStatus({ children, label }: { children: ReactNode; label: string }) {
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 6, paddingRight: 10, minWidth: 120 }}
    >
      {children}
    </View>
  );
}

export function PillStatusText({ children }: { children: ReactNode }) {
  return (
    <Text numberOfLines={1} style={{ fontFamily: font.bodySemi, fontSize: 14.5, lineHeight: 18, color: "#FFFFFF" }}>
      {children}
    </Text>
  );
}

/** The blue menu button: ≡ to open the big-type menu, × while it's open. */
export function MenuToggle({ open, onPress }: { open: boolean; onPress: () => void }) {
  return <PillButton icon={open ? "close" : "menu"} label={open ? "Close menu" : "Open menu"} onPress={onPress} blue expanded={open} />;
}
