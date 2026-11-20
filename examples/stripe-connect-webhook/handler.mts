// AgentKoin verdict -> Stripe Connect (separate charges and transfers). AgentKoin holds no funds: the platform's own
// Stripe account holds the charge; this handler only instructs transfers/refunds on that account.
//
// Request body (POST /agentkoin/verdict):
//  { chainId, arbiter, verdict: OutsideVerdict, signature, claimedEvaluator?, buyerAcceptance?: { acceptance, signature?, buyer? },
//    job: { paymentIntentId, transferGroup, sellerConnectedAccountId, authorizedAmountCents, currency, platformFeeBps?, sourceTransaction? },
//    expected: { evaluator, termsHash, paymentInfoHash, resultDigest } }
// Production note: `job` and `expected` should come from the platform's own records (deps.resolveJob), not the caller.
//
// Status codes:
//  200 settled, or duplicate delivery of the identical verdict (body.duplicate = true, same receipt)
//  400 malformed body / payoutBps not an integer in 0..10000 / buyerAcceptance not bound to this verdict
//  401 signature does not verify for the expected evaluator
//  403 claimedEvaluator differs from the expected evaluator
//  409 a different verdict was already settled for this payment (conflicting_verdict)
//  422 verdict paymentInfoHash / termsHash / resultDigest differs from expected
//  502 Stripe call failed; completed steps are kept and a retry resumes (idempotency keys are deterministic)
import { verifyTypedData, keccak256, toHex, isAddress, isHex, type Address, type Hex } from "viem";
import * as sdk from "../../arbiter-sdk/src/index.ts";
import { stripePost, type StripeCfg } from "./stripe-client.mts";

export type Job = { paymentIntentId: string; transferGroup: string; sellerConnectedAccountId: string; authorizedAmountCents: number; currency: string; platformFeeBps?: number; sourceTransaction?: string };
export type Expected = { evaluator: Address; termsHash: Hex; paymentInfoHash: Hex; resultDigest: Hex };
export type Settlement = { key: string; verdictDigest: Hex; steps: { transfer?: any; refund?: any }; receipt?: any };
export type Deps = { stripe: StripeCfg; store?: Map<string, Settlement>; resolveJob?: (b: any) => { job: Job; expected: Expected } | null };

export const MAX_BPS = 10_000;
const b32 = (x: unknown): x is Hex => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
const bad = (status: number, error: string, detail?: unknown) => ({ status, body: { error, ...(detail ? { detail } : {}) } });

/** Pure money split in integer cents. platformFeeCents = floor(grossSellerShare * platformFeeBps / 10000). */
export function splitCents(authorized: number, payoutBps: number, platformFeeBps = 0) {
  const gross = Math.floor((authorized * payoutBps) / MAX_BPS);
  const platformFeeCents = Math.floor((gross * platformFeeBps) / MAX_BPS);
  const transfer = Math.max(0, gross - platformFeeCents);
  return { grossSellerShareCents: gross, platformFeeCents, transferCents: transfer, refundCents: authorized - gross };
}

export function createHandler(deps: Deps) {
  const store = deps.store ?? new Map<string, Settlement>();
  const inflight = new Map<string, Promise<any>>();
  return async function handle(body: any): Promise<{ status: number; body: any }> {
    if (!body || typeof body !== "object") return bad(400, "malformed_body");
    const resolved = deps.resolveJob ? deps.resolveJob(body) : { job: body.job, expected: body.expected };
    if (!resolved) return bad(404, "unknown_job");
    const { job, expected } = resolved; const v = body.verdict;
    const okShape = Number.isInteger(body.chainId) && isAddress(body.arbiter) && v && b32(v.paymentInfoHash) && b32(v.termsHash) && b32(v.deliverableHash) && b32(v.resultDigest) && b32(v.reasonHash)
      && Number.isInteger(v.passMask) && isHex(body.signature) && job && typeof job.paymentIntentId === "string" && typeof job.transferGroup === "string" && typeof job.sellerConnectedAccountId === "string"
      && Number.isInteger(job.authorizedAmountCents) && job.authorizedAmountCents > 0 && typeof job.currency === "string" && expected && isAddress(expected.evaluator) && b32(expected.termsHash) && b32(expected.paymentInfoHash) && b32(expected.resultDigest)
      && (job.platformFeeBps === undefined || (Number.isInteger(job.platformFeeBps) && job.platformFeeBps >= 0 && job.platformFeeBps <= MAX_BPS));
    if (!okShape) return bad(400, "malformed_body");
    if (!Number.isInteger(v.payoutBps) || v.payoutBps < 0 || v.payoutBps > MAX_BPS) return bad(400, "payout_bps_out_of_range");
    if (body.claimedEvaluator && String(body.claimedEvaluator).toLowerCase() !== expected.evaluator.toLowerCase()) return bad(403, "evaluator_not_authorized");

    const verdict: sdk.OutsideVerdict = { paymentInfoHash: v.paymentInfoHash, termsHash: v.termsHash, deliverableHash: v.deliverableHash, resultDigest: v.resultDigest, passMask: v.passMask, payoutBps: v.payoutBps, reasonHash: v.reasonHash };
    let valid = false;
    try { valid = await verifyTypedData({ address: expected.evaluator, ...sdk.verdictTypedData(body.chainId, body.arbiter, verdict), signature: body.signature }); } catch { valid = false; }
    if (!valid) return bad(401, "invalid_signature");
    const mism = (["paymentInfoHash", "termsHash", "resultDigest"] as const).filter((k) => verdict[k].toLowerCase() !== expected[k].toLowerCase());
    if (mism.length) return bad(422, "verdict_mismatch", { fields: mism });

    let acceptance: any = null;
    if (body.buyerAcceptance) {
      const a = body.buyerAcceptance.acceptance;
      const bound = a && a.paymentInfoHash === verdict.paymentInfoHash && a.termsHash === verdict.termsHash && a.resultDigest === verdict.resultDigest && (a.decision === 1 || a.decision === 2) && b32(a.noteHash);
      if (!bound) return bad(400, "buyer_acceptance_not_bound");
      let signatureVerified: boolean | null = null;
      if (body.buyerAcceptance.signature && body.buyerAcceptance.buyer) {
        try { signatureVerified = await verifyTypedData({ address: body.buyerAcceptance.buyer, ...sdk.buyerAcceptanceTypedData(body.chainId, body.arbiter, a), signature: body.buyerAcceptance.signature }); } catch { signatureVerified = false; }
        if (!signatureVerified) return bad(401, "invalid_buyer_signature");
      }
      acceptance = { decision: a.decision === 1 ? "accepted" : "rejected", noteHash: a.noteHash, digest: sdk.buyerAcceptanceDigest(body.chainId, body.arbiter, a), signatureVerified };
    }

    const key = `${body.chainId}:${String(body.arbiter).toLowerCase()}:${verdict.paymentInfoHash.toLowerCase()}`;
    const vDigest = sdk.verdictDigest(body.chainId, body.arbiter, verdict);
    const run = async () => {
      const existing = store.get(key);
      if (existing && existing.verdictDigest !== vDigest) return bad(409, "conflicting_verdict", { settledVerdictDigest: existing.verdictDigest });
      if (existing?.receipt) return { status: 200, body: { ...existing.receipt, duplicate: true } };
      const st: Settlement = existing ?? { key, verdictDigest: vDigest, steps: {} }; store.set(key, st);
      const split = splitCents(job.authorizedAmountCents, verdict.payoutBps, job.platformFeeBps ?? 0);
      const idemBase = `agk-${keccak256(toHex(key + vDigest)).slice(2, 34)}`;
      const meta = { agentkoin_payment_info_hash: verdict.paymentInfoHash, agentkoin_verdict_digest: vDigest, agentkoin_terms_hash: verdict.termsHash, agentkoin_result_digest: verdict.resultDigest, agentkoin_payout_bps: String(verdict.payoutBps), agentkoin_evaluator: expected.evaluator };
      const fail = (step: string, r: any) => ({ status: 502, body: { error: "stripe_error", step, stripeStatus: r.status, stripe: r.body?.error ?? r.body, completedSteps: Object.keys(st.steps) } });
      if (split.transferCents > 0 && !st.steps.transfer) {
        const r = await stripePost(deps.stripe, "/v1/transfers", { amount: split.transferCents, currency: job.currency, destination: job.sellerConnectedAccountId, transfer_group: job.transferGroup, source_transaction: job.sourceTransaction, metadata: meta }, `${idemBase}-transfer`);
        if (!r.ok) return fail("transfer", r); st.steps.transfer = { id: r.body.id, amountCents: split.transferCents, destination: job.sellerConnectedAccountId, transferGroup: job.transferGroup };
      }
      if (split.refundCents > 0 && !st.steps.refund) {
        const r = await stripePost(deps.stripe, "/v1/refunds", { payment_intent: job.paymentIntentId, amount: split.refundCents, metadata: meta }, `${idemBase}-refund`);
        if (!r.ok) return fail("refund", r); st.steps.refund = { id: r.body.id, amountCents: split.refundCents, paymentIntentId: job.paymentIntentId };
      }
      const outcome = verdict.payoutBps === MAX_BPS ? "pass" : verdict.payoutBps === 0 ? "fail" : "partial";
      st.receipt = {
        schema: "agentkoin.connect-settlement/0.1", outcome, duplicate: false, chainId: body.chainId, arbiter: body.arbiter,
        verdict: { ...verdict, digest: vDigest, evaluator: expected.evaluator, signatureVerified: true }, buyerAcceptance: acceptance,
        job: { paymentIntentId: job.paymentIntentId, transferGroup: job.transferGroup, sellerConnectedAccountId: job.sellerConnectedAccountId, authorizedAmountCents: job.authorizedAmountCents, currency: job.currency, platformFeeBps: job.platformFeeBps ?? 0 },
        amountsCents: split, stripe: { transfer: st.steps.transfer ?? null, refund: st.steps.refund ?? null, idempotencyKeyPrefix: idemBase },
        heldByAgentKoin: 0,
      };
      return { status: 200, body: st.receipt };
    };
    const prior = inflight.get(key);
    const p = (prior ?? Promise.resolve()).then(run); // serialize per payment: concurrent duplicates see the stored result
    inflight.set(key, p.catch(() => {}));
    return p;
  };
}
