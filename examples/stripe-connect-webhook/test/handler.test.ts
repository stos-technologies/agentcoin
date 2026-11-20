// Local only: mock Stripe + the real HTTP server on loopback. Verdicts are signed with public anvil test keys.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import * as sdk from "../../../arbiter-sdk/src/index.ts";
import { createServer } from "../server.mts";
import { splitCents } from "../handler.mts";
import { startMock } from "../mock-stripe.mts";

const MN = "test test test test test test test test test test test junk";
const evaluator = mnemonicToAccount(MN, { addressIndex: 3 }), stranger = mnemonicToAccount(MN, { addressIndex: 9 }), buyer = mnemonicToAccount(MN, { addressIndex: 1 });
const CHAIN = 84532, ARBITER = "0xC0A315b5C4745DecB7db9Ed019C026971500e7a0" as Address;
const terms: sdk.Terms = { evaluator: evaluator.address, criteriaHash: keccak256(toHex("c")), scheduleHash: keccak256(toHex("s")), requiredTotal: 4, bpsTable: sdk.packBpsTable([0, 2500, 6000, 7500, 10000]), submitBy: 1795798800, evalWindow: 21600 };
let mock: Awaited<ReturnType<typeof startMock>>, srv: ReturnType<typeof createServer>, URL_: string, n = 0;

before(async () => { mock = await startMock(); srv = createServer({ stripe: { apiBase: mock.url, secretKey: "mock_secret_key" } }); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r)); URL_ = `http://127.0.0.1:${(srv.address() as any).port}/agentkoin/verdict`; });
after(async () => { srv.close(); await mock.close(); });

async function make(passMask: number, o: { fee?: number; signer?: typeof evaluator; acceptance?: boolean } = {}) {
  const id = ++n; const piHash = keccak256(toHex(`pi-${id}`)); const digest = sdk.resultDigestJson({ id });
  const verdict = sdk.buildVerdict({ paymentInfoHash: piHash, terms, deliverableHash: keccak256(toHex("d")), resultDigest: digest, passMask, reasonHash: keccak256(toHex("r")) });
  const signature = await (o.signer ?? evaluator).signTypedData(sdk.verdictTypedData(CHAIN, ARBITER, verdict));
  const body: any = {
    chainId: CHAIN, arbiter: ARBITER, verdict, signature,
    job: { paymentIntentId: `pi_${id}`, transferGroup: `job_${id}`, sellerConnectedAccountId: "acct_seller1", authorizedAmountCents: 10_000, currency: "usd", ...(o.fee !== undefined ? { platformFeeBps: o.fee } : {}), },
    expected: { evaluator: evaluator.address, termsHash: sdk.termsHash(terms), paymentInfoHash: piHash, resultDigest: digest },
  };
  if (o.acceptance) {
    const a: sdk.BuyerAcceptance = { paymentInfoHash: piHash, termsHash: verdict.termsHash, resultDigest: digest, decision: 1, noteHash: keccak256(toHex("n")) };
    body.buyerAcceptance = { acceptance: a, buyer: buyer.address, signature: await buyer.signTypedData(sdk.buyerAcceptanceTypedData(CHAIN, ARBITER, a)) };
  }
  return body;
}
const post = async (body: any) => { const r = await fetch(URL_, { method: "POST", body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
const callsFor = (id: number) => mock.requests.filter((r) => r.form.transfer_group === `job_${id}` || r.form.payment_intent === `pi_${id}`);

test("splitCents math", () => {
  assert.deepEqual(splitCents(10000, 10000, 0), { grossSellerShareCents: 10000, platformFeeCents: 0, transferCents: 10000, refundCents: 0 });
  assert.deepEqual(splitCents(10000, 6000, 1000), { grossSellerShareCents: 6000, platformFeeCents: 600, transferCents: 5400, refundCents: 4000 });
  assert.deepEqual(splitCents(10000, 0, 500), { grossSellerShareCents: 0, platformFeeCents: 0, transferCents: 0, refundCents: 10000 });
  assert.equal(splitCents(3, 3333, 10000).transferCents, 0); // clamped at 0
  assert.equal(splitCents(999, 3333, 0).grossSellerShareCents + splitCents(999, 3333, 0).refundCents, 999);
});

test("full pass: one transfer for the net seller share, no refund", async () => {
  const b = await make(0xf, { fee: 250 }); const r = await post(b);
  assert.equal(r.status, 200); assert.equal(r.body.outcome, "pass"); assert.equal(r.body.heldByAgentKoin, 0);
  const calls = callsFor(n); assert.deepEqual(calls.map((c) => c.path), ["/v1/transfers"]);
  const c = calls[0]!;
  assert.equal(c.form.amount, "9750"); assert.equal(c.form.currency, "usd"); assert.equal(c.form.destination, "acct_seller1"); assert.equal(c.form.transfer_group, `job_${n}`);
  assert.match(String(c.headers["idempotency-key"]), /^agk-[0-9a-f]{32}-transfer$/);
  assert.equal(c.form["metadata[agentkoin_payout_bps]"], "10000"); assert.equal(c.form["metadata[agentkoin_verdict_digest]"], r.body.verdict.digest);
  assert.equal(r.body.stripe.transfer.id.startsWith("tr_mock_"), true); assert.equal(r.body.stripe.refund, null);
});

test("partial 6000 bps without fee: transfer 6000 + refund 4000", async () => {
  const r = await post(await make(0b0111 & 0b0011)); // 2 passes -> table[2] = 6000
  assert.equal(r.body.verdict.payoutBps, 6000); assert.equal(r.body.outcome, "partial");
  const calls = callsFor(n); assert.deepEqual(calls.map((c) => [c.path, c.form.amount]), [["/v1/transfers", "6000"], ["/v1/refunds", "4000"]]);
  assert.equal(calls[1]!.form.payment_intent, `pi_${n}`); assert.equal(calls[1]!.form["metadata[agentkoin_terms_hash]"], sdk.termsHash(terms));
});

test("partial 6000 bps with platformFeeBps 1000: transfer 5400 + refund 4000, buyerAcceptance recorded", async () => {
  const r = await post(await make(0b0011, { fee: 1000, acceptance: true }));
  assert.equal(r.status, 200); assert.deepEqual(r.body.amountsCents, { grossSellerShareCents: 6000, platformFeeCents: 600, transferCents: 5400, refundCents: 4000 });
  assert.deepEqual(callsFor(n).map((c) => c.form.amount), ["5400", "4000"]);
  assert.equal(r.body.buyerAcceptance.decision, "accepted"); assert.equal(r.body.buyerAcceptance.signatureVerified, true);
});

test("fail 0 bps: full refund, no transfer", async () => {
  const r = await post(await make(0, { fee: 500 }));
  assert.equal(r.body.outcome, "fail"); assert.deepEqual(callsFor(n).map((c) => [c.path, c.form.amount]), [["/v1/refunds", "10000"]]);
});

test("invalid signature -> 401, no Stripe call", async () => {
  const b = await make(0xf); b.signature = b.signature.slice(0, -4) + "0000";
  const r = await post(b); assert.equal(r.status, 401); assert.equal(callsFor(n).length, 0);
});

test("signed by a different evaluator -> 401; claimedEvaluator mismatch -> 403", async () => {
  const r = await post(await make(0xf, { signer: stranger })); assert.equal(r.status, 401); assert.equal(callsFor(n).length, 0);
  const b = await make(0xf); b.claimedEvaluator = stranger.address; const r2 = await post(b); assert.equal(r2.status, 403); assert.equal(callsFor(n).length, 0);
});

test("resultDigest / terms / paymentInfoHash mismatch -> 422, no Stripe call", async () => {
  for (const f of ["resultDigest", "termsHash", "paymentInfoHash"]) {
    const b = await make(0xf); b.expected[f] = keccak256(toHex("other")); const r = await post(b);
    assert.equal(r.status, 422, f); assert.deepEqual(r.body.detail.fields, [f]); assert.equal(callsFor(n).length, 0);
  }
});

test("payoutBps out of range and malformed bodies -> 400", async () => {
  const b = await make(0xf); b.verdict.payoutBps = 10001; assert.equal((await post(b)).status, 400);
  assert.equal((await post({})).status, 400);
  const c = await make(0xf); c.job.authorizedAmountCents = 0; assert.equal((await post(c)).status, 400);
  const d = await make(0xf, { acceptance: true }); d.buyerAcceptance.acceptance.resultDigest = keccak256(toHex("x")); assert.equal((await post(d)).status, 400);
  const raw = await fetch(URL_, { method: "POST", body: "{nope" }); assert.equal(raw.status, 400);
});

test("duplicate delivery -> 200 duplicate:true, no second Stripe call; conflicting verdict -> 409", async () => {
  const b = await make(0b0011); const r1 = await post(b); const count = callsFor(n).length;
  const r2 = await post(b);
  assert.equal(r2.status, 200); assert.equal(r2.body.duplicate, true); assert.deepEqual(r2.body.stripe, r1.body.stripe); assert.equal(callsFor(n).length, count);
  // concurrent duplicates
  const c = await make(0xf); const rs = await Promise.all([post(c), post(c), post(c)]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]); assert.equal(callsFor(n).length, 1);
  assert.equal(rs.filter((r) => r.body.duplicate).length, 2);
  // different verdict for the same payment
  const alt = sdk.buildVerdict({ paymentInfoHash: b.verdict.paymentInfoHash, terms, deliverableHash: b.verdict.deliverableHash, resultDigest: b.verdict.resultDigest, passMask: 0, reasonHash: b.verdict.reasonHash });
  const conflicting = { ...b, verdict: alt, signature: await evaluator.signTypedData(sdk.verdictTypedData(CHAIN, ARBITER, alt)) };
  const r3 = await post(conflicting); assert.equal(r3.status, 409); assert.equal(r3.body.error, "conflicting_verdict");
});

test("Stripe outage on the refund step -> 502, retry resumes without repeating the transfer", async () => {
  const m = await startMock({ failPath: "/v1/refunds", failTimes: 1 });
  const s = createServer({ stripe: { apiBase: m.url, secretKey: "mock_secret_key" } }); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const u = `http://127.0.0.1:${(s.address() as any).port}/agentkoin/verdict`;
  try {
    const b = await make(0b0011); const go = async () => { const r = await fetch(u, { method: "POST", body: JSON.stringify(b) }); return { status: r.status, body: await r.json() as any }; };
    const r1 = await go(); assert.equal(r1.status, 502); assert.deepEqual(r1.body.completedSteps, ["transfer"]);
    const r2 = await go(); assert.equal(r2.status, 200); assert.equal(r2.body.stripe.refund.amountCents, 4000);
    assert.equal(m.requests.filter((r) => r.path === "/v1/transfers").length, 1);
  } finally { s.close(); await m.close(); }
});
