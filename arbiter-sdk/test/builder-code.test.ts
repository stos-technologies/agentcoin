import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex, toBytes, parseAbi, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { Attribution } from "ox/erc8021";
import * as sdk from "../src/index.ts";

// ERC-8021 example txData||"baseapp"||7||0||marker. NOTE: the wallet-developer example on docs.base.org shows
// 0x0762617365617070 0080218021... (length byte before the code), which disagrees with the ERC text and ox; the ERC order is used.
const DOC_VECTOR = "0x62617365617070" + "07" + "00" + "8021".repeat(8);
const BC = "0x" + Buffer.from("bc_ta422vae").toString("hex") + "0b00" + "8021".repeat(8);

test("encoding matches ERC-8021 example and ox reference", () => {
  assert.equal(sdk.encodeBuilderCodeSuffix("baseapp"), DOC_VECTOR);
  assert.equal(sdk.encodeBuilderCodeSuffix("bc_ta422vae"), BC);
  assert.equal(sdk.encodeBuilderCodeSuffix("bc_ta422vae"), Attribution.toDataSuffix({ codes: ["bc_ta422vae"] }));
  const multi = sdk.encodeBuilderCodeSuffix(["bc_ta422vae", "bc_other001"]);
  assert.equal(multi, Attribution.toDataSuffix({ codes: ["bc_ta422vae", "bc_other001"] }));
  assert.equal(multi.slice(2, 2 + 23 * 2), Buffer.from("bc_ta422vae,bc_other001").toString("hex"));
  assert.equal(multi.slice(-34, -32), "00");
  assert.equal(multi.slice(-32), "8021".repeat(8));
  assert.equal(multi.slice(-36, -34), "17"); // 23 bytes
});

test("rejects empty and invalid codes", () => {
  for (const bad of ["", [], ["a", ""], "has space", "a,b", "caf\u00e9", "x".repeat(256)]) assert.throws(() => sdk.encodeBuilderCodeSuffix(bad as any), /builder code/);
});

test("decode round-trips and ignores plain calldata", () => {
  const data = sdk.appendBuilderCodeSuffix("0xdeadbeef", ["bc_ta422vae", "z"]);
  assert.deepEqual(sdk.decodeBuilderCodeSuffix(data)?.codes, ["bc_ta422vae", "z"]);
  assert.equal(sdk.decodeBuilderCodeSuffix("0xdeadbeef"), null);
  assert.equal(sdk.decodeBuilderCodeSuffix(DOC_VECTOR)?.codes[0], "baseapp");
});

test("append is a strict no-op for null, undefined, empty", () => {
  for (const c of [null, undefined, "", []]) assert.equal(sdk.appendBuilderCodeSuffix("0xdeadbeef", c as any), "0xdeadbeef");
  assert.equal(sdk.appendBuilderCodeSuffix("0xdeadbeef", "bc_ta422vae"), "0xdeadbeef" + BC.slice(2));
});

test("resolveBuilderCode: default, env, explicit, opt-outs", () => {
  assert.equal(sdk.DEFAULT_BASE_BUILDER_CODE, "bc_ta422vae");
  assert.equal(sdk.resolveBuilderCode(undefined, {}), "bc_ta422vae");
  assert.equal(sdk.resolveBuilderCode(undefined, { BASE_BUILDER_CODE: "bc_envcode01" }), "bc_envcode01");
  assert.equal(sdk.resolveBuilderCode("bc_explicit1", { BASE_BUILDER_CODE: "bc_envcode01" }), "bc_explicit1");
  for (const v of ["", "none", "NONE", "0"]) assert.equal(sdk.resolveBuilderCode(undefined, { BASE_BUILDER_CODE: v }), null, v);
  assert.equal(sdk.resolveBuilderCode(null, {}), null);
  assert.equal(sdk.resolveBuilderCode("", {}), null);
  assert.equal(sdk.builderDataSuffix(undefined, { BASE_BUILDER_CODE: "none" }), undefined);
  assert.equal(sdk.builderDataSuffix(undefined, {}), BC);
});

test("buildArbiterTx appends only when a code resolves", () => {
  const abi = parseAbi(["function finalize((address,address,address,address,uint120,uint48,uint48,uint48,uint16,uint16,address,uint256) info)"]);
  const abi2 = parseAbi(["function ping(uint256 x)"]);
  const on = sdk.buildArbiterTx({ address: "0x0000000000000000000000000000000000000001", abi: abi2, functionName: "ping", args: [1n], env: {} });
  const off = sdk.buildArbiterTx({ address: "0x0000000000000000000000000000000000000001", abi: abi2, functionName: "ping", args: [1n], builderCode: null });
  assert.equal(on.data, off.data + BC.slice(2));
  assert.equal(off.builderCode, null);
  void abi;
});

// ---- anvil: real arbiter v0.2 call with the suffix appended ----
const OUT = path.resolve(import.meta.dirname, "..", "..", "out");
const PORT = 8641, RPC = `http://127.0.0.1:${PORT}`, CHAIN_ID = 31337;
const MN = "test test test test test test test test test test test junk";
const acc = (i: number) => mnemonicToAccount(MN, { addressIndex: i });
const [deployer, payer, receiver, evaluator] = [acc(0), acc(1), acc(2), acc(3)];
const chain = defineChain({ id: CHAIN_ID, name: "local", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC), cacheTime: 0, pollingInterval: 100 });
const wc = (a: ReturnType<typeof acc>) => createWalletClient({ account: a, chain, transport: http(RPC) });
const art = (f: string, n = f) => JSON.parse(readFileSync(path.join(OUT, `${f}.sol`, `${n}.json`), "utf8"));
const ARB = art("AgentKoinAuthCaptureArbiter"), ESC = art("AuthCaptureEscrow"), REG = art("EvaluatorRegistry");
const erc = parseAbi(["function approve(address,uint256) returns (bool)", "function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]);
let anvil: ChildProcess;
let usdc: Address, registry: Address, escrow: Address, collector: Address, arbiter: Address;
async function deploy(f: string, args: unknown[]): Promise<Address> {
  const a = art(f);
  return (await pc.waitForTransactionReceipt({ hash: await wc(deployer).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }) })).contractAddress as Address;
}
async function send(a: ReturnType<typeof acc>, address: Address, abi: any, functionName: string, args: unknown[], dataSuffix?: Hex) {
  const { request } = await pc.simulateContract({ address, abi, functionName, args, account: a, dataSuffix } as any);
  const hash = await wc(a).writeContract({ ...request, dataSuffix } as any);
  const r = await pc.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", functionName);
  return hash;
}
before(async () => {
  anvil = spawn(path.join(homedir(), ".foundry/bin/anvil"), ["--port", String(PORT), "--chain-id", String(CHAIN_ID), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  usdc = await deploy("MockUSDC", []);
  registry = await deploy("EvaluatorRegistry", [usdc, { minStake: 2_000_000n, unbondingPeriod: 604800n, exposureMultiplier: 5, slashHarmedShareBps: 5000, treasury: deployer.address }, deployer.address, [], 0n]);
  escrow = await deploy("AuthCaptureEscrow", []);
  collector = await deploy("ERC3009PaymentCollector", [escrow, "0x000000000000000000000000000000000000ca11"]);
  arbiter = await deploy("AgentKoinAuthCaptureArbiter", [escrow, registry, sdk.ZERO, usdc, 1_000_000n,
    { evalWindow: 3600, challengeWindow: 600, rulingWindow: 86400, minMarginSeconds: 3600, missedVerdictSlashBps: 1000, wrongVerdictSlashBps: 2500, materialDiffBps: 2000, minChallengeBond: 500_000n }]);
  await send(deployer, registry, REG.abi, "proposeSlasher", [arbiter, true]);
  await send(deployer, registry, REG.abi, "executeSlasher", [arbiter]);
  await send(deployer, usdc, erc, "mint", [payer.address, 10_000_000n]);
  await send(deployer, usdc, erc, "mint", [evaluator.address, 2_000_000n]);
  await send(evaluator, usdc, erc, "approve", [registry, 2_000_000n]);
  await send(evaluator, registry, REG.abi, "stake", [2_000_000n]);
});
after(() => { anvil?.kill(); });

test("anvil: submit with bc_ta422vae suffix executes on arbiter v0.2; suffix is in tx input; no suffix when disabled", async () => {
  for (const [nonce, code] of [[0x11n, undefined], [0x12n, null]] as const) {
    const now = Number((await pc.getBlock()).timestamp);
    const terms: sdk.Terms = { evaluator: evaluator.address, criteriaHash: keccak256(toHex("c")), scheduleHash: keccak256(toHex("s")), requiredTotal: 4,
      bpsTable: sdk.packBpsTable([0, 2500, 5000, 7500, 10000]), submitBy: now + 3600, evalWindow: 21600 };
    const p = sdk.buildPaymentInfo({ arbiter, payer: payer.address, receiver: receiver.address, token: usdc, maxAmount: 1_000_000n, preApprovalExpiry: now + 600, authorizationExpiry: now + 3 * 86400, terms, saltNonce: nonce });
    const td = sdk.receiveWithAuthorizationTypedData({ p, chainId: CHAIN_ID, escrow, collector, tokenName: "Mock USDC (test only)", tokenVersion: "2" });
    const suffix = sdk.builderDataSuffix(code, {});
    await send(acc(5), arbiter, ARB.abi, "authorize", [p, p.maxAmount, collector, await payer.signTypedData(td)], suffix);
    await send(evaluator, arbiter, ARB.abi, "bindTerms", [p, terms, nonce], suffix);
    const digest = sdk.resultDigestJson({ n: Number(nonce) });
    const hash = await send(receiver, arbiter, ARB.abi, "submit", [p, keccak256(toHex("d")), digest], suffix);
    const key = sdk.paymentInfoHash(p, CHAIN_ID, escrow);
    const rec = await pc.readContract({ address: arbiter, abi: ARB.abi, functionName: "getPayment", args: [key] }) as any;
    assert.equal(rec.state, 3, "Submitted");
    const tx = await pc.getTransaction({ hash });
    const dec = sdk.decodeBuilderCodeSuffix(tx.input);
    if (code === null) assert.equal(dec, null);
    else { assert.deepEqual(dec?.codes, ["bc_ta422vae"]); assert.ok(tx.input.endsWith(BC.slice(2))); }
  }
});
