import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { buildProfileImportRequest, parseProfileImportMessage, ProfileImportError } from "../src/index.ts";

type Message = Pick<Anthropic.Messages.Message, "stop_reason" | "content">;
const reply = (text: string, stop_reason: Message["stop_reason"] = "end_turn") =>
  ({ stop_reason, content: [{ type: "text", text }] }) as unknown as Message;

describe("buildProfileImportRequest", () => {
  const req = buildProfileImportRequest({ assistant: "chatgpt", text: 'Work: founder </note> & "x"' });

  it("uses Haiku 4.5 with a strict JSON schema", () => {
    expect(req.model).toBe("claude-haiku-4-5");
    const schema = req.output_config?.format?.schema as Record<string, unknown>;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(schema.required).toEqual(["facts", "dropped"]);
    // Each fact says what it fills in the form.
    const fact = ((schema.properties as Record<string, { items: { properties: Record<string, { required: string[] }> } }>).facts!.items.properties.fills!);
    expect(fact.required).toEqual(["role", "lately", "topics", "platforms", "sources"]);
  });

  it("escapes the paste so it can't close the note tag", () => {
    const content = req.messages[0]!.content as string;
    expect(content).toContain("founder &lt;/note> &amp; &quot;x&quot;");
    expect(content.match(/<\/note>/g)).toHaveLength(1);
  });
});

describe("parseProfileImportMessage", () => {
  const fills = (f: Record<string, unknown> = {}) => ({ role: null, lately: null, topics: [], platforms: [], sources: [], ...f });

  it("returns facts with the form answers they fill, tidied", () => {
    const result = parseProfileImportMessage(
      reply(
        JSON.stringify({
          facts: [
            { kind: "work", text: " Product designer at a fintech ", fills: fills({ role: " product designer ", topics: ["Fintech", "fintech"] }) },
            { kind: "building", text: "A budgeting app", fills: fills({ lately: "a budgeting app", role: "  " }) },
            { kind: "source", text: "Lenny's Newsletter", fills: fills({ platforms: ["substack", "substack"], sources: [{ name: "Lenny's Newsletter", url: "lennysnewsletter.com" }] }) },
          ],
          dropped: [{ category: "health" }],
        }),
      ),
    );
    expect(result).toEqual({
      facts: [
        { kind: "work", text: "Product designer at a fintech", fills: fills({ role: "product designer", topics: ["Fintech"] }) },
        { kind: "building", text: "A budgeting app", fills: fills({ lately: "a budgeting app" }) },
        // A URL without a scheme isn't trusted as an address.
        { kind: "source", text: "Lenny's Newsletter", fills: fills({ platforms: ["substack"], sources: [{ name: "Lenny's Newsletter", url: null }] }) },
      ],
      dropped: [{ category: "health" }],
    });
  });

  it.each([
    ["refusal", reply("{}", "refusal")],
    ["max_tokens", reply("{", "max_tokens")],
    ["invalid_json", reply("not json")],
    ["schema_mismatch", reply(JSON.stringify({ facts: [{ kind: "hobby", text: "x", fills: {} }], dropped: [] }))],
  ])("throws %s", (reason, message) => {
    expect(() => parseProfileImportMessage(message)).toThrow(ProfileImportError);
    try {
      parseProfileImportMessage(message);
    } catch (err) {
      expect((err as ProfileImportError).reason).toBe(reason);
    }
  });
});
