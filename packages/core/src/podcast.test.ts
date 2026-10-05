import { describe, expect, it } from "vitest";
import {
  apiModelOf,
  checkEpisodeScript,
  type ClipInfo,
  EPISODE_LIMITS,
  type EpisodeScript,
  episodeParagraphs,
  episodeSourceText,
  episodeVoiceKey,
  estimateEpisodeCost,
  estimateSpeechSeconds,
  GAPS,
  readingScript,
  scriptWords,
  speakable,
  splitForSpeech,
  stitchPlan,
} from "./podcast.ts";

const SOURCE = {
  title: "10 years of pricing experiments",
  text: "We raised prices 3 times. Churn fell to 2.5% after the change. Our first plan cost $49 a month. As one customer put it, \"cheap tools feel risky\".",
};

/** About `words` words of plain talk, with no numbers in it. */
const filler = (words: number) => Array.from({ length: words }, () => "pricing").join(" ") + ".";

/** The given lines, padded with enough plain talk to pass the length check. */
function script(lines: { speaker: "host" | "cohost"; text: string }[], format: EpisodeScript["format"] = "conversation"): EpisodeScript {
  const padding = Array.from({ length: EPISODE_LIMITS.minWords / 50 }, () => ({ speaker: "host" as const, text: filler(50) }));
  return { format, chapters: [{ title: "Intro", lines: [...lines, ...padding] }] };
}

describe("episode source text", () => {
  it("reads headings, paragraphs, quotes and list items, and skips images, captions and tables", () => {
    const paras = episodeParagraphs([
      { type: "heading", level: 2, text: "Why" },
      { type: "paragraph", text: "  First   point. " },
      { type: "image", src: "https://example.com/a.png", caption: "A chart" },
      { type: "caption", text: "Figure 1" },
      { type: "list", ordered: false, items: ["one", " ", "two"] },
      { type: "table", rows: [["a", "b"]] },
      { type: "quote", text: "Said it." },
    ]);
    expect(paras).toEqual(["Why", "First point.", "one", "two", "Said it."]);
  });

  it("cuts at a paragraph when the piece is long", () => {
    const out = episodeSourceText(["a".repeat(30), "b".repeat(30), "c".repeat(30)], 70);
    expect(out).toEqual({ text: `${"a".repeat(30)}\n\n${"b".repeat(30)}`, truncated: true });
    expect(episodeSourceText(["short"]).truncated).toBe(false);
  });
});

describe("checkEpisodeScript", () => {
  it("passes a grounded two-host script", () => {
    const s = script([
      { speaker: "host", text: "They raised prices 3 times, and churn fell to 2.5%." },
      { speaker: "cohost", text: "And the first plan was $49 a month? A customer said \"cheap tools feel risky\"." },
    ]);
    expect(checkEpisodeScript(s, SOURCE)).toEqual([]);
  });

  it("rejects numbers and quotes that aren't in the piece", () => {
    const s = script([
      { speaker: "host", text: "Churn fell to 4% after 12 months." },
      { speaker: "cohost", text: "As they say, \"pricing is a feature\"." },
    ]);
    expect(checkEpisodeScript(s, SOURCE)).toEqual(expect.arrayContaining(["number_unsupported:4", "number_unsupported:12", "quote_unsupported"]));
  });

  it("takes numbers from the title", () => {
    const s = script([
      { speaker: "host", text: "Over 10 years, they tried a lot." },
      { speaker: "cohost", text: "Go on." },
    ]);
    expect(checkEpisodeScript(s, SOURCE)).toEqual([]);
  });

  it("makes numbers above ten checkable by asking for digits", () => {
    const s = script([
      { speaker: "host", text: "Twenty customers left." },
      { speaker: "cohost", text: "Really?" },
    ]);
    expect(checkEpisodeScript(s, SOURCE)).toContain("spelled_number");
  });

  it("rejects links, labels and stage directions in the spoken text", () => {
    const s = script([
      { speaker: "host", text: "Host: welcome. See www.example.com" },
      { speaker: "cohost", text: "[laughs] Fair." },
    ]);
    expect(checkEpisodeScript(s, SOURCE)).toEqual(expect.arrayContaining(["contains_link", "not_speech"]));
  });

  it("wants both hosts in a conversation and one voice otherwise", () => {
    expect(checkEpisodeScript(script([{ speaker: "host", text: "Hi." }]), SOURCE)).toContain("one_speaker");
    expect(checkEpisodeScript(script([{ speaker: "cohost", text: "Hi." }], "narration"), SOURCE)).toContain("unexpected_cohost");
  });

  it("bounds the length", () => {
    const short: EpisodeScript = { format: "narration", chapters: [{ title: "Intro", lines: [{ speaker: "host", text: "Too short." }] }] };
    expect(checkEpisodeScript(short, SOURCE)).toContain("too_short:2");
    const long: EpisodeScript = { format: "narration", chapters: [{ title: "Intro", lines: Array.from({ length: 4 }, () => ({ speaker: "host" as const, text: filler(400) })) }] };
    expect(checkEpisodeScript(long, SOURCE)).toEqual(expect.arrayContaining(["too_long:1600", "line_too_long"]));
    expect(checkEpisodeScript({ format: "narration", chapters: [] }, SOURCE)).toContain("empty_chapter");
  });
});

describe("readingScript", () => {
  it("reads the opening verbatim and says where it stopped", () => {
    const s = readingScript({ title: "T", sourceName: "Blog", author: "Ann" }, ["one two three", "four five", "six seven eight nine"], 6);
    expect(s.format).toBe("reading");
    expect(s.chapters[0]!.lines.map((l) => l.text)).toEqual(["T by Ann, from Blog.", "one two three", "four five", "That's the opening. The rest of the piece is in the app."]);
    expect(new Set(s.chapters[0]!.lines.map((l) => l.speaker))).toEqual(new Set(["host"]));
  });

  it("always passes the grounding checks", () => {
    const s = readingScript({ title: SOURCE.title, sourceName: "Blog", author: null }, [SOURCE.text]);
    expect(checkEpisodeScript(s, SOURCE).filter((r) => !r.startsWith("too_short"))).toEqual([]);
  });
});

describe("speakable", () => {
  it("says money, percentages and multiples the way people do", () => {
    expect(speakable("From $500 to $20,000 a month, $1.5M ARR, 40% churn and 2.5x growth.")).toBe(
      "From 500 dollars to 20,000 dollars a month, 1.5 million dollars ARR, 40 percent churn and 2.5 times growth.",
    );
    expect(speakable("A $20k deal vs. a $3bn market")).toBe("A 20 thousand dollars deal versus a 3 billion dollars market");
  });

  it("drops what isn't speech and expands abbreviations", () => {
    expect(speakable("**Pricing** — e.g. tiers [laughs] (see https://x.com/a) & more etc.")).toBe("Pricing, for example tiers (see) and more and so on");
    expect(speakable("“Curly” ‘quotes’ ~3 days")).toBe("\"Curly\" 'quotes' about 3 days");
  });
});

describe("splitForSpeech", () => {
  it("keeps sentences whole and joins short ones up to the limit", () => {
    expect(splitForSpeech("One. Two! Three?", 10)).toEqual(["One. Two!", "Three?"]);
    expect(splitForSpeech("One. Two! Three?")).toEqual(["One. Two! Three?"]);
    expect(splitForSpeech("No end punctuation")).toEqual(["No end punctuation"]);
  });

  it("splits a long sentence at clauses, then words", () => {
    const chunks = splitForSpeech("alpha beta gamma, delta epsilon; zeta eta theta iota kappa lambda mu.", 20);
    expect(chunks.every((c) => c.length <= 20)).toBe(true);
    expect(chunks.join(" ")).toBe("alpha beta gamma, delta epsilon; zeta eta theta iota kappa lambda mu.");
  });
});

describe("stitchPlan", () => {
  const rate = 100;
  const clips: ClipInfo[] = [
    { chapter: 0, line: 0, speaker: "host", samples: 100 },
    { chapter: 0, line: 0, speaker: "host", samples: 50 },
    { chapter: 0, line: 1, speaker: "cohost", samples: 100 },
    { chapter: 0, line: 2, speaker: "cohost", samples: 100 },
    { chapter: 1, line: 0, speaker: "host", samples: 100 },
  ];

  it("lays clips out with pauses for chunks, turns, paragraphs and chapters", () => {
    const plan = stitchPlan(clips, ["Intro", "Why it works"], rate);
    const lead = GAPS.lead * rate;
    const o1 = lead + 100 + GAPS.sameLine * rate;
    const o2 = o1 + 50 + GAPS.turn * rate;
    const o3 = o2 + 100 + GAPS.sameSpeaker * rate;
    const o4 = o3 + 100 + GAPS.chapter * rate;
    expect(plan.offsets).toEqual([lead, o1, o2, o3, o4].map(Math.round));
    expect(plan.totalSamples).toBe(Math.round(o4 + 100 + GAPS.tail * rate));
    expect(plan.chapters).toEqual([
      { title: "Intro", startSeconds: 0 },
      { title: "Why it works", startSeconds: o4 / rate },
    ]);
  });

  it("handles no clips", () => {
    expect(stitchPlan([], [], rate)).toEqual({ offsets: [], totalSamples: Math.round(GAPS.lead * rate), chapters: [] });
  });
});

describe("estimates", () => {
  it("prices the script by tokens and the voice by characters", () => {
    const cost = estimateEpisodeCost({ model: "claude-sonnet-5-5", inputTokens: 5_500, outputTokens: 2_500, ttsPriceKey: "polly-neural", characters: 9_000 });
    expect(cost).toEqual({ scriptUsd: 0.036, ttsUsd: 0.144, totalUsd: 0.18, inputTokens: 5_500, outputTokens: 2_500, characters: 9_000 });
  });

  it("prices a CLI run as the API model it stands in for, from characters when tokens are unknown", () => {
    expect(apiModelOf("claude-cli:haiku")).toBe("claude-haiku-4-5");
    const cost = estimateEpisodeCost({ model: "claude-cli:haiku", promptChars: 4_000, outputChars: 2_000, ttsPriceKey: "kokoro", characters: 2_000 });
    expect(cost).toMatchObject({ inputTokens: 1_000, outputTokens: 500, scriptUsd: 0.0035, ttsUsd: 0 });
    expect(estimateEpisodeCost({ model: null, ttsPriceKey: "unknown", characters: 10 }).totalUsd).toBe(0);
  });

  it("estimates speaking time", () => {
    expect(estimateSpeechSeconds(165)).toBe(60);
    expect(scriptWords(script([{ speaker: "host", text: "two words" }]))).toBe(2 + EPISODE_LIMITS.minWords);
  });
});

describe("episodeVoiceKey", () => {
  it("names the model and the voices used", () => {
    expect(episodeVoiceKey("kokoro", "conversation")).toBe("kokoro-v1.0:af_heart+am_michael");
    expect(episodeVoiceKey("polly", "narration")).toBe("polly-neural:Olivia");
  });
});
