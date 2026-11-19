// Local-only end-to-end tests: spawn a fresh anvil (chain id 84532, loopback), deploy v0.6 contracts from forge artifacts, run the kit and the watcher.
// Requires: anvil + `forge build` output in ../out. Accounts derive from the public anvil test mnemonic; nothing touches a public network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createWalletClient, createPublicClient, http, getContractAddress, defineChain, parseAbi } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.resolve(ROOT, "..", "out");
const PORT = 8611, RPC = `http://127.0.0.1:${PORT}`;
const MNEMONIC = "test test test test test test test test test test test junk";
const acc = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const [deployer, provider, evaluator, stranger] = [acc(0), acc(1), acc(2), acc(3)];
const chain = defineChain({ id: 84532, name: "local", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC), cacheTime: 0, pollingInterval: 100 });
const wc = (a: ReturnType<typeof acc>) => createWalletClient({ account: a, chain, transport: http(RPC) });
const art = (f: string, n: string) => JSON.parse(readFileSync(path.join(OUT, `${f}.sol`, `${n}.json`), "utf8"));
const erc = parseAbi(["function approve(address,uint256) returns (bool)", "function mint(address,uint256)"]);
const EW = 3600n;

let anvil: ChildProcess, server: Server, tmp: string, bodyMode: "good" | "wrong" = "good";
let usdc: Address, registry: Address, escrow: Address, criteriaPath: string, keyPath: string, evalCfgPath: string;
const GOOD = Buffer.from('{"job":2,"ok":true}\n');
const WRONG = Buffer.from('{"job":2,"ok":false}\n');
let url = "";

async function deploy(name: string, file: string, args: unknown[], nonce?: number): Promise<Address> {
  const a = art(file, name);
  const hash = await wc(deployer).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, ...(nonce !== undefined ? { nonce } : {}) });
  return (await pc.waitForTransactionReceipt({ hash })).contractAddress as Address;
}
const send = async (a: ReturnType<typeof acc>, address: Address, abi: any, functionName: string, args: unknown[]) => {
  const { request } = await pc.simulateContract({ address, abi, functionName, args, account: a });
  const r = await pc.waitForTransactionReceipt({ hash: await wc(a).writeContract(request) });
  assert.equal(r.status, "success");
};
const rpc = (method: string, params: unknown[] = []) => pc.request({ method, params } as any);
const warp = async (s: number) => { await rpc("evm_increaseTime", [s]); await rpc("evm_mine"); };
const run = (script: string, args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number; lines: any[]; stderr: string }>((res) =>
    execFile("node", [path.join(ROOT, "src", script), ...args], { env: { ...process.env, ...env } }, (err, so, se) =>
      res({ code: err ? ((err as any).code ?? 1) : 0, lines: so.split("\n").filter(Boolean).map((l) => JSON.parse(l)), stderr: se })));

let specHash: Hex;
async function newJob(): Promise<bigint> {
  const sched = { docHash: ("0x" + "11".repeat(32)) as Hex, requiredTotal: 4, bpsTable: 0x27101d4c138809c40000n }; // [0,2500,5000,7500,10000]
  const deadline = BigInt((await pc.getBlock()).timestamp) + 86400n;
  await send(deployer, escrow, art("JobEscrow", "JobEscrow").abi, "createAndFundScheduled", [provider.address, evaluator.address, 500000n, deadline, specHash, sched]);
  return (await pc.readContract({ address: escrow, abi: art("JobEscrow", "JobEscrow").abi, functionName: "jobCount" })) as bigint;
}
const submit = (id: bigint) => send(provider, escrow, art("JobEscrow", "JobEscrow").abi, "submit", [id, "0x" + createHash("sha256").update(GOOD).digest("hex")]);
const getJob = (id: bigint) => pc.readContract({ address: escrow, abi: art("JobEscrow", "JobEscrow").abi, functionName: "getJob", args: [id] }) as Promise<any>;
const kitArgs = (...x: string[]) => ["--rpc", RPC, "--escrow", escrow, "--criteria", criteriaPath, ...x];

before(async () => {
  anvil = spawn(path.join(homedir(), ".foundry/bin/anvil"), ["--port", String(PORT), "--chain-id", "84532", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  server = createServer((req, res) => { res.setHeader("content-type", "application/json; charset=utf-8"); res.end(bodyMode === "good" ? GOOD : WRONG); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as any).port}/deliverable.json`;

  usdc = await deploy("MockUSDC", "MockUSDC", []);
  const n = await pc.getTransactionCount({ address: deployer.address });
  const escrowAddr = getContractAddress({ from: deployer.address, nonce: BigInt(n + 1) });
  registry = await deploy("EvaluatorRegistry", "EvaluatorRegistry", [usdc, { minStake: 100000000n, unbondingPeriod: 604800n, exposureMultiplier: 5, slashHarmedShareBps: 5000, treasury: deployer.address }, deployer.address, [escrowAddr], 172800n]);
  escrow = await deploy("JobEscrow", "JobEscrow", [usdc, registry, deployer.address, "0x0000000000000000000000000000000000000000",
    { instantThreshold: 1000000n, minChallengeBond: 1000000n, evalWindow: EW, challengeWindow: 172800n, arbitrationTimeout: 2592000n, challengeBondBps: 500, missedVerdictSlashBps: 1000, wrongVerdictSlashBps: 2500, materialDiffBps: 2000, feeBps: 100, failedChallengeEvaluatorShareBps: 5000, instantBondCoverBps: 10000, evaluatorFeeBps: 50 }, deployer.address]);
  assert.equal(escrow.toLowerCase(), escrowAddr.toLowerCase());

  await send(deployer, usdc, erc, "mint", [deployer.address, 10_000_000_000n]);
  await send(deployer, usdc, erc, "mint", [evaluator.address, 1_000_000_000n]);
  await send(deployer, usdc, erc, "approve", [escrow, 10_000_000_000n]);
  await send(evaluator, usdc, erc, "approve", [registry, 1_000_000_000n]);
  await send(evaluator, registry, art("EvaluatorRegistry", "EvaluatorRegistry").abi, "stake", [100000000n]);

  tmp = mkdtempSync(path.join(tmpdir(), "judgekit-"));
  const jobCriteria = JSON.parse(readFileSync(path.resolve(ROOT, "..", "jobs/bbv-job2/criteria.json"), "utf8"));
  const want = createHash("sha256").update(GOOD).digest("hex");
  for (const c of jobCriteria.criteria) c.requirement = c.requirement.replace("https://agentcoinhq.com/jobs/2/deliverable.json", url).replace("0ffe1e736a820be339047399a28f365eccec6b423024c1865ed13a3b7c302d74", want);
  const bytes = JSON.stringify(jobCriteria);
  criteriaPath = path.join(tmp, "criteria.json"); writeFileSync(criteriaPath, bytes);
  specHash = ("0x" + createHash("sha256").update(bytes).digest("hex")) as Hex;
  keyPath = path.join(tmp, "eval.key"); // anvil test account #2 key, written to a temp file at test time
  writeFileSync(keyPath, Buffer.from(evaluator.getHdKey().privateKey!).toString("hex"));
});
after(() => { anvil?.kill(); server?.close(); });

test("kit dry-run: computes mask 15/4, simulates ok, sends nothing", async () => {
  const id = await newJob(); await submit(id);
  const r = await run("judge.ts", kitArgs("--evaluator", evaluator.address, "--job", String(id)));
  const o = r.lines.find((l) => l.event === "job");
  assert.equal(o.action, "dry-run"); assert.equal(o.simulated, "ok"); assert.equal(o.sent, false);
  assert.equal(o.passMask, 15); assert.equal(o.requiredPass, 4); assert.equal(o.requiredTotal, 4);
  assert.equal(o.receipt.deliverable_sha256_matches_onchain, true);
  assert.match(o.reasonHash, /^0x[0-9a-f]{64}$/);
  assert.equal((await getJob(id)).state, 3, "still Submitted after dry-run");
});

test("kit --send submits verdictScheduled within the evalWindow (full pass -> Completed 10000 bps)", async () => {
  const id = await newJob(); await submit(id); await warp(600);
  const r = await run("judge.ts", kitArgs("--key-file", keyPath, "--job", String(id), "--send"));
  const o = r.lines.find((l) => l.event === "job");
  assert.equal(o.action, "sent"); assert.equal(o.status, "success"); assert.equal(o.withinWindow, true);
  assert.ok(o.remainingSeconds > 2900 && o.remainingSeconds < 3100, "remaining ~3000s before send: " + o.remainingSeconds);
  const j = await getJob(id);
  assert.equal(j.state, 4); assert.equal(j.payoutBps, 10000); assert.equal(j.reasonHash, o.reasonHash);
});

test("kit --send with a failing check yields Partial (3/4 -> 7500 bps)", async () => {
  bodyMode = "wrong";
  const id = await newJob(); await submit(id);
  const r = await run("judge.ts", kitArgs("--key-file", keyPath, "--job", String(id), "--send"));
  bodyMode = "good";
  const o = r.lines.find((l) => l.event === "job");
  assert.equal(o.action, "sent"); assert.equal(o.requiredPass, 3); assert.equal(o.passMask, 0b1011);
  assert.equal(o.results["body-sha256"], "fail");
  const j = await getJob(id); assert.equal(j.state, 6); assert.equal(j.payoutBps, 7500);
});

test("kit refuses --send on a non-loopback RPC without --allow-public (no network contact)", async () => {
  const r = await run("judge.ts", ["--rpc", "https://sepolia.base.org", "--criteria", criteriaPath, "--key-file", keyPath, "--send"]);
  assert.equal(r.code, 2); assert.match(r.stderr, /allow-public/);
});

test("kit skips jobs whose evalWindow already closed", async () => {
  const id = await newJob(); await submit(id); await warp(3601);
  const r = await run("judge.ts", kitArgs("--evaluator", evaluator.address, "--job", String(id)));
  assert.equal(r.lines.find((l) => l.jobId === String(id) && l.reason)?.reason ?? "unset", "window-closed", JSON.stringify(r.lines));
});

test("watcher flags an approaching deadline, then a missed one; health check runs", async () => {
  const id = await newJob(); await submit(id);
  const hook: any[] = []; 
  const hs = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { hook.push(JSON.parse(b)); res.end("ok"); }); });
  await new Promise<void>((r) => hs.listen(0, "127.0.0.1", r));
  const w = `http://127.0.0.1:${(hs.address() as any).port}/`;
  const base = ["--rpc", RPC, "--escrow", escrow, "--from-job", String(id), "--webhook", w];

  let r = await run("watch.ts", base);
  assert.ok(r.lines.some((l) => l.event === "job" && l.status === "ok" && l.jobId === String(id)), "no alert with ~3600s left");
  assert.equal(r.lines.filter((l) => l.event === "alert").length, 0);

  await warp(3600 - 500); // ~500s left: crosses 600, not 120
  r = await run("watch.ts", base);
  const al = r.lines.filter((l) => l.event === "alert");
  assert.equal(al.length, 1); assert.equal(al[0].level, "approaching"); assert.equal(al[0].thresholdSeconds, 600); assert.equal(al[0].severity, "warning");
  assert.ok(al[0].remainingSeconds > 0 && al[0].remainingSeconds <= 500);
  const health = r.lines.find((l) => l.event === "evaluator-health");
  assert.equal(health.ok, true); assert.equal(health.active, true);

  await warp(450); // ~50s left: crosses 120 (critical)
  r = await run("watch.ts", base);
  assert.equal(r.lines.find((l) => l.event === "alert").severity, "critical");

  await warp(100); // past deadline
  r = await run("watch.ts", base);
  assert.equal(r.lines.find((l) => l.event === "alert").level, "missed");
  assert.equal(hook.length, 3, "webhook (local listener) received each alert");
  assert.equal(hook[2].level, "missed");
  hs.close();
});

test("health check flags an evaluator that left the registry (unbonding) while holding a job", async () => {
  const id = await newJob(); await submit(id);
  await send(evaluator, registry, art("EvaluatorRegistry", "EvaluatorRegistry").abi, "requestUnstake", []);
  const r = await run("watch.ts", ["--rpc", RPC, "--escrow", escrow, "--from-job", String(id), "--health-only"]);
  const h = r.lines.find((l) => l.event === "evaluator-health");
  assert.equal(h.ok, false); assert.ok(h.problems.includes("not-active-in-registry"), JSON.stringify(h));
  assert.equal(h.severity, "warning");
});
