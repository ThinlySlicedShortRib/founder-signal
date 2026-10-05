import { randomBytes } from "node:crypto";

/** RFC 4648 base32, lowercase: no characters that look alike in most fonts except the ones email clients already handle. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const RANDOM_CHARS = 12;

/** `n-` + 12 base32 characters (60 random bits). */
export const INBOUND_LOCAL_PART = /^n-[a-z2-7]{12}$/;

/** A new, unguessable local part for a user's inbound address. */
export function newInboundLocalPart(random: (n: number) => Uint8Array = randomBytes): string {
  // 256 is a multiple of 32, so masking each byte keeps the characters uniform.
  const bytes = random(RANDOM_CHARS);
  let out = "n-";
  for (let i = 0; i < RANDOM_CHARS; i++) out += ALPHABET[bytes[i]! & 31];
  return out;
}

/**
 * The local part if `address` is one of ours on `domain` (case-insensitive;
 * a `+tag` is ignored), else null.
 */
export function inboundLocalPartOf(address: string, domain: string): string | null {
  const clean = address.trim().toLowerCase().replace(/^<|>$/g, "");
  const at = clean.lastIndexOf("@");
  if (at < 0) return null;
  if (clean.slice(at + 1) !== domain.toLowerCase()) return null;
  const local = clean.slice(0, at).split("+")[0]!;
  return INBOUND_LOCAL_PART.test(local) ? local : null;
}
