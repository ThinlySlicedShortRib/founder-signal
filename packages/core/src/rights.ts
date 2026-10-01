import type { Rights, RightsDisplay, UnavailableReason } from "@fs/schema";

/**
 * Personal-use mode (build plan §6.3, §12): every source defaults to full
 * text, retained and available offline. Rules can only tighten this.
 */
export const PERSONAL_USE_DEFAULT: Rights = Object.freeze({
  display: "full_text",
  retainText: true,
  offlineAllowed: true,
  licenseNote: null,
});

export interface RightsRuleInput extends Rights {
  scope: "domain" | "source";
  scopeKey: string;
}

/** Picks the most specific rule: source beats domain beats the default. */
export function resolveRights(
  rules: readonly RightsRuleInput[],
  target: { publisherKey: string; sourceKey?: string | null },
): Rights {
  const bySource = target.sourceKey
    ? rules.find((r) => r.scope === "source" && r.scopeKey === target.sourceKey)
    : undefined;
  const byDomain = rules.find((r) => r.scope === "domain" && r.scopeKey === target.publisherKey);
  const rule = bySource ?? byDomain;
  if (!rule) return { ...PERSONAL_USE_DEFAULT };
  return {
    display: rule.display,
    // Without retained text there's nothing to read offline.
    retainText: rule.retainText,
    offlineAllowed: rule.retainText && rule.offlineAllowed,
    licenseNote: rule.licenseNote ?? null,
  };
}

/** What the app may do with one item, given its rights and what extraction produced. */
export interface ItemAccess {
  display: RightsDisplay;
  /** Write the block JSON to storage. */
  storeBlocks: boolean;
  offlineAllowed: boolean;
  /** The Reader must label the view "Digest — not the original text". */
  digest: boolean;
  unavailableReason: UnavailableReason | null;
}

export function decideItemAccess(rights: Rights, extraction: { unavailableReason: UnavailableReason | null }): ItemAccess {
  if (extraction.unavailableReason) {
    // Metadata only: title, credit and a link. Never generate from a title alone.
    return {
      display: "link_only",
      storeBlocks: false,
      offlineAllowed: false,
      digest: false,
      unavailableReason: extraction.unavailableReason,
    };
  }
  return {
    display: rights.display,
    storeBlocks: rights.retainText && rights.display !== "link_only",
    offlineAllowed: rights.retainText && rights.offlineAllowed && rights.display !== "link_only",
    digest: rights.display === "excerpt_only",
    unavailableReason: null,
  };
}
