import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { anthropicScriptWriter, buildScriptRequest, PODCAST_SCRIPT_MODEL, type ScriptInput, scriptFromJson, scriptUserMessage, ScriptWriterError } from "../src/index.ts";

const input: ScriptInput = { format: "conversation", title: "Pricing <tests>", sourceName: "Blog & Co", author: null, text: "We raised prices 3 times.", truncated: true };

const json = {
  chapters: [
    { title: " Opening ", lines: [{ speaker: "host", text: " Welcome. " }, { speaker: "cohost", text: "  " }] },
    { title: "Why", lines: [{ speaker: "cohost", text: "Why 3 times?" }] },
  ],
};

describe("episode script", () => {
  it("escapes the piece, notes a cut text and passes on the previous attempt's problems", () => {
    const msg = scriptUserMessage({ ...input, problems: ["number_unsupported:4"] });
    expect(msg).toContain("<title>Pricing &lt;tests></title><publication>Blog &amp; Co</publication>");
    expect(msg).toContain('note="cut short; cover only what is here"');
    expect(msg).toContain("<previous_attempt_problems>number_unsupported:4</previous_attempt_problems>");
    expect(scriptUserMessage({ ...input, truncated: false })).not.toContain("previous_attempt");
  });

  it("maps the structured output, trimming and dropping empty lines", () => {
    expect(scriptFromJson("conversation", json)).toEqual({
      format: "conversation",
      chapters: [
        { title: "Opening", lines: [{ speaker: "host", text: "Welcome." }] },
        { title: "Why", lines: [{ speaker: "cohost", text: "Why 3 times?" }] },
      ],
    });
  });

  it("only allows the host in a narration", () => {
    expect(() => scriptFromJson("narration", json)).toThrow(ScriptWriterError);
  });

  it("asks for the format's schema with a cached system prompt", () => {
    const req = buildScriptRequest(input);
    expect(req.model).toBe(PODCAST_SCRIPT_MODEL);
    expect(req.system).toEqual([expect.objectContaining({ cache_control: { type: "ephemeral" } })]);
    const schema = JSON.stringify(req.output_config);
    expect(schema).toContain("cohost");
    expect(JSON.stringify(buildScriptRequest({ ...input, format: "narration" }).output_config)).not.toContain("cohost");
  });

  it("reports the API's usage", async () => {
    const client = {
      messages: {
        create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(json) }], usage: { input_tokens: 1200, output_tokens: 900 } }),
      },
    } as unknown as Anthropic;
    const out = await anthropicScriptWriter(client).write(input);
    expect(out.usage).toEqual({ inputTokens: 1200, outputTokens: 900 });
    expect(out.script.chapters).toHaveLength(2);
  });

  it("fails on a truncated answer", async () => {
    const client = { messages: { create: async () => ({ stop_reason: "max_tokens", content: [], usage: {} }) } } as unknown as Anthropic;
    await expect(anthropicScriptWriter(client).write(input)).rejects.toThrow(/max_tokens/);
  });
});
