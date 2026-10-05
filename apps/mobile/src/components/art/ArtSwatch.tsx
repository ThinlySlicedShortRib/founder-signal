import { useMemo } from "react";
import { View } from "react-native";
import { SvgXml } from "react-native-svg";
import { font, palette } from "@/components/onboarding/kit";
import { toSvg } from "./scene";
import { drawArt, type StyleId } from "./styles";

/** A phone-sized band of art, drawn at full size and scaled down: Dev tools' preview of a style and seed. */
export function ArtSwatch({ style, seed, width }: { style: StyleId; seed: string; width: number }) {
  const xml = useMemo(
    () => toSvg(drawArt(style, { width: 390, height: 520, seed, date: "2026-10-05", number: 12 }), { display: font.display, mono: font.mono }),
    [style, seed],
  );
  const height = Math.round((width * 520) / 390);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width, height, borderRadius: 10, overflow: "hidden", borderWidth: 1, borderColor: palette.cardRule }}>
      <SvgXml xml={xml} width={width} height={height} />
    </View>
  );
}
