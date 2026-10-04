/**
 * Feedback codes (build plan §6.7): `[A-Z]{2}[0-9]{2}`, unique within a
 * letter, so a reply like "PR21 was great" maps to one piece. Ambiguous
 * characters (O/0, I/1) are never used, and a code never starts with the
 * initials of the piece's own publication (no publisher badge anywhere).
 */

export const FEEDBACK_CODE_PATTERN = /^[A-HJ-NP-Z]{2}[2-9]{2}$/;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";

/** "Membership Economics" → ["ME", "MB"]; "Stratechery" → ["ST"]. Pairs to avoid for its codes. */
export function publicationInitials(name: string): string[] {
  const parts = name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .toUpperCase()
    .split(/\s+/)
    .filter((p) => p && !["THE", "A", "AN", "OF"].includes(p));
  const out = new Set<string>();
  if (parts.length >= 2) out.add(`${parts[0]![0]}${parts[1]![0]}`);
  if (parts[0] && parts[0].length >= 2) out.add(parts[0].slice(0, 2));
  return [...out];
}

/**
 * One code per piece, in order. `random` returns [0, 1) and is injectable for
 * tests; codes are drawn until unique, so a letter never repeats one.
 */
export function assignFeedbackCodes(publications: string[], random: () => number = Math.random): string[] {
  const pick = (alphabet: string) => alphabet[Math.floor(random() * alphabet.length) % alphabet.length]!;
  const codes: string[] = [];
  for (const name of publications) {
    const avoid = new Set(publicationInitials(name));
    let code = "";
    for (let tries = 0; tries < 10_000; tries++) {
      const letters = pick(LETTERS) + pick(LETTERS);
      if (avoid.has(letters)) continue;
      code = letters + pick(DIGITS) + pick(DIGITS);
      if (!codes.includes(code)) break;
      code = "";
    }
    if (!code) throw new Error("Couldn't draw a unique feedback code");
    codes.push(code);
  }
  return codes;
}
