/**
 * 64-bit SimHash over 3-word shingles, for collapsing reposts and editions of
 * the same text (build plan §6.3). Returned as a signed 64-bit BigInt so it
 * fits a Postgres `bigint`.
 */
export function simhash64(text: string): bigint | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < 3) return null;

  const weights = new Int32Array(64);
  for (let i = 0; i + 3 <= words.length; i++) {
    const shingle = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    const hi = fnv1a32(shingle, 0x811c9dc5);
    const lo = fnv1a32(shingle, 0x050c5d1f);
    for (let bit = 0; bit < 32; bit++) {
      weights[bit]! += (hi >>> bit) & 1 ? 1 : -1;
      weights[bit + 32]! += (lo >>> bit) & 1 ? 1 : -1;
    }
  }

  let hash = 0n;
  for (let bit = 0; bit < 64; bit++) if (weights[bit]! > 0) hash |= 1n << BigInt(bit);
  return BigInt.asIntN(64, hash);
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a ^ b);
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

/** Texts within this many differing bits are treated as the same piece. */
export const NEAR_DUPLICATE_DISTANCE = 3;

function fnv1a32(input: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
