// Local-only cross-check: spawn a fresh anvil (loopback, chain 31337), deploy MockUSDC, EvaluatorRegistry,
// the vendored commerce-payments AuthCaptureEscrow + ERC3009PaymentCollector and AgentKoinAuthCaptureArbiter
// from ../out (run `forge build` first), then compare every SDK hash with the Solidity result and run a real
// authorize -> bindTerms with a payload built and signed only by the SDK. Accounts: public anvil mnemonic.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes, toHex, parseAbi, type Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import * as sdk from "../src/index.ts";

const OUT = path.resolve(import.meta.dirname, "..", "..", "out");
const PORT = 8623, RPC = `http://127.0.0.1:${PORT}`, CHAIN_ID = 31337;
const MN = "test test test test test test test test test test test junk";
const acc = (i: number) => mnemonicToAccount(MN, { addressIndex: i });
const [deployer, payer, receiver, evaluator] = [acc(0), acc(1), acc(2), acc(3)];
const chain = defineChain({ id: CHAIN_ID, name: "local", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC), cacheTime: 0, pollingInterval: 100 });
const wc = (a: ReturnType<typeof acc>) => createWalletClient({ account: a, chain, transport: http(RPC) });
const art = (f: string, n = f) => JSON.parse(readFileSync(path.join(OUT, `${f}.sol`, `${n}.json`), "utf8"));
const ARB = art("AgentKoinAuthCaptureArbiter");
const ESC = art("AuthCaptureEscrow");
const erc = parseAbi(["function approve(address,uint256) returns (bool)", "function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]);

let anvil: ChildProcess;
let usdc: Address, registry: Address, escrow: Address, collector: Address, arbiter: Address;

async function deploy(f: string, args: unknown[], n = f): Promise<Address> {
  const a = art(f, n);
  const hash = await wc(deployer).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  return (await pc.waitForTransactionReceipt({ hash })).contractAddress as Address;
}
async function send(a: ReturnType<typeof acc>, address: Address, abi: any, functionName: string, args: unknown[]) {
  const { request } = await pc.simulateContract({ address, abi, functionName, args, account: a });
  const r = await pc.waitForTransactionReceipt({ hash: await wc(a).writeContract(request) });
  assert.equal(r.status, "success", functionName);
}
const read = (address: Address, abi: any, functionName: string, args: unknown[] = []) => pc.readContract({ address, abi, functionName, args }) as Promise<any>;

before(async () => {
  anvil = spawn(path.join(homedir(), ".foundry/bin/anvil"), ["--port", String(PORT), "--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  usdc = await deploy("MockUSDC", []);
  registry = await deploy("EvaluatorRegistry", [usdc, { minStake: 2_000_000n, unbondingPeriod: 604800n, exposureMultiplier: 5, slashHarmedShareBps: 5000, treasury: deployer.address }, deployer.address, [], 0n]);
  escrow = await deploy("AuthCaptureEscrow", []);
  collector = await deploy("ERC3009PaymentCollector", [escrow, "0x000000000000000000000000000000000000ca11"]);
  arbiter = await deploy("AgentKoinAuthCaptureArbiter", [escrow, registry, sdk.ZERO, usdc, 1_000_000n,
    { evalWindow: 3600, challengeWindow: 600, rulingWindow: 86400, minMarginSeconds: 3600, missedVerdictSlashBps: 1000, wrongVerdictSlashBps: 2500, materialDiffBps: 2000, minChallengeBond: 500_000n }]);
  const regAbi = art("EvaluatorRegistry").abi;
  await send(deployer, registry, regAbi, "proposeSlasher", [arbiter, true]);
  await send(deployer, registry, regAbi, "executeSlasher", [arbiter]);
  await send(deployer, usdc, erc, "mint", [payer.address, 10_000_000n]);
  await send(deployer, usdc, erc, "mint", [evaluator.address, 2_000_000n]);
  await send(evaluator, usdc, erc, "approve", [registry, 2_000_000n]);
  await send(evaluator, registry, regAbi, "stake", [2_000_000n]);
});
after(() => { anvil?.kill(); });

async function fixture(nonce: bigint) {
  const now = Number((await pc.getBlock()).timestamp);
  const terms: sdk.Terms = {
    evaluator: evaluator.address, criteriaHash: keccak256(toHex("criteria.json")), scheduleHash: keccak256(toHex("schedule.json")),
    requiredTotal: 4, bpsTable: sdk.packBpsTable([0, 2500, 5000, 7500, 10000]), submitBy: now + 3600, evalWindow: 21600,
  };
  const p = sdk.buildPaymentInfo({ arbiter, payer: payer.address, receiver: receiver.address, token: usdc, maxAmount: 1_000_000n,
    preApprovalExpiry: now + 600, authorizationExpiry: now + 3 * 86400, terms, saltNonce: nonce });
  return { terms, p };
}

test("typehashes and bps packing match Solidity", async () => {
  assert.equal(await read(arbiter, ARB.abi, "TERMS_TYPEHASH"), sdk.TERMS_TYPEHASH);
  assert.equal(await read(arbiter, ARB.abi, "AGK_SALT_TYPEHASH"), sdk.AGK_SALT_TYPEHASH);
  assert.equal(await read(escrow, ESC.abi, "PAYMENT_INFO_TYPEHASH"), sdk.PAYMENT_INFO_TYPEHASH);
  assert.equal(sdk.packBpsTable([0, 2500, 5000, 7500, 10000]), 0x27101d4c138809c40000n); // JobEscrow job 2 table
  assert.throws(() => sdk.packBpsTable([10000, 2500]));
});

test("termsHash, termsSalt, getHash and payer-agnostic nonce match on-chain", async () => {
  for (const nonce of [1n, 2n ** 255n + 12345n, 0n]) {
    const { terms, p } = await fixture(nonce);
    const th = sdk.termsHash(terms);
    assert.equal(await read(arbiter, ARB.abi, "termsHash", [terms]), th);
    assert.equal(await read(arbiter, ARB.abi, "termsSalt", [th, nonce]), p.salt);
    assert.equal(await read(escrow, ESC.abi, "getHash", [p]), sdk.paymentInfoHash(p, CHAIN_ID, escrow));
    assert.equal(await read(escrow, ESC.abi, "getHash", [{ ...p, payer: sdk.ZERO }]), sdk.payerAgnosticNonce(p, CHAIN_ID, escrow));
  }
});

test("checkBeforeSigning flags bad offers", async () => {
  const cfg = { evalWindow: 3600, challengeWindow: 600, rulingWindow: 86400, minMarginSeconds: 3600 };
  const { terms, p } = await fixture(9n);
  assert.deepEqual(sdk.checkBeforeSigning(p, terms, cfg, 9n), []);
  assert.ok(sdk.checkBeforeSigning({ ...p, maxFeeBps: 100 }, terms, cfg, 9n).length > 0);
  assert.ok(sdk.checkBeforeSigning({ ...p, authorizationExpiry: terms.submitBy + 100, refundExpiry: terms.submitBy + 100 }, terms, cfg, 9n).some((e) => e.includes("too early")));
  assert.ok(sdk.checkBeforeSigning(p, { ...terms, evaluator: receiver.address }, cfg, 9n).length > 0);
  assert.ok(sdk.checkBeforeSigning(p, terms, cfg, 10n).some((e) => e.includes("salt")));
});

test("SDK-built and SDK-signed payload passes authorize + bindTerms on the real contracts", async () => {
  const nonce = 0xabcdefn;
  const { terms, p } = await fixture(nonce);
  const td = sdk.receiveWithAuthorizationTypedData({ p, chainId: CHAIN_ID, escrow, collector, tokenName: "Mock USDC (test only)", tokenVersion: "2" });
  const sig = await payer.signTypedData(td);
  await send(acc(5), arbiter, ARB.abi, "authorize", [p, p.maxAmount, collector, sig]); // any relayer
  const key = sdk.paymentInfoHash(p, CHAIN_ID, escrow);
  const [, held] = await read(escrow, ESC.abi, "paymentState", [key]);
  assert.equal(held, 1_000_000n);
  await send(evaluator, arbiter, ARB.abi, "bindTerms", [p, terms, nonce]); // reverts SaltMismatch if any byte differs
  const rec = await read(arbiter, ARB.abi, "getPayment", [key]);
  assert.equal(rec.state, 2); // Bound
  assert.equal(rec.termsHash, sdk.termsHash(terms));
  assert.equal(await read(usdc, erc, "balanceOf", [arbiter]), 0n);
});

// ---------------- v0.2: resultDigest, OutsideVerdict, BuyerAcceptance (source only, local anvil) ----------------

test("v0.2 typehashes, domain and digests match Solidity", async () => {
  assert.equal(await read(arbiter, ARB.abi, "OUTSIDE_VERDICT_TYPEHASH"), sdk.OUTSIDE_VERDICT_TYPEHASH);
  assert.equal(await read(arbiter, ARB.abi, "BUYER_ACCEPTANCE_TYPEHASH"), sdk.BUYER_ACCEPTANCE_TYPEHASH);
  assert.equal(await read(arbiter, ARB.abi, "EIP712_NAME"), sdk.EIP712_NAME);
  assert.equal(await read(arbiter, ARB.abi, "EIP712_VERSION"), sdk.EIP712_VERSION);
  const { terms } = await fixture(3n);
  const v = sdk.buildVerdict({ paymentInfoHash: keccak256(toHex("k")), terms, deliverableHash: keccak256(toHex("d")),
    resultDigest: sdk.resultDigestJson({ a: 1 }), passMask: 0b0111, reasonHash: keccak256(toHex("r")) });
  assert.equal(v.payoutBps, 7500);
  assert.equal(await read(arbiter, ARB.abi, "verdictDigest", [v]), sdk.verdictDigest(CHAIN_ID, arbiter, v));
  const a: sdk.BuyerAcceptance = { paymentInfoHash: v.paymentInfoHash, termsHash: v.termsHash, resultDigest: v.resultDigest, decision: 1, noteHash: keccak256(toHex("n")) };
  assert.equal(await read(arbiter, ARB.abi, "buyerAcceptanceDigest", [a]), sdk.buyerAcceptanceDigest(CHAIN_ID, arbiter, a));
  assert.notEqual(sdk.verdictDigest(CHAIN_ID, arbiter, v), sdk.buyerAcceptanceDigest(CHAIN_ID, arbiter, a));
  const swappedA = { ...a, resultDigest: sdk.resultDigestJson({ a: 2 }) };
  assert.notEqual(sdk.buyerAcceptanceDigest(CHAIN_ID, arbiter, swappedA), sdk.buyerAcceptanceDigest(CHAIN_ID, arbiter, a));
  assert.equal(await read(arbiter, ARB.abi, "buyerAcceptanceDigest", [swappedA]), sdk.buyerAcceptanceDigest(CHAIN_ID, arbiter, swappedA));
});

test("sample terms file: Solidity termsHash equals the file's termsHash", async () => {
  const sample = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../examples/authcapture/terms.base-sepolia.json"), "utf8"));
  const t = sample.arbiterTerms;
  const onchain = await read(arbiter, ARB.abi, "termsHash", [{ ...t, bpsTable: BigInt(t.bpsTable) }]);
  assert.equal(onchain, t.termsHash);
  assert.equal(onchain, sample["outside-verdict"].termsHash);
});

test("v0.2 end to end: SDK-signed verdict relayed, capture on verdict reports buyer not accepted, then a separate acceptance", async () => {
  const nonce = 0x5eedn;
  const { terms, p } = await fixture(nonce);
  const td = sdk.receiveWithAuthorizationTypedData({ p, chainId: CHAIN_ID, escrow, collector, tokenName: "Mock USDC (test only)", tokenVersion: "2" });
  await send(acc(5), arbiter, ARB.abi, "authorize", [p, p.maxAmount, collector, await payer.signTypedData(td)]);
  const key = sdk.paymentInfoHash(p, CHAIN_ID, escrow);
  await send(evaluator, arbiter, ARB.abi, "bindTerms", [p, terms, nonce]);

  const result = { job: "sample", output: "hello" };
  const digest = sdk.resultDigestJson(result);
  assert.equal(digest, sdk.resultDigest(toBytes(sdk.canonicalJson(result))));
  const deliverableHash = keccak256(toHex("deliverable-locator"));
  await send(receiver, arbiter, ARB.abi, "submit", [p, deliverableHash, digest]);

  // A verdict over swapped bytes is refused.
  const swapped = sdk.buildVerdict({ paymentInfoHash: key, terms, deliverableHash, resultDigest: sdk.resultDigestJson({ ...result, output: "swapped" }), passMask: 0xf, reasonHash: keccak256(toHex("r")) });
  await assert.rejects(pc.simulateContract({ address: arbiter, abi: ARB.abi, functionName: "verdictBySig", args: [p, swapped, await evaluator.signTypedData(sdk.verdictTypedData(CHAIN_ID, arbiter, swapped))], account: acc(5) }), /ResultDigestMismatch/);

  const v = sdk.buildVerdict({ paymentInfoHash: key, terms, deliverableHash, resultDigest: digest, passMask: 0xf, reasonHash: keccak256(toHex("receipt")) });
  await send(acc(5), arbiter, ARB.abi, "verdictBySig", [p, v, await evaluator.signTypedData(sdk.verdictTypedData(CHAIN_ID, arbiter, v))]);
  await pc.request({ method: "evm_increaseTime" as any, params: [601] as any });
  await pc.request({ method: "evm_mine" as any, params: [] as any });
  await send(acc(6), arbiter, ARB.abi, "finalize", [p]);
  assert.equal(await read(usdc, erc, "balanceOf", [receiver.address]), 1_000_000n);
  let o = sdk.describeOutcome(await read(arbiter, ARB.abi, "outcome", [key]));
  assert.deepEqual(o, { settledBy: "verdict", payoutBps: 10000, resultDigest: digest, buyerAcceptance: null, buyerAccepted: false });

  const a: sdk.BuyerAcceptance = { paymentInfoHash: key, termsHash: sdk.termsHash(terms), resultDigest: digest, decision: 1, noteHash: keccak256(toHex("thanks")) };
  await send(acc(7), arbiter, ARB.abi, "recordBuyerAcceptance", [p, a, await payer.signTypedData(sdk.buyerAcceptanceTypedData(CHAIN_ID, arbiter, a))]);
  o = sdk.describeOutcome(await read(arbiter, ARB.abi, "outcome", [key]));
  assert.equal(o.buyerAcceptance, "accepted");
  assert.equal(o.buyerAccepted, true);
  assert.equal(await read(usdc, erc, "balanceOf", [receiver.address]), 1_000_000n, "acceptance moves no funds");
});

test("JCS and digest vectors (shared with the Python helpers)", async () => {
  const file = path.resolve(import.meta.dirname, "vectors.v02.json");
  const terms: sdk.Terms = { evaluator: "0x000f3e27EAf5d2C1A30F4fE50FF1bcC4A78f124A", criteriaHash: `0x${"22".repeat(32)}`, scheduleHash: `0x${"33".repeat(32)}`, requiredTotal: 4, bpsTable: sdk.packBpsTable([0, 2500, 5000, 7500, 10000]), submitBy: 1795798800, evalWindow: 21600 };
  const json = { z: [1, "é", true, null], a: { c: "\u2028", b: -0.5 }, "\u00e9": 1e21 };
  const v = sdk.buildVerdict({ paymentInfoHash: `0x${"11".repeat(32)}`, terms, deliverableHash: `0x${"44".repeat(32)}`, resultDigest: sdk.resultDigestJson(json), passMask: 0b1011, reasonHash: `0x${"66".repeat(32)}` });
  const a: sdk.BuyerAcceptance = { paymentInfoHash: v.paymentInfoHash, termsHash: v.termsHash, resultDigest: v.resultDigest, decision: 2, noteHash: `0x${"77".repeat(32)}` };
  const ARB_ADDR = "0x8b4B3A8c6389a17AA7f66e18F59Afb36Cc9C453A";
  const got = {
    chainId: 84532, arbiter: ARB_ADDR, json, jcs: sdk.canonicalJson(json), resultDigestJson: sdk.resultDigestJson(json),
    resultDigestBytes: sdk.resultDigest(toBytes("agentkoin sample result bytes v1")),
    terms: { ...terms, bpsTable: `0x${terms.bpsTable.toString(16)}` }, termsHash: sdk.termsHash(terms), termsSalt42: `0x${sdk.termsSalt(sdk.termsHash(terms), 42n).toString(16)}`,
    verdict: v, verdictDigest: sdk.verdictDigest(84532, ARB_ADDR, v), acceptance: a, acceptanceDigest: sdk.buyerAcceptanceDigest(84532, ARB_ADDR, a),
    typehashes: { terms: sdk.TERMS_TYPEHASH, salt: sdk.AGK_SALT_TYPEHASH, verdict: sdk.OUTSIDE_VERDICT_TYPEHASH, acceptance: sdk.BUYER_ACCEPTANCE_TYPEHASH },
  };
  if (process.env.UPDATE_VECTORS === "1") writeFileSync(file, JSON.stringify(got, null, 2) + "\n");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), JSON.parse(JSON.stringify(got)));
});
