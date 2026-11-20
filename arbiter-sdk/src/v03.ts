// AgentKoin auth-capture arbiter v0.3 helpers (LOCAL PROTOTYPE; no v0.3 deployment exists). Mirrors
// src/arbiter/AgentKoinAuthCaptureArbiterV03.sol. v0.3 adds an optional Terms.submitter: when set, only that
// address may submit (so info.receiver can be a keyless address such as a Stripe crypto deposit address);
// when zero, info.receiver submits exactly as in v0.2. The v0.2 exports in ./index.ts are unchanged; this
// module is separate so the two typehashes and EIP-712 domains can never be mixed by accident.
import { encodeAbiParameters, hashTypedData, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import {
  AGK_SALT_TYPEHASH, BUYER_ACCEPTANCE_TYPEHASH, OUTSIDE_VERDICT_TYPEHASH, ZERO, payoutForMask, termsSalt,
  type ArbiterConfig, type BuyerAcceptance, type OutsideVerdict, type PaymentInfo, type Terms,
} from "./index.ts";
import { buildArbiterTx } from "./builder-code.ts";

export { AGK_SALT_TYPEHASH, OUTSIDE_VERDICT_TYPEHASH, BUYER_ACCEPTANCE_TYPEHASH, termsSalt };
export type { OutsideVerdict, BuyerAcceptance, PaymentInfo, ArbiterConfig };

export const VERSION_V03 = "0.3";
export const EIP712_NAME_V03 = "x402 outside-verdict";
export const EIP712_VERSION_V03 = "0.3";
export const TERMS_V03_TYPE =
  "AgentKoinTerms(address evaluator,bytes32 criteriaHash,bytes32 scheduleHash,uint8 requiredTotal,uint256 bpsTable,uint48 submitBy,uint32 evalWindow,address submitter)";
export const TERMS_V03_TYPEHASH = keccak256(toHex(TERMS_V03_TYPE));

/** v0.2 Terms plus an optional submitter (omitted or zero = info.receiver submits). */
export type TermsV03 = Terms & { submitter?: Address };

export const submitterOf = (t: TermsV03): Address => t.submitter ?? ZERO;

/** Mirrors effectiveSubmitter(info, terms). */
export function effectiveSubmitter(p: Pick<PaymentInfo, "receiver">, t: TermsV03): Address {
  const s = submitterOf(t);
  return s.toLowerCase() === ZERO ? p.receiver : s;
}

/** Mirrors bindTerms' SubmitterIsPayer guard: the effective submitter must not be the payer. */
export function submitterIsPayer(p: Pick<PaymentInfo, "payer" | "receiver">, t: TermsV03): boolean {
  return effectiveSubmitter(p, t).toLowerCase() === p.payer.toLowerCase();
}

export function hashTermsV03(t: TermsV03): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint8" },
        { type: "uint256" }, { type: "uint48" }, { type: "uint32" }, { type: "address" },
      ],
      [TERMS_V03_TYPEHASH, t.evaluator, t.criteriaHash, t.scheduleHash, t.requiredTotal, t.bpsTable, t.submitBy, t.evalWindow, submitterOf(t)],
    ),
  );
}

/** Solidity-shaped terms tuple (submitter always present) for contract calls. */
export const termsV03Args = (t: TermsV03) => ({ ...t, submitter: submitterOf(t) });

/** PaymentInfo as v0.3 accepts it: fees 0/0, feeReceiver 0, refundExpiry = authorizationExpiry, salt over hashTermsV03. */
export function buildPaymentInfoV03(a: {
  arbiter: Address; payer: Address; receiver: Address; token: Address; maxAmount: bigint;
  preApprovalExpiry: number; authorizationExpiry: number; terms: TermsV03; saltNonce: bigint;
}): PaymentInfo {
  if (submitterIsPayer(a, a.terms)) throw new Error("SubmitterIsPayer: effective submitter must differ from the payer");
  return {
    operator: a.arbiter, payer: a.payer, receiver: a.receiver, token: a.token, maxAmount: a.maxAmount,
    preApprovalExpiry: a.preApprovalExpiry, authorizationExpiry: a.authorizationExpiry, refundExpiry: a.authorizationExpiry,
    minFeeBps: 0, maxFeeBps: 0, feeReceiver: ZERO, salt: termsSalt(hashTermsV03(a.terms), a.saltNonce),
  };
}

/** Client-side checks before the payer signs a v0.3 offer. Empty list = OK. */
export function checkBeforeSigningV03(p: PaymentInfo, t: TermsV03, cfg: ArbiterConfig, saltNonce: bigint): string[] {
  const errs: string[] = [];
  const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  if (p.minFeeBps !== 0 || p.maxFeeBps !== 0 || p.feeReceiver !== ZERO) errs.push("fees must be 0/0 with feeReceiver 0");
  if (p.refundExpiry !== p.authorizationExpiry) errs.push("refundExpiry must equal authorizationExpiry");
  if (p.salt !== termsSalt(hashTermsV03(t), saltNonce)) errs.push("salt does not commit to these terms");
  if (eq(t.evaluator, p.payer) || eq(t.evaluator, p.receiver) || eq(t.evaluator, effectiveSubmitter(p, t)))
    errs.push("evaluator must differ from payer, receiver and submitter");
  if (submitterIsPayer(p, t)) errs.push("effective submitter must differ from the payer (SubmitterIsPayer)");
  if (t.evalWindow < cfg.evalWindow) errs.push("evalWindow below arbiter floor");
  const span = t.evalWindow + cfg.challengeWindow + cfg.rulingWindow + cfg.minMarginSeconds;
  if (t.submitBy + span > p.authorizationExpiry) errs.push(`authorizationExpiry too early: need >= ${t.submitBy + span}`);
  return errs;
}

export function buildVerdictV03(a: {
  paymentInfoHash: Hex; terms: TermsV03; deliverableHash: Hex; resultDigest: Hex; passMask: number; reasonHash: Hex;
}): OutsideVerdict {
  return {
    paymentInfoHash: a.paymentInfoHash, termsHash: hashTermsV03(a.terms), deliverableHash: a.deliverableHash,
    resultDigest: a.resultDigest, passMask: a.passMask,
    payoutBps: payoutForMask(a.terms.bpsTable, a.passMask, a.terms.requiredTotal), reasonHash: a.reasonHash,
  };
}

export const domainV03 = (chainId: number, arbiter: Address) =>
  ({ name: EIP712_NAME_V03, version: EIP712_VERSION_V03, chainId, verifyingContract: arbiter });

export function domainSeparatorV03(chainId: number, arbiter: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(toHex(EIP712_NAME_V03)), keccak256(toHex(EIP712_VERSION_V03)), BigInt(chainId), arbiter,
      ],
    ),
  );
}

export function verdictTypedDataV03(chainId: number, arbiter: Address, v: OutsideVerdict) {
  return {
    domain: domainV03(chainId, arbiter),
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

export function buyerAcceptanceTypedDataV03(chainId: number, arbiter: Address, a: BuyerAcceptance) {
  return {
    domain: domainV03(chainId, arbiter),
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

export const verdictDigestV03 = (chainId: number, arbiter: Address, v: OutsideVerdict): Hex =>
  hashTypedData(verdictTypedDataV03(chainId, arbiter, v));
export const buyerAcceptanceDigestV03 = (chainId: number, arbiter: Address, a: BuyerAcceptance): Hex =>
  hashTypedData(buyerAcceptanceTypedDataV03(chainId, arbiter, a));

/** Minimal v0.3 ABI (lifecycle + views used by integrators). Checked against the forge artifact in test/v03.test.ts. */
export const ARBITER_V03_ABI = parseAbi([
  "struct PaymentInfo { address operator; address payer; address receiver; address token; uint120 maxAmount; uint48 preApprovalExpiry; uint48 authorizationExpiry; uint48 refundExpiry; uint16 minFeeBps; uint16 maxFeeBps; address feeReceiver; uint256 salt; }",
  "struct Terms { address evaluator; bytes32 criteriaHash; bytes32 scheduleHash; uint8 requiredTotal; uint256 bpsTable; uint48 submitBy; uint32 evalWindow; address submitter; }",
  "struct OutsideVerdict { bytes32 paymentInfoHash; bytes32 termsHash; bytes32 deliverableHash; bytes32 resultDigest; uint16 passMask; uint16 payoutBps; bytes32 reasonHash; }",
  "struct BuyerAcceptance { bytes32 paymentInfoHash; bytes32 termsHash; bytes32 resultDigest; uint8 decision; bytes32 noteHash; }",
  "struct Outcome { uint8 state; bool verdictRecorded; uint16 payoutBps; bytes32 resultDigest; uint8 buyerDecision; bool buyerAccepted; }",
  "function VERSION() view returns (string)",
  "function EIP712_NAME() view returns (string)",
  "function EIP712_VERSION() view returns (string)",
  "function TERMS_TYPEHASH() view returns (bytes32)",
  "function domainSeparator() view returns (bytes32)",
  "function termsHash(Terms t) pure returns (bytes32)",
  "function hashTerms(Terms t) pure returns (bytes32)",
  "function termsSalt(bytes32 termsHash_, uint256 saltNonce) pure returns (uint256)",
  "function effectiveSubmitter(PaymentInfo info, Terms terms) pure returns (address)",
  "function verdictDigest(OutsideVerdict v) view returns (bytes32)",
  "function buyerAcceptanceDigest(BuyerAcceptance a) view returns (bytes32)",
  "function outcome(bytes32 key) view returns (Outcome)",
  "function authorize(PaymentInfo info, uint256 amount, address tokenCollector, bytes collectorData)",
  "function bindTerms(PaymentInfo info, Terms terms, uint256 saltNonce)",
  "function submit(PaymentInfo info, bytes32 deliverableHash, bytes32 resultDigest)",
  "function verdictScheduled(PaymentInfo info, uint16 passMask, uint8 requiredPassed, uint8 requiredTotal, bytes32 resultDigest, bytes32 reasonHash)",
  "function verdictBySig(PaymentInfo info, OutsideVerdict v, bytes sig)",
  "function recordBuyerAcceptance(PaymentInfo info, BuyerAcceptance a, bytes sig)",
  "function challenge(PaymentInfo info, bytes32 reasonHash)",
  "function finalize(PaymentInfo info)",
  "function timeoutRelease(PaymentInfo info)",
  "function voidNoSubmit(PaymentInfo info)",
  "event Submitted(bytes32 indexed key, address indexed submitter, bytes32 deliverableHash, bytes32 resultDigest)",
  "error Unauthorized()",
  "error BadSignature()",
  "error EvaluatorConflict()",
  "error SubmitterIsPayer()",
  "error SaltMismatch()",
  "error VerdictFieldMismatch()",
  "error SubmitWindowClosed()",
  "error ResultDigestMismatch(bytes32 committed, bytes32 given)",
]);

/** Same as builder-code.ts buildArbiterTx, preset to the v0.3 ABI (ERC-8021 suffix when a builder code resolves). */
export function buildArbiterV03Tx(a: { address: Address; functionName: string; args?: readonly unknown[]; builderCode?: string | null; env?: Record<string, string | undefined> }) {
  return buildArbiterTx({ ...a, abi: ARBITER_V03_ABI });
}
