import { type ReactNode, useEffect } from "react";
import { BackHandler, Platform, Pressable, ScrollView, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, { FadeIn, SlideInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { palette } from "@/components/onboarding/kit";

/**
 * A bottom sheet over a scrim (.scrim + .fb / .adlg / .msheet on the boards).
 * It's drawn inside the screen rather than in a Modal, so the floating pill
 * can stay above the menu sheet the way the boards show it (`z` sets the
 * order: the menu sits under the pill, dialogs over it).
 */
export function Sheet({
  open,
  onClose,
  label,
  children,
  z = 40,
  radius = 26,
  style,
  scroll = true,
  grab = true,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  z?: number;
  radius?: number;
  style?: ViewStyle;
  scroll?: boolean;
  grab?: boolean;
}) {
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!open || Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);

  if (!open) return null;
  const body = (
    <>
      {grab && <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: palette.lineSoft, alignSelf: "center", marginBottom: 6 }} />}
      {children}
    </>
  );
  const pad: ViewStyle = { paddingTop: 10, paddingHorizontal: 20, paddingBottom: 28 + insets.bottom, ...style };
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: z }]}>
      <Animated.View entering={FadeIn.duration(160)} style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(18,19,22,0.4)" }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View
        entering={SlideInDown.duration(260)}
        accessibilityViewIsModal
        accessibilityLabel={label}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: "88%",
          backgroundColor: palette.surface,
          borderTopLeftRadius: radius,
          borderTopRightRadius: radius,
          overflow: "hidden",
        }}
      >
        {scroll ? (
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled" contentContainerStyle={[{ gap: 14 }, pad]}>
            {body}
          </ScrollView>
        ) : (
          <View style={pad}>{body}</View>
        )}
      </Animated.View>
    </View>
  );
}
