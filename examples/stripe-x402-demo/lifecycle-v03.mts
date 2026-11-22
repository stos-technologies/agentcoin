// v0.3 zero-hop lifecycle ("arbiter_v03_direct"): receiver = a Stripe crypto deposit address (no key anywhere),
// Terms.submitter = the seller EOA. authorize -> bindTerms -> submit (seller EOA) -> verdictBySig -> settle.
// Settlement (the single capture tx: escrow token store -> deposit address) is finalize(), or rule() (reached via
// the arbitrator's giveRuling) or resolveStaleDispute() after a challenge. Stripe transaction_verification is asked
// to record that settlement tx hash, only for an exact whole-cent amount (never floored). No impersonation, no
// forward. ABIs come from ../../out (run `forge build`); all txs go to opts.rpcUrl. v0.3 is deployed on Base Sepolia at
// 0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5; live runs set waitForChallengeWindow (no time travel on a real chain).
import { readFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex, parseAbi, parseAbiItem, parseEventLogs, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as sdk from "../../arbiter-sdk/src/index.ts";
import * as v03 from "../../arbiter-sdk/src/v03.ts";
import { createDepositAddress, createVerificationIntent, type StripeConfig } from "./stripe.mts";

const OUT = path.resolve(import.meta.dirname, "..", "..", "out");
const ARB = JSON.parse(readFileSync(path.join(OUT, "AgentKoinAuthCaptureArbiterV03.sol", "AgentKoinAuthCaptureArbiterV03.json"), "utf8")).abi;
const transferEvt = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const arbitratorAbi = parseAbi(["function giveRuling(uint256 disputeId, uint16 payoutBps)", "function disputeCount() view returns (uint256)", "function fee() view returns (uint256)"]);
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 1 cent = 10_000 atomic USDC. Only exact whole-cent amounts are sent to Stripe; never floored. */
export const isWholeCents = (atomic: bigint) => atomic >= 10_000n && atomic % 10_000n === 0n;
export function exactCents(atomic: bigint): number {
  if (!isWholeCents(atomic)) throw new Error(`NON_WHOLE_CENT_AMOUNT: ${atomic} atomic USDC is not a positive whole number of cents`);
  return Number(atomic / 10_000n);
}
export type SettlementStep = "finalize" | "rule" | "resolveStaleDispute";

export type LifecycleV03Opts = {
  rpcUrl: string; chainId?: number; escrow: Address; arbiterV03: Address; usdc: Address; collector: Address;
  tokenName: string; tokenVersion: string;
  stripe: StripeConfig; stripeNetwork?: string;
  /** If omitted, a deposit address is created with POST /v1/crypto/deposit_addresses. */
  stripeDepositAddress?: Address;
  keys: { payer: Hex; evaluator: Hex; seller: Hex; relayer: Hex };
  amount: bigint; passMask: number; timeTravel?: boolean; saltNonce?: bigint; result?: unknown;
  /** Challenge after the verdict, then settle by rule() (arbitrator ruling) or resolveStaleDispute() (after rulingWindow). */
  dispute?: { challenger: "seller" | "payer"; arbitrator: Address; arbitratorOwnerKey: Hex; ruling?: number; stale?: boolean };
  /** Live chains: before finalize(), poll until a block's timestamp is past verdictAt + challengeWindow. */
  waitForChallengeWindow?: boolean; pollMs?: number;
  /** Live chains: retry a failing simulateContract this many times (load-balanced RPC read-after-write lag). */
  simulateRetries?: number;
  onStep?: (step: string, hash: Hex) => void;
};

export async function runLifecycleV03(o: LifecycleV03Opts) {
  const chainId = o.chainId ?? (await createPublicClient({ transport: http(o.rpcUrl) }).getChainId());
  const chain = defineChain({ id: chainId, name: "demo", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [o.rpcUrl] } } });
  const pc = createPublicClient({ chain, transport: http(o.rpcUrl), cacheTime: 0, pollingInterval: 200 });
  const [payer, evaluator, seller, relayer] = [o.keys.payer, o.keys.evaluator, o.keys.seller, o.keys.relayer].map((k) => privateKeyToAccount(k));
  const txs: Record<string, Hex | null> = { authorize: null, bindTerms: null, submit: null, verdict: null, challenge: null, settlement: null };
  const send = async (who: any, functionName: string, args: unknown[], address: Address = o.arbiterV03, abi: any = ARB) => {
    let request: any;
    for (let i = 0; ; i++) {
      try { ({ request } = await pc.simulateContract({ address, abi, functionName, args, account: who } as any)); break; }
      catch (e) { if (i >= (o.simulateRetries ?? 0)) throw e; await sleep(o.pollMs ?? 3000); }
    }
    const hash = await createWalletClient({ account: who, chain, transport: http(o.rpcUrl) }).writeContract(request as any);
    const rc = await pc.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${functionName} reverted`);
    o.onStep?.(functionName, hash);
    return { hash, rc };
  };

  let deposit = o.stripeDepositAddress, depositAddressId: string | null = null;
  if (!deposit) {
    const r = await createDepositAddress(o.stripe);
    if (!r.ok) throw new Error(`deposit address: HTTP ${r.status} ${JSON.stringify(r.body?.error ?? r.body)}`);
    deposit = getAddress(r.body.address); depositAddressId = r.body.id ?? null;
  }
  const receiver = deposit;

  const now = Number((await pc.getBlock()).timestamp);
  const terms: v03.TermsV03 = { evaluator: evaluator.address, criteriaHash: keccak256(toHex("stripe-x402-demo/criteria")), scheduleHash: keccak256(toHex("stripe-x402-demo/schedule")),
    requiredTotal: 4, bpsTable: sdk.packBpsTable([0, 2500, 5000, 7500, 10000]), submitBy: now + 3600, evalWindow: 21600, submitter: seller.address };
  const saltNonce = o.saltNonce ?? BigInt(keccak256(toHex(`${now}-${Math.random()}`)));
  const p = v03.buildPaymentInfoV03({ arbiter: o.arbiterV03, payer: payer.address, receiver, token: o.usdc, maxAmount: o.amount, preApprovalExpiry: now + 600, authorizationExpiry: now + 3 * 86400, terms, saltNonce });
  const key = sdk.paymentInfoHash(p, chainId, o.escrow);
  const th = v03.hashTermsV03(terms);

  const sig = await payer.signTypedData(sdk.receiveWithAuthorizationTypedData({ p, chainId, escrow: o.escrow, collector: o.collector, tokenName: o.tokenName, tokenVersion: o.tokenVersion }));
  txs.authorize = (await send(relayer, "authorize", [p, p.maxAmount, o.collector, sig])).hash;
  txs.bindTerms = (await send(evaluator, "bindTerms", [p, v03.termsV03Args(terms), saltNonce])).hash;
  const result = o.result ?? { job: "stripe-x402-demo", output: "deliverable" };
  const digest = sdk.resultDigestJson(result);
  const deliverableHash = keccak256(toHex("stripe-x402-demo/deliverable"));
  txs.submit = (await send(seller, "submit", [p, deliverableHash, digest])).hash; // seller EOA, not the receiver

  const v = v03.buildVerdictV03({ paymentInfoHash: key, terms, deliverableHash, resultDigest: digest, passMask: o.passMask, reasonHash: keccak256(toHex("stripe-x402-demo/reason")) });
  const vsig = await evaluator.signTypedData(v03.verdictTypedDataV03(chainId, o.arbiterV03, v));
  const verdictSent = await send(relayer, "verdictBySig", [p, v, vsig]);
  txs.verdict = verdictSent.hash;

  const cfg = (await pc.readContract({ address: o.arbiterV03, abi: ARB, functionName: "config" }) as any);
  const warp = async (sec: number) => { await pc.request({ method: "evm_increaseTime" as any, params: [sec] as any }); await pc.request({ method: "evm_mine" as any, params: [] as any }); };
  let step: SettlementStep = "finalize";
  let settled: Awaited<ReturnType<typeof send>>;
  if (o.dispute) {
    const challenger = o.dispute.challenger === "seller" ? seller : payer;
    const cost = BigInt(cfg.minChallengeBond) + (await pc.readContract({ address: o.dispute.arbitrator, abi: arbitratorAbi, functionName: "fee" }) as bigint);
    await send(challenger, "approve", [o.arbiterV03, cost], o.usdc, erc20);
    txs.challenge = (await send(challenger, "challenge", [p, keccak256(toHex("stripe-x402-demo/challenge"))])).hash;
    if (o.dispute.stale) {
      if (o.timeTravel) await warp(Number(cfg.rulingWindow) + 1);
      step = "resolveStaleDispute";
      settled = await send(relayer, "resolveStaleDispute", [p]);
    } else {
      const disputeId = await pc.readContract({ address: o.dispute.arbitrator, abi: arbitratorAbi, functionName: "disputeCount" }) as bigint;
      step = "rule"; // giveRuling -> arbiter.rule() -> capture, all inside this one tx
      settled = await send(privateKeyToAccount(o.dispute.arbitratorOwnerKey), "giveRuling", [disputeId, o.dispute.ruling ?? v.payoutBps], o.dispute.arbitrator, arbitratorAbi);
    }
  } else {
    if (o.timeTravel) await warp(Number(cfg.challengeWindow) + 1);
    if (o.waitForChallengeWindow) {
      const until = (await pc.getBlock({ blockNumber: verdictSent.rc.blockNumber })).timestamp + BigInt(cfg.challengeWindow);
      while ((await pc.getBlock()).timestamp <= until) await sleep(o.pollMs ?? 3000);
    }
    settled = await send(relayer, "finalize", [p]);
  }
  txs.settlement = settled.hash;
  const transfers = parseEventLogs({ abi: [transferEvt], logs: settled.rc.logs }).filter((l) => l.address.toLowerCase() === o.usdc.toLowerCase());
  const sum = (to: Address) => transfers.filter((l) => l.args.to.toLowerCase() === to.toLowerCase()).reduce((s, l) => s + l.args.value, 0n);
  const captureTransfers = transfers.filter((l) => l.args.to.toLowerCase() === receiver.toLowerCase());
  const toReceiver = sum(receiver), toPayer = sum(payer.address), toSeller = sum(seller.address);

  let stripe: any = { status: "not_called", reason: "zero_capture", paymentIntentId: null, verification: null };
  if (toReceiver > 0n && (captureTransfers.length !== 1 || !isWholeCents(toReceiver))) {
    stripe = { status: "not_called", reason: captureTransfers.length !== 1 ? "multiple_capture_transfers" : "non_whole_cent_amount",
      capturedAtomic: toReceiver.toString(), paymentIntentId: null, verification: null };
  } else if (toReceiver > 0n) {
    const cents = exactCents(toReceiver);
    const r = await createVerificationIntent(o.stripe, { amountCents: cents, txHash: settled.hash, network: o.stripeNetwork,
      metadata: { agentkoin_payment_info_hash: key, agentkoin_verdict_digest: v03.verdictDigestV03(chainId, o.arbiterV03, v), agentkoin_arbiter_version: "0.3", agentkoin_settlement_step: step } });
    stripe = { status: "called", httpStatus: r.status, paymentIntentId: r.body?.id ?? null, verification: r.ok ? r.body.status : "rejected",
      settlementTx: settled.hash, settlementStep: step, amountCents: cents, apiVersion: o.stripe.version, apiVersionStatus: "unverified", error: r.ok ? null : r.body?.error ?? r.body };
  }
  const outcome = sdk.describeOutcome(await pc.readContract({ address: o.arbiterV03, abi: ARB, functionName: "outcome", args: [key] }) as any);

  return {
    schema: "agentkoin.receipt/0.1", arbiterVersion: "0.3", chainId, escrow: o.escrow, arbiter: o.arbiterV03, token: o.usdc,
    paymentInfoHash: key, termsHash: th, payer: payer.address, receiver, submitter: seller.address,
    stripeDepositAddress: receiver, stripeDepositAddressId: depositAddressId, receiverMode: "arbiter_v03_direct" as const,
    amounts: { authorizedAtomic: o.amount.toString(), capturedToReceiverAtomic: toReceiver.toString(), refundedToPayerAtomic: toPayer.toString(), toSubmitterAtomic: toSeller.toString() },
    txs, settlementTx: settled.hash, settlementStep: step, captureTransferCount: captureTransfers.length,
    verdict: { ...v, digest: v03.verdictDigestV03(chainId, o.arbiterV03, v), signer: evaluator.address, deliverableHash },
    outcome, stripe,
  };
}
