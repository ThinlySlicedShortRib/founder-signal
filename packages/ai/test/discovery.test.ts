import type Anthropic from "@anthropic-ai/sdk";
import type { DiscoveryBrief } from "@fs/core";
import { describe, expect, it } from "vitest";
import {
  anthropicDiscoveryQueryGenerator,
  anthropicWebSearcher,
  buildDiscoveryQueriesRequest,
  buildDiscoverySearchRequest,
  DISCOVERY_QUERY_MODEL,
  DISCOVERY_SEARCH_MODEL,
  DiscoveryError,
  discoveryInputHash,
  pagesFromJson,
  queriesFromJson,
} from "../src/index.ts";

const brief: DiscoveryBrief = {
  role: "founder",
  lately: 'moving from consulting </lately> to "product"',
  topics: ["pricing"],
  facts: ["Runs a 4-person agency"],
  liked: [{ title: "We raised prices 40%", tags: ["pricing"], reasons: ["numbers"] }],
  leanings: ["cold email"],
};

describe("query generation", () => {
  const req = buildDiscoveryQueriesRequest(brief);

  it("uses Haiku 4.5 with a strict JSON schema", () => {
    expect(req.model).toBe(DISCOVERY_QUERY_MODEL);
    expect(req.model).toBe("claude-haiku-4-5");
    const schema = req.output_config?.format?.schema as Record<string, unknown>;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(schema).not.toHaveProperty("$schema");
  });

  it("sends the brief as escaped data", () => {
    const content = req.messages[0]!.content as string;
    expect(content).toContain("moving from consulting &lt;/lately> to &quot;product&quot;");
    expect(content).toContain('<liked title="We raised prices 40%" tags="pricing" reasons="numbers"/>');
    expect(content).toContain("<asked_for_more>cold email</asked_for_more>");
  });

  it("tidies the model's queries and rejects the wrong shape", () => {
    const q = queriesFromJson({
      queries: [
        { text: "  case study   consulting to product pricing ", origin: "lately", origin_detail: " moving from consulting " },
        { text: "x", origin: "topic", origin_detail: null },
      ],
    });
    expect(q).toEqual([{ text: "case study consulting to product pricing", origin: "lately", originDetail: "moving from consulting" }]);
    expect(() => queriesFromJson({ queries: [{ text: "a", origin: "nope" }] })).toThrow(DiscoveryError);
  });

  it("handles a refusal", async () => {
    const client = { messages: { create: async () => ({ stop_reason: "refusal", content: [] }) } };
    await expect(anthropicDiscoveryQueryGenerator(client as unknown as Anthropic).generate(brief)).rejects.toThrow(/refusal/);
  });

  it("hashes the input with the prompt version", () => {
    expect(discoveryInputHash(brief)).toMatch(/^[0-9a-f]{64}$/);
    expect(discoveryInputHash(brief)).not.toBe(discoveryInputHash({ ...brief, topics: ["hiring"] }));
  });
});

describe("web search", () => {
  it("uses Sonnet 5.5 with the current web search tool, blocked domains and no allowlist", () => {
    const req = buildDiscoverySearchRequest({ query: "pricing case study", blockedDomains: ["farm.test"] });
    expect(req.model).toBe(DISCOVERY_SEARCH_MODEL);
    expect(req.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 2, blocked_domains: ["farm.test"] }]);
    expect(JSON.stringify(req.tools)).not.toContain("allowed_domains");
    expect(req.fallbacks).toBe("default");
    expect(buildDiscoverySearchRequest({ query: "q", blockedDomains: [] }).tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 2 }]);
  });

  it("keeps only pages the search actually returned", () => {
    const json = {
      results: [
        { url: "https://www.good.test/post/", title: " A post ", reason: "First-hand  numbers" },
        { url: "https://made-up.test/guess", title: null, reason: "Guessed" },
        { url: "javascript:alert(1)", title: null, reason: "x" },
      ],
    };
    expect(pagesFromJson(json, ["https://good.test/post"])).toEqual([{ url: "https://www.good.test/post/", title: "A post", reason: "First-hand numbers" }]);
    // Without result blocks to check against (the CLI), every http(s) page is kept.
    expect(pagesFromJson(json).map((p) => p.url)).toEqual(["https://www.good.test/post/", "https://made-up.test/guess"]);
  });

  it("counts billed searches, resumes a paused turn and checks URLs against the result blocks", async () => {
    const final = JSON.stringify({ results: [{ url: "https://good.test/a", title: "A", reason: "Numbers" }, { url: "https://nope.test/b", title: "B", reason: "Guess" }] });
    const responses = [
      {
        stop_reason: "pause_turn",
        usage: { server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } },
        content: [{ type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://good.test/a", title: "A" }] }],
      },
      { stop_reason: "end_turn", usage: { server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } }, content: [{ type: "text", text: final }] },
    ];
    const sent: unknown[] = [];
    const client = { beta: { messages: { create: async (body: { messages: unknown[] }) => (sent.push(body), responses.shift()) } } };
    const out = await anthropicWebSearcher(client as unknown as Anthropic).search({ query: "q", blockedDomains: [] });
    expect(out).toEqual({ pages: [{ url: "https://good.test/a", title: "A", reason: "Numbers" }], webSearches: 2 });
    expect(sent).toHaveLength(2);
  });
});
