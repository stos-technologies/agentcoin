// AgentKoin auth-capture arbiter helpers. Mirrors src/arbiter/AgentKoinAuthCaptureArbiter.sol byte for byte:
// termsHash, termsSalt (binding mode 1, "committed"), PaymentInfo construction, the escrow's getHash and the
// payer-agnostic ERC-3009 nonce. Pure functions; no network access. Testnet prototype, unaudited.
import { encodeAbiParameters, hashTypedData, keccak256, sha256, toBytes, toHex, type Address, type Hex } from "viem";

export const ZERO: Address = "0x0000000000000000000000000000000000000000";
/** Commerce Payments v1.1 (same address on Base and Base Sepolia). v1.0 is not supported by the arbiter. */
export const AUTH_CAPTURE_ESCROW_V1_1: Address = "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c";
export const ERC3009_COLLECTOR_V1_1: Address = "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88";

const ks = (s: string) => keccak256(toHex(s));
export const TERMS_TYPEHASH = ks(
  "AgentKoinTerms(address evaluator,bytes32 criteriaHash,bytes32 scheduleHash,uint8 requiredTotal,uint256 bpsTable,uint48 submitBy,uint32 evalWindow)",
);
export const AGK_SALT_TYPEHASH = ks("AgentKoinTermsSalt(bytes32 termsHash,uint256 saltNonce)");
export const PAYMENT_INFO_TYPEHASH = ks(
  "PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)",
);

export type Terms = {
  evaluator: Address;
  criteriaHash: Hex;
  scheduleHash: Hex;
  requiredTotal: number;
  bpsTable: bigint; // JobEscrow v0.6 packing (see packBpsTable)
  submitBy: number; // unix seconds
  evalWindow: number; // seconds
};

export type PaymentInfo = {
  operator: Address;
  payer: Address;
  receiver: Address;
  token: Address;
  maxAmount: bigint;
  preApprovalExpiry: number;
  authorizationExpiry: number;
  refundExpiry: number;
  minFeeBps: number;
  maxFeeBps: number;
  feeReceiver: Address;
  salt: bigint;
};

/** Arbiter immutable config (subset used for client-side checks); read it with arbiter.config(). */
export type ArbiterConfig = { evalWindow: number; challengeWindow: number; rulingWindow: number; minMarginSeconds: number };

/** entries[k] = payout bps when k required criteria pass; 16 bits each at [16k, 16k+16). */
export function packBpsTable(entries: number[]): bigint {
  if (entries.length < 2 || entries.length > 16) throw new Error("bps table needs 2..16 entries");
  let t = 0n;
  entries.forEach((e, k) => {
    if (!Number.isInteger(e) || e < 0 || e > 10_000) throw new Error(`bad bps ${e}`);
    if (k > 0 && e < entries[k - 1]) throw new Error("bps table must be non-decreasing");
    t |= BigInt(e) << BigInt(16 * k);
  });
  return t;
}

export function termsHash(t: Terms): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" },
        { type: "uint8" }, { type: "uint256" }, { type: "uint48" }, { type: "uint32" },
      ],
      [TERMS_TYPEHASH, t.evaluator, t.criteriaHash, t.scheduleHash, t.requiredTotal, t.bpsTable, t.submitBy, t.evalWindow],
    ),
  );
}

export function termsSalt(th: Hex, saltNonce: bigint): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], [AGK_SALT_TYPEHASH, th, saltNonce])));
}

/** PaymentInfo as the arbiter accepts it: fees 0/0, feeReceiver 0, refundExpiry = authorizationExpiry, salt = termsSalt. */
export function buildPaymentInfo(a: {
  arbiter: Address; payer: Address; receiver: Address; token: Address; maxAmount: bigint;
  preApprovalExpiry: number; authorizationExpiry: number; terms: Terms; saltNonce: bigint;
}): PaymentInfo {
  return {
    operator: a.arbiter, payer: a.payer, receiver: a.receiver, token: a.token, maxAmount: a.maxAmount,
    preApprovalExpiry: a.preApprovalExpiry, authorizationExpiry: a.authorizationExpiry, refundExpiry: a.authorizationExpiry,
    minFeeBps: 0, maxFeeBps: 0, feeReceiver: ZERO, salt: termsSalt(termsHash(a.terms), a.saltNonce),
  };
}

const PI_TYPES = [
  { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint120" }, { type: "uint48" },
  { type: "uint48" }, { type: "uint48" }, { type: "uint16" }, { type: "uint16" }, { type: "address" }, { type: "uint256" },
] as const;

/** AuthCaptureEscrow.getHash(paymentInfo): the payment key used everywhere by the arbiter. */
export function paymentInfoHash(p: PaymentInfo, chainId: number, escrow: Address): Hex {
  const inner = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, ...PI_TYPES], [
      PAYMENT_INFO_TYPEHASH, p.operator, p.payer, p.receiver, p.token, p.maxAmount, p.preApprovalExpiry,
      p.authorizationExpiry, p.refundExpiry, p.minFeeBps, p.maxFeeBps, p.feeReceiver, p.salt,
    ]),
  );
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "bytes32" }], [BigInt(chainId), escrow, inner]));
}

/** ERC-3009 nonce the client signs: getHash with payer zeroed. */
export function payerAgnosticNonce(p: PaymentInfo, chainId: number, escrow: Address): Hex {
  return paymentInfoHash({ ...p, payer: ZERO }, chainId, escrow);
}

/** EIP-712 typed data for the client's ReceiveWithAuthorization (pass to viem signTypedData). */
export function receiveWithAuthorizationTypedData(a: {
  p: PaymentInfo; chainId: number; escrow: Address; collector: Address; tokenName: string; tokenVersion: string;
}) {
  return {
    domain: { name: a.tokenName, version: a.tokenVersion, chainId: a.chainId, verifyingContract: a.p.token },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization" as const,
    message: {
      from: a.p.payer, to: a.collector, value: a.p.maxAmount, validAfter: 0n,
      validBefore: BigInt(a.p.preApprovalExpiry), nonce: payerAgnosticNonce(a.p, a.chainId, a.escrow),
    },
  };
}

/** Client-side refusal checks before signing (spec §3.2). Returns a list of problems; empty = OK. */
export function checkBeforeSigning(p: PaymentInfo, t: Terms, cfg: ArbiterConfig, saltNonce: bigint): string[] {
  const errs: string[] = [];
  if (p.minFeeBps !== 0 || p.maxFeeBps !== 0 || p.feeReceiver !== ZERO) errs.push("fees must be 0/0 with feeReceiver 0");
  if (p.refundExpiry !== p.authorizationExpiry) errs.push("refundExpiry must equal authorizationExpiry");
  if (p.salt !== termsSalt(termsHash(t), saltNonce)) errs.push("salt does not commit to these terms");
  if (t.evaluator.toLowerCase() === p.payer.toLowerCase() || t.evaluator.toLowerCase() === p.receiver.toLowerCase())
    errs.push("evaluator must differ from payer and receiver");
  if (t.evalWindow < cfg.evalWindow) errs.push("evalWindow below arbiter floor");
  const span = t.evalWindow + cfg.challengeWindow + cfg.rulingWindow + cfg.minMarginSeconds;
  if (t.submitBy + span > p.authorizationExpiry) errs.push(`authorizationExpiry too early: need >= ${t.submitBy + span}`);
  return errs;
}

// ---------------------------------------------------------------------------------------------------------
// v0.2 (source only; not on the Base Sepolia deployment 0x8b4B...453A, which is v0.1):
// resultDigest, EIP-712 OutsideVerdict and the separate BuyerAcceptance record.
// ---------------------------------------------------------------------------------------------------------

export const EIP712_NAME = "x402 outside-verdict";
export const EIP712_VERSION = "0.2";
export const OUTSIDE_VERDICT_TYPEHASH = ks(
  "OutsideVerdict(bytes32 paymentInfoHash,bytes32 termsHash,bytes32 deliverableHash,bytes32 resultDigest,uint16 passMask,uint16 payoutBps,bytes32 reasonHash)",
);
export const BUYER_ACCEPTANCE_TYPEHASH = ks(
  "BuyerAcceptance(bytes32 paymentInfoHash,bytes32 termsHash,bytes32 resultDigest,uint8 decision,bytes32 noteHash)",
);

/** Mirrors the contract enum. None = no buyer record (the default; never inferred from a capture). */
export const BuyerDecision = { None: 0, Accepted: 1, Rejected: 2 } as const;

export type OutsideVerdict = {
  paymentInfoHash: Hex; termsHash: Hex; deliverableHash: Hex; resultDigest: Hex;
  passMask: number; payoutBps: number; reasonHash: Hex;
};
export type BuyerAcceptance = { paymentInfoHash: Hex; termsHash: Hex; resultDigest: Hex; decision: 1 | 2; noteHash: Hex };

/** RFC 8785 (JCS) canonical JSON. Keys sorted by UTF-16 code units; ECMAScript number/string serialization. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("JCS: non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new Error(`JCS: unsupported type ${typeof v}`);
}

/** resultDigest = sha256 over the exact result bytes (bytes or 0x-hex). */
export function resultDigest(bytes: Uint8Array | Hex): Hex {
  return sha256(bytes);
}

/** resultDigest of a JSON result: sha256(UTF-8(JCS(value))). */
export function resultDigestJson(value: unknown): Hex {
  return sha256(toBytes(canonicalJson(value)));
}

/** True when the bytes in hand are the ones committed at submit. */
export function matchesCommittedDigest(bytes: Uint8Array | Hex, committed: Hex): boolean {
  return resultDigest(bytes).toLowerCase() === committed.toLowerCase();
}

export function popcount(mask: number): number {
  let c = 0;
  for (let m = mask; m; m &= m - 1) c++;
  return c;
}

/** Table entry for a pass mask (bits >= requiredTotal must be 0). */
export function payoutForMask(bpsTable: bigint, passMask: number, requiredTotal: number): number {
  if (passMask >> requiredTotal !== 0) throw new Error("pass mask has bits at or above requiredTotal");
  return Number((bpsTable >> BigInt(16 * popcount(passMask))) & 0xffffn);
}

/** Builds the verdict struct; payoutBps is derived from the committed terms, never supplied. */
export function buildVerdict(a: {
  paymentInfoHash: Hex; terms: Terms; deliverableHash: Hex; resultDigest: Hex; passMask: number; reasonHash: Hex;
}): OutsideVerdict {
  return {
    paymentInfoHash: a.paymentInfoHash, termsHash: termsHash(a.terms), deliverableHash: a.deliverableHash,
    resultDigest: a.resultDigest, passMask: a.passMask,
    payoutBps: payoutForMask(a.terms.bpsTable, a.passMask, a.terms.requiredTotal), reasonHash: a.reasonHash,
  };
}

const domain = (chainId: number, arbiter: Address) => ({ name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract: arbiter });

/** EIP-712 typed data for the evaluator's verdict (pass to viem signTypedData). */
export function verdictTypedData(chainId: number, arbiter: Address, v: OutsideVerdict) {
  return {
    domain: domain(chainId, arbiter),
    types: {
      OutsideVerdict: [
        { name: "paymentInfoHash", type: "bytes32" }, { name: "termsHash", type: "bytes32" },
        { name: "deliverableHash", type: "bytes32" }, { name: "resultDigest", type: "bytes32" },
        { name: "passMask", type: "uint16" }, { name: "payoutBps", type: "uint16" }, { name: "reasonHash", type: "bytes32" },
      ],
    },
    primaryType: "OutsideVerdict" as const,
    message: v,
  };
}

/** EIP-712 typed data for the payer's optional acceptance record (separate type, separate signer). */
export function buyerAcceptanceTypedData(chainId: number, arbiter: Address, a: BuyerAcceptance) {
  return {
    domain: domain(chainId, arbiter),
    types: {
      BuyerAcceptance: [
        { name: "paymentInfoHash", type: "bytes32" }, { name: "termsHash", type: "bytes32" },
        { name: "resultDigest", type: "bytes32" }, { name: "decision", type: "uint8" }, { name: "noteHash", type: "bytes32" },
      ],
    },
    primaryType: "BuyerAcceptance" as const,
    message: a,
  };
}

export const verdictDigest = (chainId: number, arbiter: Address, v: OutsideVerdict): Hex =>
  hashTypedData(verdictTypedData(chainId, arbiter, v));
export const buyerAcceptanceDigest = (chainId: number, arbiter: Address, a: BuyerAcceptance): Hex =>
  hashTypedData(buyerAcceptanceTypedData(chainId, arbiter, a));

/** Machine-readable settlement summary from arbiter.outcome(key). buyerAccepted is false unless a record says so. */
export function describeOutcome(o: { state: number; verdictRecorded: boolean; payoutBps: number; resultDigest: Hex; buyerDecision: number; buyerAccepted: boolean }) {
  const names = ["none", "accepted", "rejected"] as const;
  return {
    settledBy: o.verdictRecorded ? "verdict" : "none",
    payoutBps: o.payoutBps,
    resultDigest: o.resultDigest,
    buyerAcceptance: o.buyerDecision === BuyerDecision.None ? null : names[o.buyerDecision],
    buyerAccepted: o.buyerAccepted,
  };
}
export * from "./builder-code.ts";
