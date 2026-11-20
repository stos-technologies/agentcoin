// Local only: fresh anvil (loopback, chain 31337) + local mock Stripe HTTP server. No real Stripe or public-network calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, toHex, parseAbi, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import * as sdk from "../../../arbiter-sdk/src/index.ts";
import { runLifecycle, type LifecycleOpts } from "../lifecycle.mts";
import { startMockStripe, type MockStripe } from "../mock-stripe.mts";
import { runProbe } from "../probe-stripe-verification.mts";

const OUT = path.resolve(import.meta.dirname, "..", "..", "..", "out");
const PORT = 8651, RPC = `http://127.0.0.1:${PORT}`, CHAIN_ID = 31337;
const MN = "test test test test test test test test test test test junk";
const acc = (i: number) => mnemonicToAccount(MN, { addressIndex: i });
const pk = (i: number) => toHex(acc(i).getHdKey().privateKey!) as Hex;
const [deployer, payer, , evaluator] = [acc(0), acc(1), acc(2), acc(3)];
const chain = defineChain({ id: CHAIN_ID, name: "local", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC), cacheTime: 0, pollingInterval: 100 });
const art = (f: string) => JSON.parse(readFileSync(path.join(OUT, `${f}.sol`, `${f}.json`), "utf8"));
const erc = parseAbi(["function approve(address,uint256) returns (bool)", "function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]);
const DEPOSIT = "0x00000000000000000000000000000000de905171" as Address;
let anvil: ChildProcess; let usdc: Address, escrow: Address, collector: Address, arbiter: Address;
let mock: MockStripe;
const send = async (a: ReturnType<typeof acc>, address: Address, abi: any, functionName: string, args: unknown[]) => {
  const { request } = await pc.simulateContract({ address, abi, functionName, args, account: a } as any);
  await pc.waitForTransactionReceipt({ hash: await createWalletClient({ account: a, chain, transport: http(RPC) }).writeContract(request) });
};
const deploy = async (f: string, args: unknown[]) => { const a = art(f); return (await pc.waitForTransactionReceipt({ hash: await createWalletClient({ account: deployer, chain, transport: http(RPC) }).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }) })).contractAddress as Address; };
const bal = (a: Address) => pc.readContract({ address: usdc, abi: erc, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

before(async () => {
  anvil = spawn(path.join(homedir(), ".foundry/bin/anvil"), ["--port", String(PORT), "--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  usdc = await deploy("MockUSDC", []);
  const registry = await deploy("EvaluatorRegistry", [usdc, { minStake: 2_000_000n, unbondingPeriod: 604800n, exposureMultiplier: 5, slashHarmedShareBps: 5000, treasury: deployer.address }, deployer.address, [], 0n]);
  escrow = await deploy("AuthCaptureEscrow", []);
  collector = await deploy("ERC3009PaymentCollector", [escrow, "0x000000000000000000000000000000000000ca11"]);
  arbiter = await deploy("AgentKoinAuthCaptureArbiter", [escrow, registry, sdk.ZERO, usdc, 1_000_000n,
    { evalWindow: 3600, challengeWindow: 600, rulingWindow: 86400, minMarginSeconds: 3600, missedVerdictSlashBps: 1000, wrongVerdictSlashBps: 2500, materialDiffBps: 2000, minChallengeBond: 500_000n }]);
  const reg = art("EvaluatorRegistry").abi;
  await send(deployer, registry, reg, "proposeSlasher", [arbiter, true]);
  await send(deployer, registry, reg, "executeSlasher", [arbiter]);
  await send(deployer, usdc, erc, "mint", [payer.address, 100_000_000n]);
  await send(deployer, usdc, erc, "mint", [evaluator.address, 2_000_000n]);
  await send(evaluator, usdc, erc, "approve", [registry, 2_000_000n]);
  await send(evaluator, registry, reg, "stake", [2_000_000n]);
  mock = await startMockStripe({ rpcUrl: RPC, usdc, knownDeposit: DEPOSIT });
});
after(async () => { anvil?.kill(); await mock?.close(); });

const base = (): LifecycleOpts => ({
  rpcUrl: RPC, chainId: CHAIN_ID, escrow, arbiter, usdc, collector, tokenName: "Mock USDC (test only)", tokenVersion: "2",
  stripeDepositAddress: DEPOSIT, stripe: { apiBase: mock.url, secretKey: "mock_secret_key", version: "2026-07-29.preview" },
  keys: { payer: pk(1), evaluator: pk(3), seller: pk(2), relayer: pk(5) }, amount: 1_000_000n, passMask: 0xf, impersonateReceiver: true, timeTravel: true,
});
const piCalls = () => mock.requests.filter((r) => r.path === "/v1/payment_intents");

test("pass: 100% capture reaches the deposit address, mock Stripe verifies, receipt links everything", async () => {
  const before = await bal(DEPOSIT); const n = piCalls().length;
  const r = await runLifecycle(base());
  assert.equal(await bal(DEPOSIT) - before, 1_000_000n);
  assert.equal(r.schema, "agentkoin.receipt/0.1");
  assert.deepEqual(r.amounts, { authorizedAtomic: "1000000", capturedToReceiverAtomic: "1000000", refundedToPayerAtomic: "0" });
  assert.equal(r.receiver, DEPOSIT);
  assert.equal(r.verdict.payoutBps, 10000);
  assert.equal(r.verdict.digest, sdk.verdictDigest(CHAIN_ID, arbiter, r.verdict));
  assert.equal(r.outcome.settledBy, "verdict"); assert.equal(r.outcome.payoutBps, 10000);
  assert.equal(r.buyerAcceptance, null);
  assert.equal(r.stripe.verification, "succeeded"); assert.match(r.stripe.paymentIntentId, /^pi_mock_/);
  assert.equal(r.stripe.settlementTx, r.txs.finalize);
  const calls = piCalls().slice(n); assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.headers["stripe-version"], "2026-07-29.preview"); assert.equal(c.headers["idempotency-key"], r.txs.finalize);
  assert.equal(c.form.amount, "100"); assert.equal(c.form.currency, "usd"); assert.equal(c.form.confirm, "true");
  assert.equal(c.form["payment_method_data[type]"], "crypto"); assert.equal(c.form["allowed_payment_method_types[]"], "crypto");
  assert.equal(c.form["payment_method_options[crypto][mode]"], "transaction_verification");
  assert.equal(c.form["payment_method_options[crypto][transaction_verification_options][network]"], "base");
  assert.equal(c.form["payment_method_options[crypto][transaction_verification_options][transaction_hash]"], r.txs.finalize);
  assert.equal(c.form["metadata[agentkoin_payment_info_hash]"], r.paymentInfoHash);
  assert.equal(c.form["metadata[agentkoin_verdict_digest]"], r.verdict.digest);
});

test("partial: 50% to deposit address, 50% refunded to payer, BuyerAcceptance in receipt", async () => {
  const bd = await bal(DEPOSIT), bp = await bal(payer.address); const n = piCalls().length;
  const r = await runLifecycle({ ...base(), passMask: 0b0011, buyerAcceptance: "accepted" });
  assert.equal(await bal(DEPOSIT) - bd, 500_000n); assert.equal(bp - await bal(payer.address), 500_000n); // net of the 1_000_000 hold
  assert.deepEqual(r.amounts, { authorizedAtomic: "1000000", capturedToReceiverAtomic: "500000", refundedToPayerAtomic: "500000" });
  assert.equal(r.verdict.payoutBps, 5000);
  assert.equal(r.buyerAcceptance.decision, "accepted");
  assert.equal(r.buyerAcceptance.digest, sdk.buyerAcceptanceDigest(CHAIN_ID, arbiter, { paymentInfoHash: r.paymentInfoHash, termsHash: r.termsHash, resultDigest: r.verdict.resultDigest, decision: 1, noteHash: r.buyerAcceptance.noteHash }));
  assert.equal(r.outcome.buyerAcceptance, "accepted"); assert.ok(r.txs.buyerAcceptance);
  assert.equal(piCalls().slice(n)[0]!.form.amount, "50");
  assert.equal(r.stripe.verification, "succeeded");
});

test("fail: 0% void refunds payer in full and makes no Stripe settlement call", async () => {
  const bd = await bal(DEPOSIT), bp = await bal(payer.address); const n = piCalls().length;
  const r = await runLifecycle({ ...base(), passMask: 0 });
  assert.equal(await bal(DEPOSIT), bd); assert.equal(await bal(payer.address) - bp, 0n); // net: payer funded then got everything back
  assert.deepEqual(r.amounts, { authorizedAtomic: "1000000", capturedToReceiverAtomic: "0", refundedToPayerAtomic: "1000000" });
  assert.equal(r.verdict.payoutBps, 0);
  assert.deepEqual([r.stripe.status, r.stripe.reason, r.stripe.paymentIntentId], ["not_called", "zero_capture", null]);
  assert.equal(piCalls().length, n);
});

test("seller_forward mode: payout lands at seller, forward tx is what Stripe records", async () => {
  const bd = await bal(DEPOSIT);
  const r = await runLifecycle({ ...base(), impersonateReceiver: false, forwardToDeposit: true });
  assert.equal(r.receiverMode, "seller_forward"); assert.equal(r.receiver, acc(2).address);
  assert.equal(await bal(DEPOSIT) - bd, 1_000_000n);
  assert.ok(r.txs.forward); assert.equal(r.stripe.settlementTx, r.txs.forward); assert.equal(r.stripe.verification, "succeeded");
});

test("direct deposit-address receiver without impersonation is refused (submit needs receiver signer)", async () => {
  await assert.rejects(runLifecycle({ ...base(), impersonateReceiver: false }), /RECEIVER_CANNOT_SUBMIT/);
});

test("Stripe rejection is reported, not hidden", async () => {
  const m2 = await startMockStripe({ rpcUrl: RPC, usdc, knownDeposit: DEPOSIT, failVerification: true });
  try {
    const r = await runLifecycle({ ...base(), stripe: { apiBase: m2.url, secretKey: "mock_secret_key", version: "v" } });
    assert.equal(r.stripe.verification, "rejected"); assert.equal(r.stripe.paymentIntentId, null); assert.ok(r.stripe.error);
  } finally { await m2.close(); }
});

test("probe --dry-run makes no network calls and prints the planned requests", async () => {
  const before = mock.requests.length;
  const o = await runProbe(["--dry-run", "--create-deposit-address"], { STRIPE_API_BASE: mock.url });
  assert.equal(o.mode, "dry-run"); assert.equal(o.result, "dry-run"); assert.equal(mock.requests.length, before);
  assert.deepEqual(o.steps.map((s: any) => s.name), ["stripe.createDepositAddress", "chain.authorize", "chain.capture", "stripe.createPaymentIntent"]);
  assert.equal(o.steps[3].planned.headers["Idempotency-Key"], "0x<capture tx hash>");
});

test("probe --broadcast --create-deposit-address against anvil + mock Stripe: capture() transfer accepted", async () => {
  const o = await runProbe(["--broadcast", "--create-deposit-address"], {
    RPC_URL: RPC, STRIPE_API_BASE: mock.url, STRIPE_SECRET_KEY: "mock_secret_key", PAYER_KEY: pk(1), OPERATOR_KEY: pk(6), CONFIRM_WAIT_MS: "0",
    ESCROW: escrow, COLLECTOR: collector, USDC: usdc, TOKEN_NAME: "Mock USDC (test only)", TOKEN_VERSION: "2",
  });
  assert.equal(o.result, "stripe_accepted_capture_transfer");
  assert.equal(o.steps[0].name, "stripe.createDepositAddress"); assert.equal(o.receiver, o.steps[0].attempts[0].response.address);
  const cap = o.steps.find((s: any) => s.name === "chain.capture");
  assert.equal(cap.transferToReceiver[0].value, "10000");
  assert.equal(o.steps.at(-1).attempts[0].response.status, "succeeded");
  assert.equal(await bal(o.receiver), 10_000n);
  const last = mock.requests.at(-1)!; assert.equal(last.headers["idempotency-key"], o.captureTxHash); assert.equal(last.form.amount, "1");
});

test("probe reports stripe_rejected when Stripe refuses", async () => {
  const m2 = await startMockStripe({ rpcUrl: RPC, usdc, knownDeposit: DEPOSIT, failVerification: true });
  try {
    const o = await runProbe(["--broadcast"], { RPC_URL: RPC, STRIPE_API_BASE: m2.url, STRIPE_SECRET_KEY: "mock_secret_key", STRIPE_DEPOSIT_ADDRESS: DEPOSIT, CONFIRM_WAIT_MS: "0", RETRY_WAIT_MS: "0", PAYER_KEY: pk(1), OPERATOR_KEY: pk(6), ESCROW: escrow, COLLECTOR: collector, USDC: usdc, TOKEN_NAME: "Mock USDC (test only)", TOKEN_VERSION: "2" });
    assert.equal(o.result, "stripe_rejected");
  } finally { await m2.close(); }
});
