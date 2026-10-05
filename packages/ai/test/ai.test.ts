import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { pieceIconKeys } from "@fs/schema";
import { buildEnrichmentRequest, embeddingText, parseBatchResult } from "../src/index.ts";

type BatchResponse = Anthropic.Messages.Batches.MessageBatchIndividualResponse;

const succeeded = (text: string, stop_reason: string = "end_turn"): BatchResponse =>
  ({
    custom_id: "item-1",
    result: { type: "succeeded", message: { stop_reason, content: [{ type: "text", text }] } },
  }) as unknown as BatchResponse;

const valid = { tags: ["Pricing", "pricing", " Productized Services ", "consulting", "sales"], language: "EN", depth: "intermediate", quality: "substantive", quality_reason: "First-hand numbers.", icon: "pricing" };

describe("buildEnrichmentRequest", () => {
  const req = buildEnrichmentRequest({ itemId: "i", title: "A <b> title", publisher: 'Pub "x"', type: "article", text: "body & more" });

  it("uses Haiku 4.5 with a strict JSON schema", () => {
    expect(req.model).toBe("claude-haiku-4-5");
    const schema = req.output_config?.format?.schema as Record<string, unknown>;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(schema.required).toEqual(["tags", "language", "depth", "quality", "quality_reason", "icon"]);
    expect(schema).not.toHaveProperty("$schema");
  });

  it("constrains the icon to the allowlist and explains each key", () => {
    const schema = req.output_config?.format?.schema as { properties: { icon: { enum: string[] } } };
    expect(schema.properties.icon.enum).toEqual([...pieceIconKeys]);
    expect(req.system).toContain("- pricing: pricing, packaging, plans and discounts");
  });

  it("escapes the item so its text can't break out of the data tags", () => {
    const content = req.messages[0]!.content as string;
    expect(content).toContain("A &lt;b> title");
    expect(content).toContain('publisher="Pub &quot;x&quot;"');
    expect(content).toContain("body &amp; more");
  });

  it("truncates very long text", () => {
    const long = buildEnrichmentRequest({ itemId: "i", title: null, publisher: "p", type: "video", text: "x".repeat(50_000) });
    expect((long.messages[0]!.content as string).length).toBeLessThan(25_000);
  });
});

describe("parseBatchResult", () => {
  it("normalizes a good result", () => {
    expect(parseBatchResult(succeeded(JSON.stringify(valid)))).toEqual({
      itemId: "item-1",
      ok: true,
      enrichment: { ...valid, tags: ["pricing", "productized services", "consulting", "sales"], language: "en" },
    });
  });

  it("keeps a valid icon (any case) and turns one off the allowlist into null", () => {
    const icon = (value: unknown) => {
      const r = parseBatchResult(succeeded(JSON.stringify({ ...valid, icon: value })));
      return r.ok ? r.enrichment.icon : "failed";
    };
    expect(icon(" Hiring ")).toBe("hiring");
    expect(icon("rocket-outline")).toBeNull();
    expect(icon(42)).toBeNull();
    expect(icon(undefined)).toBeNull();
  });

  it("classifies failures as retryable or not", () => {
    expect(parseBatchResult(succeeded("", "refusal"))).toMatchObject({ ok: false, retryable: false, error: "refusal" });
    expect(parseBatchResult(succeeded("{", "max_tokens"))).toMatchObject({ ok: false, retryable: true });
    expect(parseBatchResult(succeeded("not json"))).toMatchObject({ ok: false, retryable: true, error: "invalid_json" });
    expect(parseBatchResult(succeeded(JSON.stringify({ tags: [] })))).toMatchObject({ ok: false, error: "schema_mismatch" });
    const errored = (type: string) =>
      ({ custom_id: "item-1", result: { type: "errored", error: { type: "error", error: { type, message: "" }, request_id: null } } }) as unknown as BatchResponse;
    expect(parseBatchResult(errored("invalid_request_error"))).toMatchObject({ retryable: false });
    expect(parseBatchResult(errored("overloaded_error"))).toMatchObject({ retryable: true });
    expect(parseBatchResult({ custom_id: "item-1", result: { type: "expired" } } as BatchResponse)).toMatchObject({ retryable: true });
  });
});

describe("embeddingText", () => {
  it("leads with title and topics", () => {
    expect(embeddingText({ title: "T", tags: ["a", "b"], text: "body" })).toBe("T\n\nTopics: a, b\n\nbody");
    expect(embeddingText({ title: null, tags: [], text: "body" })).toBe("body");
  });
});
