import MaskedView from "@react-native-masked-view/masked-view";
import type { PieceImage } from "@fs/schema";
import { BlurView } from "expo-blur";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Platform, StyleSheet, Text, View, type DimensionValue, type ViewStyle } from "react-native";
import { font, palette } from "@/components/onboarding/kit";

/**
 * The picture behind a piece page, the P.S. and the reader's header:
 * the photo (or a tinted fallback), a progressive blur, and the board's dark
 * gradient on top (.photo .blurz .grad).
 *
 * The blur is a BlurView masked by a gradient, like the board's `mask-image`.
 * On the P.S. and the reader's header it rises from the bottom `blurHeight`
 * (transparent → opaque at 30%); on a piece page it spans the whole photo,
 * faint at the top and full strength behind the text. On iOS that's
 * MaskedView; on web the mask is CSS. Android's BlurView only blurs with an experimental method that needs a
 * BlurTargetView around the content and is slow in Expo Go, so there the
 * blur is left out and the gradient is darker instead.
 */

const BLUR_ON = Platform.OS !== "android";

const GRADIENTS = {
  /** A piece page: darker than the board's .grad all the way down, since the blur now reaches the top. */
  piece: { colors: ["rgba(18,19,22,0.44)", "rgba(18,19,22,0.54)", "rgba(18,19,22,0.86)", "rgba(18,19,22,0.97)"], locations: [0, 0.28, 0.58, 1] },
  /** Android: no blur, so darker still. */
  pieceStrong: { colors: ["rgba(18,19,22,0.5)", "rgba(18,19,22,0.64)", "rgba(18,19,22,0.92)", "rgba(18,19,22,0.99)"], locations: [0, 0.28, 0.55, 1] },
  /** .grad on the P.S. */
  page: { colors: ["rgba(18,19,22,0.28)", "rgba(18,19,22,0.38)", "rgba(18,19,22,0.78)", "rgba(18,19,22,0.96)"], locations: [0, 0.28, 0.58, 1] },
  /** Android: no blur, so the text area is darker. */
  pageStrong: { colors: ["rgba(18,19,22,0.32)", "rgba(18,19,22,0.5)", "rgba(18,19,22,0.88)", "rgba(18,19,22,0.98)"], locations: [0, 0.28, 0.55, 1] },
  /** .rhead .grad: darker still, since the title sits on most of it. */
  head: { colors: ["rgba(18,19,22,0.45)", "rgba(18,19,22,0.62)", "rgba(18,19,22,0.92)"], locations: [0, 0.45, 1] },
  headStrong: { colors: ["rgba(18,19,22,0.55)", "rgba(18,19,22,0.72)", "rgba(18,19,22,0.95)"], locations: [0, 0.45, 1] },
} as const;

const STRONG = { piece: "pieceStrong", page: "pageStrong", head: "headStrong" } as const;

/** Blur masks: black is full blur, transparent none. */
const MASKS = {
  /** Rising from the bottom of its box (transparent → opaque at 30%). */
  rise: { colors: ["transparent", "#000", "#000"], locations: [0, 0.3, 1], intensity: 55 },
  /** A piece page: the whole photo, already well blurred at the top and at full strength from just past the middle. */
  full: { colors: ["rgba(0,0,0,0.45)", "rgba(0,0,0,0.85)", "#000", "#000"], locations: [0, 0.3, 0.55, 1], intensity: 90 },
} as const;
type Mask = (typeof MASKS)[keyof typeof MASKS];

/** Deep tints for pieces without a picture, picked per topic so the same topic always looks the same. */
const FALLBACK_TINTS = [
  ["#2B4BFF", "#1E2F99"],
  ["#E8461A", "#8A3B12"],
  ["#3A3D44", "#121316"],
  ["#4A5578", "#1E2F99"],
  ["#1F7A4D", "#173B2E"],
] as const;

export function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function PhotoBackdrop({
  image,
  topic,
  variant = "page",
  blurHeight = "64%",
  dim,
}: {
  image: Pick<PieceImage, "url"> | null;
  topic: string;
  variant?: "piece" | "page" | "head";
  /** How far up the blur rises; a piece page's blur always spans the whole photo. */
  blurHeight?: DimensionValue;
  /** The video player's still: shown at 55% over ink. */
  dim?: boolean;
}) {
  const g = GRADIENTS[BLUR_ON ? variant : STRONG[variant]];
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: "#25272B", pointerEvents: "none" }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {image ? (
        <Image source={{ uri: image.url }} style={[StyleSheet.absoluteFill, dim && { opacity: 0.55 }]} contentFit="cover" transition={200} />
      ) : (
        <TopicFallback topic={topic} />
      )}
      {BLUR_ON && (variant === "piece" ? <ProgressiveBlur height="100%" mask={MASKS.full} /> : <ProgressiveBlur height={blurHeight} mask={MASKS.rise} />)}
      <LinearGradient colors={g.colors as unknown as [string, string, ...string[]]} locations={g.locations as unknown as [number, number, ...number[]]} style={StyleSheet.absoluteFill} />
    </View>
  );
}

function TopicFallback({ topic }: { topic: string }) {
  const [a, b] = FALLBACK_TINTS[hashOf(topic.toLowerCase()) % FALLBACK_TINTS.length]!;
  return (
    <LinearGradient colors={[a, b]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill}>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={{ position: "absolute", top: "18%", left: 16, right: 16, fontFamily: font.display, fontSize: 120, lineHeight: 124, letterSpacing: -6, color: "rgba(255,255,255,0.12)" }}
      >
        {topic}
      </Text>
    </LinearGradient>
  );
}

function ProgressiveBlur({ height, mask }: { height: DimensionValue; mask: Mask }) {
  const box: ViewStyle = { position: "absolute", left: 0, right: 0, bottom: 0, height };
  if (Platform.OS === "web") {
    // BlurView on web is a backdrop-filter; the CSS mask fades it in from the top like the board.
    const css = `linear-gradient(180deg, ${mask.colors.map((c, i) => `${c} ${mask.locations[i]! * 100}%`).join(", ")})`;
    const webMask = { maskImage: css, WebkitMaskImage: css } as unknown as ViewStyle;
    return <BlurView intensity={100} tint="systemUltraThinMaterialDark" style={[box, webMask]} />;
  }
  return (
    <MaskedView
      style={box}
      maskElement={
        <LinearGradient
          colors={mask.colors as unknown as [string, string, ...string[]]}
          locations={mask.locations as unknown as [number, number, ...number[]]}
          style={StyleSheet.absoluteFill}
        />
      }
    >
      <BlurView intensity={mask.intensity} tint="systemUltraThinMaterialDark" style={StyleSheet.absoluteFill} />
    </MaskedView>
  );
}

/** The boards' three tints (.t0 .t1 .t2), for avatars, end cards and tiles. */
export const TINTS = [palette.blueCard, palette.tints[1], palette.tints[2]] as const;

/** .av2: initials in a tint, stable per author. */
export function Avatar({ initials, keyStr, size = 34 }: { initials: string; keyStr: string; size?: number }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: TINTS[hashOf(keyStr) % 3], alignItems: "center", justifyContent: "center" }}
    >
      <Text style={{ fontFamily: font.display, fontSize: size * 0.4, letterSpacing: -0.01 * size, color: "#121316" }}>{initials}</Text>
    </View>
  );
}
