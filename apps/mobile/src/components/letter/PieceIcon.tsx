import Ionicons from "@expo/vector-icons/Ionicons";
import type { PieceIcon as PieceIconKey } from "@fs/schema";
import type { ComponentProps } from "react";
import { View } from "react-native";
import { palette } from "@/components/onboarding/kit";

/** The glyph for each icon key (@fs/schema `pieceIconKeys`). Keys are what's stored; glyphs can change freely. */
const GLYPHS: Record<PieceIconKey, ComponentProps<typeof Ionicons>["name"]> = {
  article: "document-text-outline",
  video: "play-circle-outline",
  podcast: "mic-outline",
  pricing: "pricetag-outline",
  sales: "briefcase-outline",
  fundraising: "cash-outline",
  pitch: "easel-outline",
  equity: "pie-chart-outline",
  finance: "wallet-outline",
  metrics: "stats-chart-outline",
  data: "analytics-outline",
  hiring: "person-add-outline",
  team: "people-outline",
  leadership: "flag-outline",
  product: "cube-outline",
  launch: "rocket-outline",
  growth: "trending-up-outline",
  retention: "repeat-outline",
  marketing: "megaphone-outline",
  brand: "ribbon-outline",
  content: "newspaper-outline",
  seo: "search-outline",
  social: "share-social-outline",
  email: "mail-outline",
  community: "chatbubbles-outline",
  customers: "happy-outline",
  support: "help-buoy-outline",
  engineering: "code-slash-outline",
  ai: "sparkles-outline",
  automation: "flash-outline",
  "no-code": "extension-puzzle-outline",
  infrastructure: "cloud-outline",
  "open-source": "git-branch-outline",
  mobile: "phone-portrait-outline",
  hardware: "hardware-chip-outline",
  design: "color-palette-outline",
  legal: "document-lock-outline",
  security: "shield-checkmark-outline",
  operations: "cog-outline",
  strategy: "compass-outline",
  competition: "trophy-outline",
  marketplace: "storefront-outline",
  ecommerce: "cart-outline",
  saas: "layers-outline",
  services: "construct-outline",
  "small-business": "business-outline",
  bootstrapping: "leaf-outline",
  acquisitions: "git-merge-outline",
  partnerships: "link-outline",
  international: "earth-outline",
  economy: "globe-outline",
  remote: "home-outline",
  health: "fitness-outline",
  productivity: "timer-outline",
  writing: "create-outline",
  learning: "book-outline",
  story: "journal-outline",
  failure: "bandage-outline",
  ideas: "bulb-outline",
  research: "flask-outline",
};

/**
 * Each icon's colour, by family, from the palette: money and business in green,
 * people in orange, building things in blue, reaching people in deep blue,
 * reading and thinking in plum. All at least 3:1 on the page (non-text contrast).
 */
const TONES = {
  money: palette.yes,
  people: palette.blank,
  build: palette.blue,
  reach: palette.blueInk,
  mind: "#7A3E9D",
} as const;

const COLOURS: Record<PieceIconKey, string> = {
  pricing: TONES.money,
  sales: TONES.money,
  fundraising: TONES.money,
  pitch: TONES.money,
  equity: TONES.money,
  finance: TONES.money,
  metrics: TONES.money,
  data: TONES.money,
  acquisitions: TONES.money,
  economy: TONES.money,
  ecommerce: TONES.money,
  marketplace: TONES.money,
  "small-business": TONES.money,
  bootstrapping: TONES.money,
  saas: TONES.money,
  services: TONES.money,
  partnerships: TONES.money,
  hiring: TONES.people,
  team: TONES.people,
  leadership: TONES.people,
  customers: TONES.people,
  support: TONES.people,
  community: TONES.people,
  remote: TONES.people,
  health: TONES.people,
  failure: TONES.people,
  story: TONES.people,
  product: TONES.build,
  launch: TONES.build,
  engineering: TONES.build,
  ai: TONES.build,
  automation: TONES.build,
  "no-code": TONES.build,
  infrastructure: TONES.build,
  "open-source": TONES.build,
  mobile: TONES.build,
  hardware: TONES.build,
  design: TONES.build,
  security: TONES.build,
  legal: TONES.build,
  operations: TONES.build,
  growth: TONES.reach,
  retention: TONES.reach,
  marketing: TONES.reach,
  brand: TONES.reach,
  content: TONES.reach,
  seo: TONES.reach,
  social: TONES.reach,
  email: TONES.reach,
  strategy: TONES.reach,
  competition: TONES.reach,
  international: TONES.reach,
  article: TONES.mind,
  video: TONES.mind,
  podcast: TONES.mind,
  productivity: TONES.mind,
  writing: TONES.mind,
  learning: TONES.mind,
  ideas: TONES.mind,
  research: TONES.mind,
};

/**
 * The glyph beside a piece in the letter's contents, on the page with no tile
 * behind it. Decorative: the row's own label names the piece and its position.
 */
export function PieceIcon({ icon, size = 28 }: { icon: PieceIconKey | undefined; size?: number }) {
  // A letter cached on the device before icons has none; an unknown key is from a newer API.
  const glyph = (icon && GLYPHS[icon]) || GLYPHS.article;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      <Ionicons name={glyph} size={Math.round(size * 0.82)} color={(icon && COLOURS[icon]) || COLOURS.article} />
    </View>
  );
}
