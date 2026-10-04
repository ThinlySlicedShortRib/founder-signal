import { View } from "react-native";

/** .prog: one 18×4 bar per page, filled up to the current one. White on photos. */
export function ProgressBars({ page, count, light }: { page: number; count: number; light?: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 4 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: count }, (_, n) => (
        <View
          key={n}
          style={{
            width: 18,
            height: 4,
            borderRadius: 2,
            backgroundColor: n <= page ? (light ? "#FFFFFF" : "#121316") : light ? "rgba(255,255,255,0.35)" : "rgba(18,19,22,0.15)",
          }}
        />
      ))}
    </View>
  );
}
