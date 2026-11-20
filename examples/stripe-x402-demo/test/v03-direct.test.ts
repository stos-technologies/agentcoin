// Local only: fresh anvil (loopback, chain 31337) + local mock Stripe. No real Stripe or public-network calls.
// v0.3 zero-hop: the mock-issued deposit address is info.receiver and never signs anything (no key exists and
// anvil_impersonateAccount is never called); the seller EOA submits as Terms.submitter.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, toHex, keccak256, parseAbi, parseAbiItem, parseEventLogs, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import * as sdk from "../../../arbiter-sdk/src/index.ts";
import * as v03 from "../../../arbiter-sdk/src/v03.ts";
import { runLifecycleV03, isWholeCents, exactCents, type LifecycleV03Opts } from "../lifecycle-v03.mts";
import { startMockStripe, type MockStripe } from "../mock-stripe.mts";
import { createVerificationIntent, stripePost, verificationParams } from "../stripe.mts";

const OUT = path.resolve(import.meta.dirname, "..", "..", "..", "out");
const PORT = 8652, RPC = `http://127.0.0.1:${PORT}`, CHAIN_ID = 31337;
const MN = "test test test test test test test test test test test junk";
const acc = (i: number) => mnemonicToAccount(MN, { addressIndex: i });
const pk = (i: number) => toHex(acc(i).getHdKey().privateKey!) as Hex;
const [deployer, payer, seller, evaluator] = [acc(0), acc(1), acc(2), acc(3)];
const chain = defineChain({ id: CHAIN_ID, name: "local", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC), cacheTime: 0, pollingInterval: 100 });
const art = (f: string) => JSON.parse(readFileSync(path.join(OUT, `${f}.sol`, `${f}.json`), "utf8"));
const erc = parseAbi(["function approve(address,uint256) returns (bool)", "function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]);
const transferEvt = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
let anvil: ChildProcess; let usdc: Address, escrow: Address, collector: Address, arbiterV03: Address, arbiterV03Arb: Address, arbitrator: Address;
let mock: MockStripe;
const send = async (a: ReturnType<typeof acc>, address: Address, abi: any, functionName: string, args: unknown[]) => {
  const { request } = await pc.simulateContract({ address, abi, functionName, args, account: a } as any);
  await pc.waitForTransactionReceipt({ hash: await createWalletClient({ account: a, chain, transport: http(RPC) }).writeContract(request) });
};
const deploy = async (f: string, args: unknown[]) => { const a = art(f); return (await pc.waitForTransactionReceipt({ hash: await createWalletClient({ account: deployer, chain, transport: http(RPC) }).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }) })).contractAddress as Address; };
const bal = (a: Address) => pc.readContract({ address: usdc, abi: erc, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
const stripeCfg = () => ({ apiBase: mock.url, secretKey: "mock_secret_key", version: "2026-07-29.preview" });

before(async () => {
  anvil = spawn(path.join(homedir(), ".foundry/bin/anvil"), ["--port", String(PORT), "--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  usdc = await deploy("MockUSDC", []);
  const registry = await deploy("EvaluatorRegistry", [usdc, { minStake: 2_000_000n, unbondingPeriod: 604800n, exposureMultiplier: 5, slashHarmedShareBps: 5000, treasury: deployer.address }, deployer.address, [], 0n]);
  escrow = await deploy("AuthCaptureEscrow", []);
  collector = await deploy("ERC3009PaymentCollector", [escrow, "0x000000000000000000000000000000000000ca11"]);
  arbiterV03 = await deploy("AgentKoinAuthCaptureArbiterV03", [escrow, registry, sdk.ZERO, usdc, 1_000_000n,
    { evalWindow: 3600, challengeWindow: 600, rulingWindow: 86400, minMarginSeconds: 3600, missedVerdictSlashBps: 1000, wrongVerdictSlashBps: 2500, materialDiffBps: 2000, minChallengeBond: 500_000n }]);
  arbitrator = await deploy("MockArbitrator", [deployer.address, 300_000n]);
  arbiterV03Arb = await deploy("AgentKoinAuthCaptureArbiterV03", [escrow, registry, arbitrator, usdc, 1_000_000n,
    { evalWindow: 3600, challengeWindow: 600, rulingWindow: 86400, minMarginSeconds: 3600, missedVerdictSlashBps: 1000, wrongVerdictSlashBps: 2500, materialDiffBps: 2000, minChallengeBond: 500_000n }]);
  const reg = art("EvaluatorRegistry").abi;
  for (const a of [arbiterV03, arbiterV03Arb]) {
    await send(deployer, registry, reg, "proposeSlasher", [a, true]);
    await send(deployer, registry, reg, "executeSlasher", [a]);
  }
  await send(deployer, usdc, erc, "mint", [seller.address, 2_000_000n]);
  await send(deployer, usdc, erc, "mint", [payer.address, 100_000_000n]);
  await send(deployer, usdc, erc, "mint", [evaluator.address, 2_000_000n]);
  await send(evaluator, usdc, erc, "approve", [registry, 2_000_000n]);
  await send(evaluator, registry, reg, "stake", [2_000_000n]);
  mock = await startMockStripe({ rpcUrl: RPC, usdc }); // no knownDeposit: only mock-issued addresses count
});
after(async () => { anvil?.kill(); await mock?.close(); });

const base = (): LifecycleV03Opts => ({
  rpcUrl: RPC, chainId: CHAIN_ID, escrow, arbiterV03, usdc, collector, tokenName: "Mock USDC (test only)", tokenVersion: "2",
  stripe: stripeCfg(), keys: { payer: pk(1), evaluator: pk(3), seller: pk(2), relayer: pk(5) }, amount: 1_000_000n, passMask: 0xf, timeTravel: true,
});

test("arbiter_v03_direct: mock deposit address is the receiver, seller submits, one capture tx, Stripe verifies it", async () => {
  const sellerBefore = await bal(seller.address);
  const r = await runLifecycleV03(base());
  const dep = r.receiver;
  assert.ok(r.stripeDepositAddressId?.startsWith("cda_mock_"));
  assert.equal(mock.requests.filter((q) => q.path === "/v1/crypto/deposit_addresses").length, 1);
  // keyless: no code, not an anvil-managed account, never sent a tx
  assert.equal(await pc.getCode({ address: dep }) ?? "0x", "0x");
  const accounts = (await pc.request({ method: "eth_accounts" as any }) as string[]).map((a) => a.toLowerCase());
  assert.ok(!accounts.includes(dep.toLowerCase()));
  assert.equal(await pc.getTransactionCount({ address: dep }), 0);
  for (const h of Object.values(r.txs)) if (h) assert.notEqual((await pc.getTransaction({ hash: h })).from.toLowerCase(), dep.toLowerCase());
  // submit came from the seller EOA
  assert.equal((await pc.getTransaction({ hash: r.txs.submit! })).from.toLowerCase(), seller.address.toLowerCase());
  assert.equal(r.receiverMode, "arbiter_v03_direct"); assert.equal(r.arbiterVersion, "0.3");
  const rec = await pc.readContract({ address: arbiterV03, abi: art("AgentKoinAuthCaptureArbiterV03").abi, functionName: "getPayment", args: [r.paymentInfoHash] }) as any;
  assert.equal(rec.termsHash, r.termsHash, "on-chain termsHash (includes submitter) equals the SDK hash");
  assert.equal(rec.submitter.toLowerCase(), seller.address.toLowerCase());
  // one capture tx straight to the deposit address
  assert.equal(await bal(dep), 1_000_000n);
  assert.equal(await bal(seller.address), sellerBefore, "seller never held the funds");
  assert.deepEqual(r.amounts, { authorizedAtomic: "1000000", capturedToReceiverAtomic: "1000000", refundedToPayerAtomic: "0", toSubmitterAtomic: "0" });
  assert.equal(r.captureTransferCount, 1);
  const fin = await pc.getTransactionReceipt({ hash: r.txs.settlement! });
  const t = parseEventLogs({ abi: [transferEvt], logs: fin.logs }).filter((l) => l.address.toLowerCase() === usdc.toLowerCase());
  assert.equal(t.length, 1); assert.equal(t[0]!.args.to.toLowerCase(), dep.toLowerCase()); assert.equal(t[0]!.args.value, 1_000_000n);
  assert.equal(r.verdict.digest, v03.verdictDigestV03(CHAIN_ID, arbiterV03, r.verdict));
  assert.equal(r.outcome.settledBy, "verdict"); assert.equal(r.outcome.payoutBps, 10000);
  // Stripe recorded the finalize (capture) tx
  assert.equal(r.settlementStep, "finalize"); assert.equal(r.stripe.settlementStep, "finalize");
  assert.equal(r.stripe.verification, "succeeded"); assert.match(r.stripe.paymentIntentId, /^pi_mock_/);
  assert.equal(r.stripe.settlementTx, r.txs.settlement); assert.equal(r.stripe.amountCents, 100);
  const pi = mock.requests.filter((q) => q.path === "/v1/payment_intents").at(-1)!;
  assert.equal(pi.form["payment_method_options[crypto][mode]"], "transaction_verification");
  assert.equal(pi.form["payment_method_options[crypto][transaction_verification_options][transaction_hash]"], r.txs.settlement);
  assert.equal(pi.headers["idempotency-key"], r.txs.settlement);
  assert.equal(pi.form["metadata[agentkoin_arbiter_version]"], "0.3");
  // negative: Stripe refuses to verify a tx with no capture to the deposit address (the submit tx), and a wrong amount
  const noTransfer = await createVerificationIntent(stripeCfg(), { amountCents: 100, txHash: r.txs.submit! });
  assert.equal(noTransfer.status, 400); assert.match(noTransfer.body.error.message, /no USDC transfer to a deposit address/);
  const wrongAmount = await stripePost(stripeCfg(), "/v1/payment_intents", verificationParams({ amountCents: 99, txHash: r.txs.settlement! }), `${r.txs.settlement}-wrong-amount`);
  assert.equal(wrongAmount.status, 400); assert.equal(wrongAmount.body.error.code, "invalid_amount"); assert.match(wrongAmount.body.error.message, /amount mismatch/);
});

test("negative: only the submitter may submit; the receiver, payer and a relayer are refused", async () => {
  const dep = (await (await fetch(`${mock.url}/v1/crypto/deposit_addresses`, { method: "POST", headers: { Authorization: `Basic ${Buffer.from("mock_secret_key:").toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "network=base" })).json()).address as Address;
  const now = Number((await pc.getBlock()).timestamp);
  const terms: v03.TermsV03 = { evaluator: evaluator.address, criteriaHash: keccak256(toHex("c")), scheduleHash: keccak256(toHex("s")), requiredTotal: 4,
    bpsTable: sdk.packBpsTable([0, 2500, 5000, 7500, 10000]), submitBy: now + 3600, evalWindow: 21600, submitter: seller.address };
  const p = v03.buildPaymentInfoV03({ arbiter: arbiterV03, payer: payer.address, receiver: dep, token: usdc, maxAmount: 1_000_000n, preApprovalExpiry: now + 600, authorizationExpiry: now + 3 * 86400, terms, saltNonce: 77n });
  const sig = await payer.signTypedData(sdk.receiveWithAuthorizationTypedData({ p, chainId: CHAIN_ID, escrow, collector, tokenName: "Mock USDC (test only)", tokenVersion: "2" }));
  await send(acc(5), arbiterV03, v03.ARBITER_V03_ABI, "authorize", [p, p.maxAmount, collector, sig]);
  // terms with a different submitter do not match the buyer-signed salt
  await assert.rejects(pc.simulateContract({ address: arbiterV03, abi: v03.ARBITER_V03_ABI, functionName: "bindTerms", args: [p, v03.termsV03Args({ ...terms, submitter: acc(6).address }), 77n], account: evaluator }), /SaltMismatch/);
  await send(evaluator, arbiterV03, v03.ARBITER_V03_ABI, "bindTerms", [p, v03.termsV03Args(terms), 77n]);
  const d = sdk.resultDigestJson({ x: 1 });
  for (const who of [payer, acc(5), evaluator]) {
    await assert.rejects(pc.simulateContract({ address: arbiterV03, abi: v03.ARBITER_V03_ABI, functionName: "submit", args: [p, keccak256(toHex("d")), d], account: who }), /Unauthorized/);
  }
  // eth_call from the receiver address (no signature needed for a call; a real tx from it is impossible without its key)
  await assert.rejects(pc.simulateContract({ address: arbiterV03, abi: v03.ARBITER_V03_ABI, functionName: "submit", args: [p, keccak256(toHex("d")), d], account: dep }), /Unauthorized/);
  await send(seller, arbiterV03, v03.ARBITER_V03_ABI, "submit", [p, keccak256(toHex("d")), d]);
});

test("negative: zero-pass verdict refunds the payer, nothing reaches the deposit address, Stripe is not called", async () => {
  const n = mock.requests.filter((q) => q.path === "/v1/payment_intents").length;
  const r = await runLifecycleV03({ ...base(), passMask: 0 });
  assert.equal(await bal(r.receiver), 0n);
  assert.deepEqual(r.amounts, { authorizedAtomic: "1000000", capturedToReceiverAtomic: "0", refundedToPayerAtomic: "1000000", toSubmitterAtomic: "0" });
  assert.equal(r.stripe.status, "not_called");
  assert.equal(mock.requests.filter((q) => q.path === "/v1/payment_intents").length, n);
});

test("negative: a non-whole-cent partial capture is not sent to Stripe, and the mock rejects it as invalid_amount", async () => {
  const n = mock.requests.filter((q) => q.path === "/v1/payment_intents").length;
  const r = await runLifecycleV03({ ...base(), amount: 999_990n, passMask: 0x1 }); // 25% of 999_990 -> 249_997 atomic (not whole cents)
  const captured = BigInt(r.amounts.capturedToReceiverAtomic);
  assert.equal(captured, 249_997n);
  assert.equal(await bal(r.receiver), captured);
  assert.equal(isWholeCents(captured), false);
  assert.throws(() => exactCents(captured), /NON_WHOLE_CENT_AMOUNT/);
  assert.deepEqual([r.stripe.status, r.stripe.reason], ["not_called", "non_whole_cent_amount"]);
  assert.equal(mock.requests.filter((q) => q.path === "/v1/payment_intents").length, n, "helper never floors and calls Stripe");
  // The mock refuses the floored amount (24 cents) for that tx: no silent flooring there either.
  const floored = await stripePost(stripeCfg(), "/v1/payment_intents", verificationParams({ amountCents: 24, txHash: r.txs.settlement! }), r.txs.settlement!);
  assert.equal(floored.status, 400); assert.equal(floored.body.error.code, "invalid_amount"); assert.match(floored.body.error.message, /non-whole-cent/);
  assert.equal(isWholeCents(9_999n), false); assert.equal(isWholeCents(10_000n), true); assert.equal(isWholeCents(0n), false);
});

test("dispute: payer challenges, ruling window lapses, resolveStaleDispute captures to the deposit address, Stripe verifies that tx", async () => {
  const r = await runLifecycleV03({ ...base(), arbiterV03: arbiterV03Arb, passMask: 0x3, // 50%
    dispute: { challenger: "payer", arbitrator, arbitratorOwnerKey: pk(0), stale: true } });
  assert.equal(r.settlementStep, "resolveStaleDispute");
  const tx = await pc.getTransaction({ hash: r.txs.settlement! });
  assert.equal(tx.to?.toLowerCase(), arbiterV03Arb.toLowerCase());
  assert.equal(await bal(r.receiver), 500_000n); assert.equal(r.captureTransferCount, 1);
  assert.equal(r.stripe.verification, "succeeded"); assert.equal(r.stripe.settlementTx, r.txs.settlement); assert.equal(r.stripe.amountCents, 50);
  const pi = mock.requests.filter((q) => q.path === "/v1/payment_intents").at(-1)!;
  assert.equal(pi.form["metadata[agentkoin_settlement_step]"], "resolveStaleDispute");
});

test("dispute: seller (submitter) challenges, arbitrator overturns, rule() capture tx is what Stripe verifies", async () => {
  const r = await runLifecycleV03({ ...base(), arbiterV03: arbiterV03Arb, passMask: 0x1, // verdict 25%, ruled 100%
    dispute: { challenger: "seller", arbitrator, arbitratorOwnerKey: pk(0), ruling: 10_000 } });
  assert.equal(r.settlementStep, "rule");
  const tx = await pc.getTransaction({ hash: r.txs.settlement! });
  assert.equal(tx.to?.toLowerCase(), arbitrator.toLowerCase(), "giveRuling -> arbiter.rule() -> capture in one tx");
  assert.notEqual(r.txs.settlement, r.txs.verdict);
  assert.equal(await bal(r.receiver), 1_000_000n); assert.equal(r.captureTransferCount, 1);
  assert.equal(r.outcome.payoutBps, 10_000);
  assert.equal(r.stripe.verification, "succeeded"); assert.equal(r.stripe.settlementStep, "rule"); assert.equal(r.stripe.amountCents, 100);
  const pi = mock.requests.filter((q) => q.path === "/v1/payment_intents").at(-1)!;
  assert.equal(pi.form["payment_method_options[crypto][transaction_verification_options][transaction_hash]"], r.txs.settlement);
});
