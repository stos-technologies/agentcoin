// Local-only v0.3 parity: fresh anvil (loopback, 31337), deploy the v0.2 AND v0.3 arbiters side by side from
// ../out (run `forge build` first) and compare every v0.3 SDK hash with Solidity, check non-collision with
// v0.2, then run a zero-hop lifecycle (receiver = keyless address, submitter = seller EOA) with SDK-built
// payloads. Accounts: public anvil mnemonic.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex, parseAbi, toFunctionSelector, getAddress, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import * as sdk from "../src/index.ts";
import * as v03 from "../src/v03.ts";

const OUT = path.resolve(import.meta.dirname, "..", "..", "out");
const PORT = 8624, RPC = `http://127.0.0.1:${PORT}`, CHAIN_ID = 31337;
const MN = "test test test test test test test test test test test junk";
const acc = (i: number) => mnemonicToAccount(MN, { addressIndex: i });
const [deployer, payer, seller, evaluator] = [acc(0), acc(1), acc(2), acc(3)];
const DEPOSIT: Address = getAddress("0x00000000000000000000000000000000de905171"); // keyless stand-in for a Stripe deposit address
const chain = defineChain({ id: CHAIN_ID, name: "local", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC), cacheTime: 0, pollingInterval: 100 });
const wc = (a: ReturnType<typeof acc>) => createWalletClient({ account: a, chain, transport: http(RPC) });
const art = (f: string, n = f) => JSON.parse(readFileSync(path.join(OUT, `${f}.sol`, `${n}.json`), "utf8"));
const A02 = art("AgentKoinAuthCaptureArbiter");
const A03 = art("AgentKoinAuthCaptureArbiterV03");
const erc = parseAbi(["function approve(address,uint256) returns (bool)", "function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]);
const CFG = { evalWindow: 3600, challengeWindow: 600, rulingWindow: 86400, minMarginSeconds: 3600, missedVerdictSlashBps: 1000, wrongVerdictSlashBps: 2500, materialDiffBps: 2000, minChallengeBond: 500_000n };

let anvil: ChildProcess;
let usdc: Address, registry: Address, escrow: Address, collector: Address, arb02: Address, arb03: Address;

async function deploy(f: string, args: unknown[], n = f): Promise<Address> {
  const a = art(f, n);
  const hash = await wc(deployer).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  return (await pc.waitForTransactionReceipt({ hash })).contractAddress as Address;
}
async function send(a: ReturnType<typeof acc>, address: Address, abi: any, functionName: string, args: unknown[]) {
  const { request } = await pc.simulateContract({ address, abi, functionName, args, account: a });
  const r = await pc.waitForTransactionReceipt({ hash: await wc(a).writeContract(request) });
  assert.equal(r.status, "success", functionName);
  return r;
}
const read = (address: Address, abi: any, functionName: string, args: unknown[] = []) => pc.readContract({ address, abi, functionName, args }) as Promise<any>;

before(async () => {
  anvil = spawn(path.join(homedir(), ".foundry/bin/anvil"), ["--port", String(PORT), "--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  usdc = await deploy("MockUSDC", []);
  registry = await deploy("EvaluatorRegistry", [usdc, { minStake: 2_000_000n, unbondingPeriod: 604800n, exposureMultiplier: 5, slashHarmedShareBps: 5000, treasury: deployer.address }, deployer.address, [], 0n]);
  escrow = await deploy("AuthCaptureEscrow", []);
  collector = await deploy("ERC3009PaymentCollector", [escrow, "0x000000000000000000000000000000000000ca11"]);
  arb02 = await deploy("AgentKoinAuthCaptureArbiter", [escrow, registry, sdk.ZERO, usdc, 1_000_000n, CFG]);
  arb03 = await deploy("AgentKoinAuthCaptureArbiterV03", [escrow, registry, sdk.ZERO, usdc, 1_000_000n, CFG]);
  const regAbi = art("EvaluatorRegistry").abi;
  for (const a of [arb02, arb03]) {
    await send(deployer, registry, regAbi, "proposeSlasher", [a, true]);
    await send(deployer, registry, regAbi, "executeSlasher", [a]);
  }
  await send(deployer, usdc, erc, "mint", [payer.address, 10_000_000n]);
  await send(deployer, usdc, erc, "mint", [evaluator.address, 2_000_000n]);
  await send(evaluator, usdc, erc, "approve", [registry, 2_000_000n]);
  await send(evaluator, registry, regAbi, "stake", [2_000_000n]);
});
after(() => { anvil?.kill(); });

async function terms(submitter?: Address): Promise<v03.TermsV03> {
  const now = Number((await pc.getBlock()).timestamp);
  return {
    evaluator: evaluator.address, criteriaHash: keccak256(toHex("criteria.json")), scheduleHash: keccak256(toHex("schedule.json")),
    requiredTotal: 4, bpsTable: sdk.packBpsTable([0, 2500, 5000, 7500, 10000]), submitBy: now + 3600, evalWindow: 21600,
    ...(submitter ? { submitter } : {}),
  };
}

test("v0.3 constants, typehash and domain separator match Solidity and differ from v0.2", async () => {
  assert.equal(await read(arb03, v03.ARBITER_V03_ABI, "VERSION"), v03.VERSION_V03);
  assert.equal(await read(arb03, v03.ARBITER_V03_ABI, "EIP712_NAME"), v03.EIP712_NAME_V03);
  assert.equal(await read(arb03, v03.ARBITER_V03_ABI, "EIP712_VERSION"), v03.EIP712_VERSION_V03);
  assert.equal(await read(arb03, v03.ARBITER_V03_ABI, "TERMS_TYPEHASH"), v03.TERMS_V03_TYPEHASH);
  assert.notEqual(v03.TERMS_V03_TYPEHASH, sdk.TERMS_TYPEHASH);
  assert.equal(await read(arb02, A02.abi, "TERMS_TYPEHASH"), sdk.TERMS_TYPEHASH);
  assert.equal(await read(arb03, v03.ARBITER_V03_ABI, "domainSeparator"), v03.domainSeparatorV03(CHAIN_ID, arb03));
  const [, , version] = await read(arb03, A03.abi, "eip712Domain");
  assert.equal(version, "0.3");
  assert.notEqual(await read(arb02, A02.abi, "domainSeparator"), await read(arb03, A03.abi, "domainSeparator"));
  assert.notEqual(v03.domainSeparatorV03(CHAIN_ID, arb02), await read(arb02, A02.abi, "domainSeparator"), "0.3 domain never equals 0.2 domain at the same address");
});

test("SDK ABI selectors exist in the forge artifact", () => {
  const artifactSelectors = new Set(Object.values(A03.methodIdentifiers as Record<string, string>).map((s) => `0x${s}`));
  for (const item of v03.ARBITER_V03_ABI) if (item.type === "function") assert.ok(artifactSelectors.has(toFunctionSelector(item as any)), item.name);
});

test("hashTermsV03 / termsSalt / effectiveSubmitter match Solidity; submitter is bound; no collision with v0.2", async () => {
  for (const sub of [undefined, seller.address, acc(9).address]) {
    const t = await terms(sub);
    const th = v03.hashTermsV03(t);
    assert.equal(await read(arb03, v03.ARBITER_V03_ABI, "termsHash", [v03.termsV03Args(t)]), th);
    assert.equal(await read(arb03, v03.ARBITER_V03_ABI, "hashTerms", [v03.termsV03Args(t)]), th);
    const p = v03.buildPaymentInfoV03({ arbiter: arb03, payer: payer.address, receiver: DEPOSIT, token: usdc, maxAmount: 1_000_000n,
      preApprovalExpiry: t.submitBy - 3000, authorizationExpiry: t.submitBy + 3 * 86400, terms: t, saltNonce: 7n });
    assert.equal(await read(arb03, v03.ARBITER_V03_ABI, "termsSalt", [th, 7n]), p.salt);
    assert.equal((await read(arb03, v03.ARBITER_V03_ABI, "effectiveSubmitter", [p, v03.termsV03Args(t)])).toLowerCase(), v03.effectiveSubmitter(p, t).toLowerCase());
    assert.notEqual(th, sdk.termsHash(t), "v0.3 termsHash never equals v0.2 for the same fields");
  }
  const t0 = await terms();
  assert.equal(v03.hashTermsV03(t0), v03.hashTermsV03({ ...t0, submitter: sdk.ZERO }), "omitted submitter == zero");
  assert.notEqual(v03.hashTermsV03(t0), v03.hashTermsV03({ ...t0, submitter: seller.address }));
});

test("verdict and acceptance digests match Solidity and differ from v0.2 digests", async () => {
  const t = await terms(seller.address);
  const v = v03.buildVerdictV03({ paymentInfoHash: keccak256(toHex("k")), terms: t, deliverableHash: keccak256(toHex("d")),
    resultDigest: sdk.resultDigestJson({ a: 1 }), passMask: 0b0111, reasonHash: keccak256(toHex("r")) });
  assert.equal(v.payoutBps, 7500);
  assert.equal(v.termsHash, v03.hashTermsV03(t));
  assert.equal(await read(arb03, v03.ARBITER_V03_ABI, "verdictDigest", [v]), v03.verdictDigestV03(CHAIN_ID, arb03, v));
  const a: sdk.BuyerAcceptance = { paymentInfoHash: v.paymentInfoHash, termsHash: v.termsHash, resultDigest: v.resultDigest, decision: 1, noteHash: keccak256(toHex("n")) };
  assert.equal(await read(arb03, v03.ARBITER_V03_ABI, "buyerAcceptanceDigest", [a]), v03.buyerAcceptanceDigestV03(CHAIN_ID, arb03, a));
  assert.notEqual(v03.verdictDigestV03(CHAIN_ID, arb03, v), sdk.verdictDigest(CHAIN_ID, arb03, v));
  assert.notEqual(v03.buyerAcceptanceDigestV03(CHAIN_ID, arb03, a), sdk.buyerAcceptanceDigest(CHAIN_ID, arb03, a));
  assert.equal(await read(arb02, A02.abi, "verdictDigest", [v]), sdk.verdictDigest(CHAIN_ID, arb02, v), "v0.2 helpers still match v0.2");
});

test("checkBeforeSigningV03 flags evaluator == submitter", async () => {
  const cfg = { evalWindow: 3600, challengeWindow: 600, rulingWindow: 86400, minMarginSeconds: 3600 };
  const t = await terms(seller.address);
  const p = v03.buildPaymentInfoV03({ arbiter: arb03, payer: payer.address, receiver: DEPOSIT, token: usdc, maxAmount: 1_000_000n,
    preApprovalExpiry: t.submitBy - 3000, authorizationExpiry: t.submitBy + 3 * 86400, terms: t, saltNonce: 1n });
  assert.deepEqual(v03.checkBeforeSigningV03(p, t, cfg, 1n), []);
  const bad = { ...t, submitter: evaluator.address };
  const pb = { ...p, salt: v03.termsSalt(v03.hashTermsV03(bad), 1n) };
  assert.ok(v03.checkBeforeSigningV03(pb, bad, cfg, 1n).some((e) => e.includes("submitter")));
  assert.ok(v03.checkBeforeSigningV03(p, { ...t, submitter: acc(9).address }, cfg, 1n).some((e) => e.includes("salt")));
});

test("SubmitterIsPayer: SDK rejects submitter == payer and (submitter 0, receiver == payer); contract agrees", async () => {
  const cfg = { evalWindow: 3600, challengeWindow: 600, rulingWindow: 86400, minMarginSeconds: 3600 };
  const now = Number((await pc.getBlock()).timestamp);
  const args = (t: v03.TermsV03, receiver: Address) => ({ arbiter: arb03, payer: payer.address, receiver, token: usdc, maxAmount: 1_000_000n,
    preApprovalExpiry: now + 600, authorizationExpiry: now + 3 * 86400, terms: t, saltNonce: 31n });
  const asPayer = await terms(payer.address);
  const zero = await terms();
  const upper = { ...asPayer, submitter: payer.address.toLowerCase() as Address }; // case-insensitive vs checksummed payer
  for (const [t, r] of [[asPayer, DEPOSIT], [upper, DEPOSIT], [zero, payer.address.toLowerCase() as Address]] as const) {
    assert.ok(v03.submitterIsPayer({ payer: payer.address, receiver: r }, t));
    assert.throws(() => v03.buildPaymentInfoV03(args(t, r)), /SubmitterIsPayer/);
    const p = { ...v03.buildPaymentInfoV03(args({ ...t, submitter: seller.address }, r)), receiver: r, salt: v03.termsSalt(v03.hashTermsV03(t), 31n) };
    assert.ok(v03.checkBeforeSigningV03(p, t, cfg, 31n).some((e) => e.includes("SubmitterIsPayer")));
  }
  assert.ok(!v03.submitterIsPayer({ payer: payer.address, receiver: DEPOSIT }, zero));
  // On-chain: authorize with submitter == payer, bindTerms reverts SubmitterIsPayer.
  const p = { ...v03.buildPaymentInfoV03(args({ ...asPayer, submitter: seller.address }, DEPOSIT)), salt: v03.termsSalt(v03.hashTermsV03(asPayer), 31n) };
  const td = sdk.receiveWithAuthorizationTypedData({ p, chainId: CHAIN_ID, escrow, collector, tokenName: "Mock USDC (test only)", tokenVersion: "2" });
  await send(acc(5), arb03, v03.ARBITER_V03_ABI, "authorize", [p, p.maxAmount, collector, await payer.signTypedData(td)]);
  await assert.rejects(pc.simulateContract({ address: arb03, abi: v03.ARBITER_V03_ABI, functionName: "bindTerms", args: [p, v03.termsV03Args(asPayer), 31n], account: evaluator }), /SubmitterIsPayer/);
});

test("zero-hop on anvil: seller submits for a keyless receiver; SDK-signed verdict; finalize pays the receiver", async () => {
  const nonce = 0x03n;
  const t = await terms(seller.address);
  const p = v03.buildPaymentInfoV03({ arbiter: arb03, payer: payer.address, receiver: DEPOSIT, token: usdc, maxAmount: 1_000_000n,
    preApprovalExpiry: t.submitBy - 3000, authorizationExpiry: t.submitBy + 3 * 86400, terms: t, saltNonce: nonce });
  const td = sdk.receiveWithAuthorizationTypedData({ p, chainId: CHAIN_ID, escrow, collector, tokenName: "Mock USDC (test only)", tokenVersion: "2" });
  await send(acc(5), arb03, v03.ARBITER_V03_ABI, "authorize", [p, p.maxAmount, collector, await payer.signTypedData(td)]);
  const key = sdk.paymentInfoHash(p, CHAIN_ID, escrow);
  await send(evaluator, arb03, v03.ARBITER_V03_ABI, "bindTerms", [p, v03.termsV03Args(t), nonce]);
  const digest = sdk.resultDigestJson({ job: "zero-hop", output: "ok" });
  const dh = keccak256(toHex("deliverable"));
  await assert.rejects(pc.simulateContract({ address: arb03, abi: v03.ARBITER_V03_ABI, functionName: "submit", args: [p, dh, digest], account: payer }), /Unauthorized/);
  const tx = v03.buildArbiterV03Tx({ address: arb03, functionName: "submit", args: [p, dh, digest], builderCode: null });
  const r = await pc.waitForTransactionReceipt({ hash: await wc(seller).sendTransaction({ to: tx.to, data: tx.data as Hex }) });
  assert.equal(r.status, "success");
  const v = v03.buildVerdictV03({ paymentInfoHash: key, terms: t, deliverableHash: dh, resultDigest: digest, passMask: 0xf, reasonHash: keccak256(toHex("receipt")) });
  // A v0.2-domain signature over the same struct is rejected by v0.3.
  await assert.rejects(pc.simulateContract({ address: arb03, abi: v03.ARBITER_V03_ABI, functionName: "verdictBySig", args: [p, v, await evaluator.signTypedData(sdk.verdictTypedData(CHAIN_ID, arb03, v))], account: acc(5) }), /BadSignature/);
  await send(acc(5), arb03, v03.ARBITER_V03_ABI, "verdictBySig", [p, v, await evaluator.signTypedData(v03.verdictTypedDataV03(CHAIN_ID, arb03, v))]);
  await pc.request({ method: "evm_increaseTime" as any, params: [601] as any });
  await pc.request({ method: "evm_mine" as any, params: [] as any });
  await send(acc(6), arb03, v03.ARBITER_V03_ABI, "finalize", [p]);
  assert.equal(await read(usdc, erc, "balanceOf", [DEPOSIT]), 1_000_000n);
  assert.equal((await read(arb03, v03.ARBITER_V03_ABI, "outcome", [key])).payoutBps, 10000);
});

test("v0.3 vectors shared with the Python helpers (termsHash re-checked on Solidity)", async () => {
  const file = path.resolve(import.meta.dirname, "vectors.v03.json");
  const ARB_ADDR: Address = getAddress("0x00000000000000000000000000000000000a0003"); // placeholder: no v0.3 deployment exists
  const terms: v03.TermsV03 = { evaluator: "0x000f3e27EAf5d2C1A30F4fE50FF1bcC4A78f124A", criteriaHash: `0x${"22".repeat(32)}`, scheduleHash: `0x${"33".repeat(32)}`,
    requiredTotal: 4, bpsTable: sdk.packBpsTable([0, 2500, 5000, 7500, 10000]), submitBy: 1795798800, evalWindow: 21600, submitter: getAddress("0x00000000000000000000000000000000005e11e4") };
  const v = v03.buildVerdictV03({ paymentInfoHash: `0x${"11".repeat(32)}`, terms, deliverableHash: `0x${"44".repeat(32)}`, resultDigest: `0x${"55".repeat(32)}`, passMask: 0b1011, reasonHash: `0x${"66".repeat(32)}` });
  const a: sdk.BuyerAcceptance = { paymentInfoHash: v.paymentInfoHash, termsHash: v.termsHash, resultDigest: v.resultDigest, decision: 1, noteHash: `0x${"77".repeat(32)}` };
  assert.equal(await read(arb03, v03.ARBITER_V03_ABI, "termsHash", [v03.termsV03Args(terms)]), v03.hashTermsV03(terms));
  assert.equal(await read(arb03, v03.ARBITER_V03_ABI, "termsHash", [v03.termsV03Args({ ...terms, submitter: sdk.ZERO })]), v03.hashTermsV03({ ...terms, submitter: sdk.ZERO }));
  const got = {
    chainId: 84532, arbiter: ARB_ADDR, receiver: DEPOSIT,
    terms: { ...terms, bpsTable: `0x${terms.bpsTable.toString(16)}` }, termsHash: v03.hashTermsV03(terms),
    termsHashZeroSubmitter: v03.hashTermsV03({ ...terms, submitter: sdk.ZERO }),
    termsSalt42: `0x${v03.termsSalt(v03.hashTermsV03(terms), 42n).toString(16)}`,
    verdict: v, verdictDigest: v03.verdictDigestV03(84532, ARB_ADDR, v), verdictDigestV02Domain: sdk.verdictDigest(84532, ARB_ADDR, v),
    acceptance: a, acceptanceDigest: v03.buyerAcceptanceDigestV03(84532, ARB_ADDR, a),
    typehashes: { terms: v03.TERMS_V03_TYPEHASH, salt: v03.AGK_SALT_TYPEHASH, verdict: v03.OUTSIDE_VERDICT_TYPEHASH, acceptance: v03.BUYER_ACCEPTANCE_TYPEHASH },
  };
  if (process.env.UPDATE_VECTORS === "1") writeFileSync(file, JSON.stringify(got, null, 2) + "\n");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), JSON.parse(JSON.stringify(got)));
});
