// Lifecycle: authorize -> bindTerms -> submit -> verdictBySig -> (optional recordBuyerAcceptance) -> finalize
// -> (optional forward) -> Stripe transaction_verification -> unified AgentKoin receipt.
// Contract ABIs come from ../../out (run `forge build` in the repo root). All transactions go to opts.rpcUrl.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex, toBytes, parseAbi, parseAbiItem, parseEventLogs, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as sdk from "../../arbiter-sdk/src/index.ts";
import { createVerificationIntent, usdcToCents, type StripeConfig } from "./stripe.mts";

const OUT = path.resolve(import.meta.dirname, "..", "..", "out");
const art = (f: string) => JSON.parse(readFileSync(path.join(OUT, `${f}.sol`, `${f}.json`), "utf8"));
const transferEvt = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)"]);

export type LifecycleOpts = {
  rpcUrl: string; chainId?: number; escrow: Address; arbiter: Address; usdc: Address; collector: Address;
  tokenName: string; tokenVersion: string;
  stripeDepositAddress: Address; stripe: StripeConfig | null; stripeNetwork?: string;
  keys: { payer: Hex; evaluator: Hex; seller: Hex; relayer: Hex };
  amount: bigint; passMask: number; buyerAcceptance?: "accepted" | "rejected" | null;
  /** receiver = seller key address; seller forwards captured USDC to the deposit address (works with real Stripe addresses). */
  forwardToDeposit?: boolean;
  /** receiver = deposit address; anvil impersonates it for submit(). Local anvil only: a Stripe-held address cannot sign. */
  impersonateReceiver?: boolean;
  timeTravel?: boolean; saltNonce?: bigint; result?: unknown;
};

export async function runLifecycle(o: LifecycleOpts) {
  const chainId = o.chainId ?? (await createPublicClient({ transport: http(o.rpcUrl) }).getChainId());
  const chain = defineChain({ id: chainId, name: "demo", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [o.rpcUrl] } } });
  const pc = createPublicClient({ chain, transport: http(o.rpcUrl), cacheTime: 0, pollingInterval: 200 });
  const acct = (k: Hex) => privateKeyToAccount(k);
  const [payer, evaluator, seller, relayer] = [o.keys.payer, o.keys.evaluator, o.keys.seller, o.keys.relayer].map(acct);
  const ARB = art("AgentKoinAuthCaptureArbiter").abi;
  const txs: Record<string, Hex | null> = { authorize: null, bindTerms: null, submit: null, verdict: null, buyerAcceptance: null, finalize: null, forward: null };
  const send = async (who: any, address: Address, abi: any, functionName: string, args: unknown[]) => {
    const wallet = createWalletClient({ account: who, chain, transport: http(o.rpcUrl) });
    const { request } = await pc.simulateContract({ address, abi, functionName, args, account: who } as any);
    const hash = await wallet.writeContract(request as any);
    const rc = await pc.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${functionName} reverted`);
    return { hash, rc };
  };

  if (o.impersonateReceiver && o.forwardToDeposit) throw new Error("impersonateReceiver and forwardToDeposit are exclusive");
  const receiver: Address = o.forwardToDeposit ? seller.address : o.stripeDepositAddress;
  let sellerSender: any = seller;
  if (receiver !== seller.address) {
    if (!o.impersonateReceiver) throw new Error("RECEIVER_CANNOT_SUBMIT: arbiter.submit requires msg.sender == receiver; a Stripe deposit address has no signer. Use forwardToDeposit or (anvil only) impersonateReceiver.");
    await pc.request({ method: "anvil_impersonateAccount" as any, params: [receiver] as any });
    await pc.request({ method: "anvil_setBalance" as any, params: [receiver, "0xDE0B6B3A7640000"] as any });
    sellerSender = receiver;
  }

  const now = Number((await pc.getBlock()).timestamp);
  const terms: sdk.Terms = { evaluator: evaluator.address, criteriaHash: keccak256(toHex("stripe-x402-demo/criteria")), scheduleHash: keccak256(toHex("stripe-x402-demo/schedule")),
    requiredTotal: 4, bpsTable: sdk.packBpsTable([0, 2500, 5000, 7500, 10000]), submitBy: now + 3600, evalWindow: 21600 };
  const saltNonce = o.saltNonce ?? BigInt(keccak256(toHex(`${now}-${Math.random()}`)));
  const p = sdk.buildPaymentInfo({ arbiter: o.arbiter, payer: payer.address, receiver, token: o.usdc, maxAmount: o.amount, preApprovalExpiry: now + 600, authorizationExpiry: now + 3 * 86400, terms, saltNonce });
  const key = sdk.paymentInfoHash(p, chainId, o.escrow);
  const th = sdk.termsHash(terms);

  const sig = await payer.signTypedData(sdk.receiveWithAuthorizationTypedData({ p, chainId, escrow: o.escrow, collector: o.collector, tokenName: o.tokenName, tokenVersion: o.tokenVersion }));
  txs.authorize = (await send(relayer, o.arbiter, ARB, "authorize", [p, p.maxAmount, o.collector, sig])).hash;
  txs.bindTerms = (await send(evaluator, o.arbiter, ARB, "bindTerms", [p, terms, saltNonce])).hash;
  const result = o.result ?? { job: "stripe-x402-demo", output: "deliverable" };
  const digest = sdk.resultDigestJson(result);
  const deliverableHash = keccak256(toHex("stripe-x402-demo/deliverable"));
  txs.submit = (await send(sellerSender, o.arbiter, ARB, "submit", [p, deliverableHash, digest])).hash;

  const v = sdk.buildVerdict({ paymentInfoHash: key, terms, deliverableHash, resultDigest: digest, passMask: o.passMask, reasonHash: keccak256(toHex("stripe-x402-demo/reason")) });
  const vsig = await evaluator.signTypedData(sdk.verdictTypedData(chainId, o.arbiter, v));
  txs.verdict = (await send(relayer, o.arbiter, ARB, "verdictBySig", [p, v, vsig])).hash;

  let acceptance: any = null;
  if (o.buyerAcceptance) {
    const a: sdk.BuyerAcceptance = { paymentInfoHash: key, termsHash: th, resultDigest: digest, decision: o.buyerAcceptance === "accepted" ? 1 : 2, noteHash: keccak256(toHex("stripe-x402-demo/note")) };
    const asig = await payer.signTypedData(sdk.buyerAcceptanceTypedData(chainId, o.arbiter, a));
    txs.buyerAcceptance = (await send(relayer, o.arbiter, ARB, "recordBuyerAcceptance", [p, a, asig])).hash;
    acceptance = { decision: o.buyerAcceptance, noteHash: a.noteHash, digest: sdk.buyerAcceptanceDigest(chainId, o.arbiter, a), signer: payer.address };
  }

  const cfg = (await pc.readContract({ address: o.arbiter, abi: ARB, functionName: "config" }) as any);
  if (o.timeTravel) { await pc.request({ method: "evm_increaseTime" as any, params: [Number(cfg.challengeWindow) + 1] as any }); await pc.request({ method: "evm_mine" as any, params: [] as any }); }
  const fin = await send(relayer, o.arbiter, ARB, "finalize", [p]);
  txs.finalize = fin.hash;
  const transfers = parseEventLogs({ abi: [transferEvt], logs: fin.rc.logs }).filter((l) => l.address.toLowerCase() === o.usdc.toLowerCase());
  const sum = (to: Address) => transfers.filter((l) => l.args.to.toLowerCase() === to.toLowerCase()).reduce((s, l) => s + l.args.value, 0n);
  const toReceiver = sum(receiver), toPayer = sum(payer.address);

  let stripeTx: Hex | null = null; let settled = toReceiver;
  if (o.forwardToDeposit && toReceiver > 0n) {
    txs.forward = (await send(seller, o.usdc, erc20, "transfer", [o.stripeDepositAddress, toReceiver])).hash; stripeTx = txs.forward;
  } else if (toReceiver > 0n) stripeTx = txs.finalize;

  let stripe: any = { status: "not_called", reason: toReceiver === 0n ? "zero_capture" : "stripe_not_configured", paymentIntentId: null, verification: null };
  if (stripeTx && o.stripe) {
    const r = await createVerificationIntent(o.stripe, { amountCents: usdcToCents(settled), txHash: stripeTx, network: o.stripeNetwork,
      metadata: { agentkoin_payment_info_hash: key, agentkoin_verdict_digest: sdk.verdictDigest(chainId, o.arbiter, v) } });
    stripe = { status: "called", httpStatus: r.status, paymentIntentId: r.body?.id ?? null, verification: r.ok ? r.body.status : "rejected",
      settlementTx: stripeTx, amountCents: usdcToCents(settled), apiVersion: o.stripe.version, apiVersionStatus: "unverified", error: r.ok ? null : r.body?.error ?? r.body };
  }
  const outcome = sdk.describeOutcome(await pc.readContract({ address: o.arbiter, abi: ARB, functionName: "outcome", args: [key] }) as any);

  return {
    schema: "agentkoin.receipt/0.1", chainId, escrow: o.escrow, arbiter: o.arbiter, token: o.usdc,
    paymentInfoHash: key, termsHash: th, payer: payer.address, receiver, stripeDepositAddress: o.stripeDepositAddress,
    receiverMode: o.forwardToDeposit ? "seller_forward" : "deposit_address_direct",
    amounts: { authorizedAtomic: o.amount.toString(), capturedToReceiverAtomic: toReceiver.toString(), refundedToPayerAtomic: toPayer.toString() },
    txs,
    verdict: { ...v, digest: sdk.verdictDigest(chainId, o.arbiter, v), signer: evaluator.address, deliverableHash },
    buyerAcceptance: acceptance, outcome, stripe,
  };
}
