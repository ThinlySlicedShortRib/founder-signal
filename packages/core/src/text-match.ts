/**
 * Small, deterministic text matching for ranking and verification: no
 * embeddings, just normalized words. Good enough to say "this piece is about
 * a topic you named" and to check that a number or quote appears in a source.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can do does for from had has have how i i'm i've if in into is it its just like more most " +
    "my of on or our out over so some than that the their them then there these they this to too up was we what when where which " +
    "who why will with you your about after all also any been being both each few get got into lately me much need new not now " +
    "only other own same should still such them through under very want way well were while would yet really things thing stuff " +
    "into lot lots trying figure figuring"
  ).split(/\s+/),
);

/** Lowercase, straight quotes, collapsed whitespace. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** A crude stem so "pricing"/"prices"/"priced" and "hire"/"hiring" meet. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  for (const suffix of ["ings", "ing", "ies", "ied", "es", "ed", "s"]) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      if (suffix === "ies" || suffix === "ied") w += "y";
      break;
    }
  }
  // "pric" (pricing) and "price" should meet: drop a trailing e.
  return w.length > 3 && w.endsWith("e") ? w.slice(0, -1) : w;
}

export function words(text: string): string[] {
  return normalizeText(text).match(/[\p{L}\p{N}][\p{L}\p{N}'+#.-]*[\p{L}\p{N}+#]|[\p{L}\p{N}]/gu) ?? [];
}

/** Meaningful word stems, in order, without stopwords. */
export function keywords(text: string): string[] {
  const out: string[] = [];
  for (const raw of words(text)) {
    const w = raw.replace(/'s?$/, "");
    if (STOPWORDS.has(w) || (w.length < 3 && !/^(ai|ux|ui|vc|b2b|gtm|seo|api)$/.test(w))) continue;
    const s = stem(w);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Whether a phrase (a topic, a leaning, the user's "lately") is about the
 * text: all of its keywords appear for short phrases, at least two for longer
 * ones. Returns the matched keywords, or null.
 */
export function phraseMatches(phrase: string, textStems: ReadonlySet<string>): string[] | null {
  const k = keywords(phrase);
  if (!k.length) return null;
  const hit = k.filter((s) => textStems.has(s));
  const needed = k.length <= 2 ? k.length : Math.max(2, Math.ceil(k.length / 3));
  return hit.length >= needed ? hit : null;
}

export function stemSet(...texts: (string | null | undefined)[]): Set<string> {
  return new Set(texts.flatMap((t) => (t ? keywords(t) : [])));
}

/** "pricing" → "Pricing"; keeps "AI tools" as is. */
export function displayTopic(topic: string): string {
  const t = topic.trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}
