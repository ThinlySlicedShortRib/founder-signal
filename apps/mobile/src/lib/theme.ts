import { Platform, useColorScheme } from "react-native";

const light = {
  background: "#FAF8F4",
  surface: "#FFFFFF",
  surfaceMuted: "#F2EFE8",
  border: "#E4DFD5",
  text: "#1D1B18",
  textMuted: "#6B655B",
  accent: "#2F5D50",
  accentText: "#FFFFFF",
  accentSoft: "#E3EDE9",
  danger: "#A3362B",
  dangerSoft: "#F6E3E0",
  warning: "#8A5A00",
  warningSoft: "#F7EDD6",
};

const dark: typeof light = {
  background: "#151412",
  surface: "#1E1C19",
  surfaceMuted: "#26241F",
  border: "#34312B",
  text: "#EDEAE4",
  textMuted: "#A39D92",
  accent: "#8CC2AE",
  accentText: "#10201B",
  accentSoft: "#22332D",
  danger: "#F09A8E",
  dangerSoft: "#3A2320",
  warning: "#E6BE6A",
  warningSoft: "#3A2F17",
};

export type Colors = typeof light;

/** A serif for headings: letters, not dashboards. */
export const serif = Platform.select({ ios: "Georgia", android: "serif", default: "Georgia, 'Times New Roman', serif" });

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16 } as const;
/** Minimum tap target (build plan §8). */
export const TAP = 44;

export function useColors(): Colors {
  return useColorScheme() === "dark" ? dark : light;
}
