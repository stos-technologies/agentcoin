#!/usr/bin/env node
// AgentKoin judge kit: find jobs assigned to this evaluator, run criteria checks, compute the pass mask, submit verdictScheduled.
// Default is --dry-run behaviour: nothing is signed or sent unless --send is given. Output: one JSON object per line on stdout.
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, PublicClient } from "viem";
import {
  DEFAULT_ESCROW, DEFAULT_RPC, STATES, escrowAbi, addr, j, sha256hex, jcs, makeClient, readJob, blockNow, evalWindowOf,
  deriveRequired, computeMask, runChecks, fetchDeliverable, deliverableUrlFrom, loadSource,
} from "./lib.ts";
import type { CriteriaDoc, Job } from "./lib.ts";

const log = (o: Record<string, unknown>) => console.log(j({ ts: Math.floor(Date.now() / 1000), ...o }));

const { values: a } = parseArgs({
  options: {
    rpc: { type: "string", default: process.env.JUDGE_RPC_URL ?? DEFAULT_RPC },
    escrow: { type: "string", default: process.env.JUDGE_ESCROW ?? DEFAULT_ESCROW },
    evaluator: { type: "string" },            // address; required when no key is supplied
    "key-file": { type: "string" },           // file containing a hex private key; or env JUDGE_PRIVATE_KEY
    criteria: { type: "string", multiple: true, default: [] }, // path or URL; matched to a job by sha256(bytes) == specHash
    "deliverable-url": { type: "string" },    // overrides the URL found in the criteria text
    job: { type: "string" },                  // a single job id; default scans from --from-job
    "from-job": { type: "string", default: "1" },
    send: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "allow-public": { type: "boolean", default: false }, // required with --send on a non-loopback RPC
    loop: { type: "boolean", default: false },
    interval: { type: "string", default: "30" },
    help: { type: "boolean", default: false },
  },
});
if (a.help) { console.log("usage: node src/judge.ts --criteria <file|url>... [--evaluator 0x..] [--key-file f] [--job N] [--send] [--allow-public] [--rpc url] [--escrow 0x..] [--loop --interval s]"); process.exit(0); }
if (a.send && a["dry-run"]) { console.error("--send and --dry-run are mutually exclusive"); process.exit(2); }
const SEND = a.send === true;

async function account() {
  const raw = a["key-file"] ? (await readFile(a["key-file"], "utf8")).trim() : process.env.JUDGE_PRIVATE_KEY?.trim();
  return raw ? privateKeyToAccount((raw.startsWith("0x") ? raw : "0x" + raw) as Hex) : null;
}
const acct = await account();
const me: Address | null = acct ? acct.address : a.evaluator ? addr(a.evaluator) : null;
if (!me) { console.error("need --evaluator <address> or a key (--key-file / JUDGE_PRIVATE_KEY)"); process.exit(2); }
if (acct && a.evaluator && addr(a.evaluator) !== acct.address) { console.error("--evaluator does not match key address"); process.exit(2); }
const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(a.rpc!).hostname);
if (SEND && !acct) { console.error("--send needs a key"); process.exit(2); }
if (SEND && !loopback && !a["allow-public"]) { console.error("--send to a non-loopback RPC needs --allow-public"); process.exit(2); }

const escrow = addr(a.escrow!);
const pc: PublicClient = makeClient(a.rpc!);

// criteria documents by sha256 of their bytes (specHash)
const docs = new Map<string, { doc: CriteriaDoc; src: string }>();
for (const src of a.criteria!) {
  const b = await loadSource(src);
  docs.set("0x" + sha256hex(b), { doc: JSON.parse(new TextDecoder().decode(b)), src });
}

type Outcome = Record<string, unknown>;
export async function judgeJob(id: bigint): Promise<Outcome> {
  const job: Job = await readJob(pc, escrow, id);
  const base = { event: "job", jobId: id, state: STATES[job.state], evaluator: job.evaluator };
  if (job.evaluator.toLowerCase() !== me!.toLowerCase()) return { ...base, action: "skip", reason: "not-assigned" };
  if (STATES[job.state] !== "Submitted") return { ...base, action: "skip", reason: "state-not-submitted" };
  const sch = (await pc.readContract({ address: escrow, abi: escrowAbi, functionName: "getSchedule", args: [id] })) as unknown as { docHash: Hex; requiredTotal: number };
  if (/^0x0+$/.test(sch.docHash)) return { ...base, action: "skip", reason: "unscheduled-job (use verdict(), not supported by this kit)" };
  const window = await evalWindowOf(pc, escrow, job.configVersion);
  const deadline = job.submittedAt + window;
  const remaining = Number(deadline - (await blockNow(pc)));
  const timing = { submittedAt: job.submittedAt, evalWindow: window, deadline, remainingSeconds: remaining };
  if (remaining < 0) return { ...base, ...timing, action: "skip", reason: "window-closed" };

  const entry = docs.get(job.specHash.toLowerCase());
  if (!entry) return { ...base, ...timing, action: "skip", reason: "no-criteria-for-specHash", specHash: job.specHash };
  const required = deriveRequired(entry.doc);
  if (required.length !== sch.requiredTotal) return { ...base, ...timing, action: "skip", reason: "required-total-mismatch", derived: required.length, onchain: sch.requiredTotal };
  const url = a["deliverable-url"] ?? deliverableUrlFrom(entry.doc);
  if (!url) return { ...base, ...timing, action: "skip", reason: "no-deliverable-url" };

  const { fetched, error } = await fetchDeliverable(url);
  const results = runChecks(entry.doc, { url, fetched, fetchError: error });
  const { passMask, requiredPass } = computeMask(required, results);
  const delivSha = fetched ? sha256hex(fetched.body) : null;
  const receipt = {
    schema: "agentkoin.acceptance-receipt/1", criteria_set: entry.doc.criteria_set, criteria_version: entry.doc.version,
    criteria_sha256: job.specHash.slice(2), job_id: id.toString(), escrow, deliverable_url: url,
    deliverable_sha256: delivSha, deliverable_sha256_matches_onchain: delivSha !== null && "0x" + delivSha === job.deliverableHash.toLowerCase(),
    http_status: fetched?.status ?? null, fetch_error: error,
    results: required.map((rid) => ({ id: rid, result: results[rid] })),
    required_total: required.length, required_pass: requiredPass, pass_mask: passMask,
  };
  const reasonHash = ("0x" + sha256hex(jcs(receipt))) as Hex;
  const args = [id, passMask, required.length, requiredPass, reasonHash] as const;
  const verdict = { fn: "verdictScheduled", passMask, requiredTotal: required.length, requiredPass, reasonHash };
  const out: Outcome = { ...base, ...timing, results, ...verdict, receipt };

  try {
    await pc.simulateContract({ address: escrow, abi: escrowAbi, functionName: "verdictScheduled", args, account: me! });
  } catch (e) { return { ...out, action: "simulation-failed", error: String((e as Error).message).split("\n")[0] }; }
  if (!SEND) return { ...out, action: "dry-run", simulated: "ok", sent: false };

  const wc = createWalletClient({ account: acct!, chain: pc.chain, transport: http(a.rpc!) });
  const hash = await wc.writeContract({ address: escrow, abi: escrowAbi, functionName: "verdictScheduled", args, chain: wc.chain });
  const rc = await pc.waitForTransactionReceipt({ hash });
  const tAfter = await blockNow(pc);
  return { ...out, action: "sent", sent: true, txHash: hash, status: rc.status, block: rc.blockNumber, withinWindow: rc.status === "success" && tAfter <= deadline };
}

async function scan() {
  const ids: bigint[] = [];
  if (a.job) ids.push(BigInt(a.job));
  else {
    const n = (await pc.readContract({ address: escrow, abi: escrowAbi, functionName: "jobCount" })) as bigint;
    for (let i = BigInt(a["from-job"]!); i <= n; i++) ids.push(i);
  }
  for (const id of ids) {
    try {
      const o = await judgeJob(id);
      if (o.action !== "skip" || a.job || process.env.JUDGE_VERBOSE) log(o);
    } catch (e) { log({ event: "job", jobId: id, action: "error", error: String((e as Error).message).split("\n")[0] }); }
  }
}

log({ event: "start", mode: SEND ? "send" : "dry-run", evaluator: me, escrow, rpcLoopback: loopback, criteriaLoaded: docs.size });
do { await scan(); if (a.loop) await new Promise((r) => setTimeout(r, Number(a.interval) * 1000)); } while (a.loop);
