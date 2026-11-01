import canonicalizeMod from "canonicalize";
import { keccak256, toBytes, verifyMessage, getAddress, type Hex } from "viem";

const canonicalize = canonicalizeMod as unknown as (v: unknown) => string | undefined;

/** RFC 8785 JSON canonicalization. */
export function jcs(v: unknown): string {
  const s = canonicalize(v);
  if (s === undefined) throw new Error("value cannot be canonicalized");
  return s;
}

export function keccakJcs(v: unknown): Hex {
  return keccak256(toBytes(jcs(v)));
}

export interface Eip191Signature { scheme: string; signer: string; signedDigest?: string; value: string }

/** Checks an AgentCoin EIP-191 document signature: personal_sign over keccak256(RFC8785(document without "signature")). */
export async function verifyEip191Document(doc: Record<string, unknown>): Promise<{ valid: boolean; signer?: string; digest?: Hex; reason?: string }> {
  const s = doc?.signature as Eip191Signature | undefined;
  if (!s || s.scheme !== "eip191") return { valid: false, reason: "no eip191 signature" };
  const { signature: _omit, ...unsigned } = doc;
  const digest = keccakJcs(unsigned);
  if (s.signedDigest && s.signedDigest.toLowerCase() !== digest.toLowerCase()) return { valid: false, digest, reason: "digest mismatch (document modified)" };
  const valid = await verifyMessage({ address: getAddress(s.signer), message: { raw: digest }, signature: s.value as Hex });
  return { valid, signer: getAddress(s.signer), digest, ...(valid ? {} : { reason: "signature does not match signer" }) };
}
