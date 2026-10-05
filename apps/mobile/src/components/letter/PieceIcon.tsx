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
      <Ionicons name={glyph} size={Math.round(size * 0.82)} color={palette.ink} />
    </View>
  );
}
