import { pieceIconKeys } from "@fs/schema";
import { describe, expect, it } from "vitest";
import { fallbackPieceIcon, iconForText, resolvePieceIcon } from "./piece-icons.ts";

describe("fallbackPieceIcon", () => {
  it("goes by the first tag that matches, before the topic and title", () => {
    expect(fallbackPieceIcon({ kind: "article", tags: ["usage-based pricing", "saas"], topic: "hiring", title: "Our first sales hire" })).toBe("pricing");
    expect(fallbackPieceIcon({ kind: "article", tags: ["misc", "first sales hire"], topic: null, title: null })).toBe("hiring");
  });

  it("uses the topic, then the title, when no tag matches", () => {
    expect(fallbackPieceIcon({ kind: "article", tags: ["misc"], topic: "Fundraising", title: "Pricing your seed round" })).toBe("fundraising");
    expect(fallbackPieceIcon({ kind: "article", tags: [], topic: "", title: "How we cut churn in half" })).toBe("retention");
  });

  it("falls back to the kind", () => {
    expect(fallbackPieceIcon({ kind: "article", tags: null, topic: "Assorted", title: "Notes from a week" })).toBe("article");
    expect(fallbackPieceIcon({ kind: "video", topic: "Assorted", title: "Notes from a week" })).toBe("video");
  });

  it("matches whole words, plurals and stems, not fragments", () => {
    expect(iconForText("Cold email that works")).toBe("email");
    expect(iconForText("Hiring engineers")).toBe("hiring");
    expect(iconForText("AI agents for support")).toBe("ai");
    // "ai" inside "maintain" or "aim" isn't AI.
    expect(iconForText("Aim to maintain momentum")).toBeNull();
    expect(iconForText("Productivity for founders")).toBe("productivity");
    expect(iconForText("Productized services")).toBe("services");
    expect(iconForText("Launching on Product Hunt")).toBe("launch");
    expect(iconForText("Burnout is real")).toBe("health");
    expect(iconForText("")).toBeNull();
  });

  it("only returns keys from the allowlist", () => {
    const titles = ["Pricing", "VC", "Cap tables", "Remote teams", "Open source", "No-code tools", "Our postmortem", "SEO", "M&A"];
    for (const t of titles) expect(pieceIconKeys).toContain(iconForText(t));
  });
});

describe("resolvePieceIcon", () => {
  it("keeps a stored icon that's on the allowlist, else falls back", () => {
    expect(resolvePieceIcon("design", { kind: "article", title: "Pricing" })).toBe("design");
    expect(resolvePieceIcon("rocket-outline", { kind: "article", title: "Pricing" })).toBe("pricing");
    expect(resolvePieceIcon(undefined, { kind: "video", title: "Untitled" })).toBe("video");
  });
});
