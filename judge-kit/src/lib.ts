// Shared helpers: ABI, JCS, criteria handling, check runners, chain access. No network access except what the caller configures.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPublicClient, defineChain, http, parseAbi, getAddress } from "viem";
import type { Address, Hex, PublicClient } from "viem";

export const DEFAULT_ESCROW = "0xd6E00d3419C16a3bEE1B8CC030A7062bf2014b2c";
export const DEFAULT_RPC = "https://sepolia.base.org";
export const CHAIN_ID = 84532;
export const STATES = ["None", "Open", "Funded", "Submitted", "Completed", "Rejected", "Partial", "Disputed", "Settled", "Expired", "Cancelled"] as const;

export const escrowAbi = parseAbi([
  "function jobCount() view returns (uint256)",
  "function registry() view returns (address)",
  "function getJob(uint256) view returns ((address client,address provider,address evaluator,uint32 configVersion,uint8 state,uint8 outcome,bool accepted,bool instant,uint16 payoutBps,uint64 deadline,uint64 submittedAt,uint64 verdictAt,uint64 disputedAt,uint256 amount,uint256 providerBond,uint256 slashBase,bytes32 specHash,bytes32 deliverableHash,bytes32 reasonHash))",
  "function getSchedule(uint256) view returns ((bytes32 docHash,uint8 requiredTotal,uint256 bpsTable))",
  "function config(uint32) view returns ((uint256 instantThreshold,uint256 minChallengeBond,uint64 evalWindow,uint64 challengeWindow,uint64 arbitrationTimeout,uint16 challengeBondBps,uint16 missedVerdictSlashBps,uint16 wrongVerdictSlashBps,uint16 materialDiffBps,uint16 feeBps,uint16 failedChallengeEvaluatorShareBps,uint16 instantBondCoverBps,uint16 evaluatorFeeBps))",
  "function verdictScheduled(uint256 jobId,uint16 passMask,uint8 requiredTotal,uint8 requiredPass,bytes32 reasonHash)",
]);
export const registryAbi = parseAbi([
  "function isActive(address) view returns (bool)",
  "function stakeOf(address) view returns (uint256)",
  "function minStake() view returns (uint256)",
  "function availableExposure(address) view returns (uint256)",
]);

export type Job = {
  client: Address; provider: Address; evaluator: Address; configVersion: number; state: number; outcome: number;
  accepted: boolean; instant: boolean; payoutBps: number; deadline: bigint; submittedAt: bigint; verdictAt: bigint;
  disputedAt: bigint; amount: bigint; providerBond: bigint; slashBase: bigint;
  specHash: Hex; deliverableHash: Hex; reasonHash: Hex;
};

export const sha256hex = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

/** RFC 8785-style canonical JSON for the value types used in receipts (strings, integers, booleans, null, arrays, objects). */
export function jcs(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") { if (!Number.isInteger(v)) throw new Error("jcs: non-integer number"); return JSON.stringify(v); }
  if (Array.isArray(v)) return "[" + v.map(jcs).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + jcs(o[k])).join(",") + "}";
  }
  throw new Error("jcs: unsupported type " + typeof v);
}

export function makeClient(rpc: string, chainId = CHAIN_ID): PublicClient {
  const chain = defineChain({ id: chainId, name: "evm-" + chainId, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  return createPublicClient({ chain, transport: http(rpc, { retryCount: 3, retryDelay: 400 }), cacheTime: 0, pollingInterval: 500 }) as PublicClient;
}

export async function readJob(pc: PublicClient, escrow: Address, id: bigint): Promise<Job> {
  return (await pc.readContract({ address: escrow, abi: escrowAbi, functionName: "getJob", args: [id] })) as unknown as Job;
}
export async function blockNow(pc: PublicClient): Promise<bigint> {
  return (await pc.getBlock()).timestamp;
}
const winCache = new Map<string, bigint>();
export async function evalWindowOf(pc: PublicClient, escrow: Address, version: number): Promise<bigint> {
  const k = escrow + ":" + version;
  if (!winCache.has(k)) {
    const c = (await pc.readContract({ address: escrow, abi: escrowAbi, functionName: "config", args: [version] })) as unknown as { evalWindow: bigint };
    winCache.set(k, c.evalWindow);
  }
  return winCache.get(k)!;
}

// ---------------- criteria ----------------
export type Criterion = { id: string; required: boolean; requirement: string; title?: string };
export type CriteriaDoc = { criteria: Criterion[]; criteria_set: string; version: string };

/** required = the ids with required: true in the criteria document, in its order (job 2 schedule rule). */
export function deriveRequired(doc: CriteriaDoc): string[] {
  if (!doc || !Array.isArray(doc.criteria)) throw new Error("criteria document must have a criteria array");
  return doc.criteria.filter((c) => c.required === true).map((c) => c.id);
}

export type Result = "pass" | "fail" | "not-evaluated" | "error";

/** passMask bit i (2^i) set iff required[i] result is exactly "pass"; count = popcount of that mask. */
export function computeMask(required: string[], results: Record<string, Result>): { passMask: number; requiredPass: number } {
  if (required.length > 15) throw new Error("required_total > 15");
  let passMask = 0, requiredPass = 0;
  required.forEach((id, i) => { if (results[id] === "pass") { passMask |= 1 << i; requiredPass++; } });
  return { passMask, requiredPass };
}

// ---------------- checks ----------------
export type Fetched = { status: number; contentType: string | null; body: Uint8Array };
export type CheckCtx = { url: string; fetched: Fetched | null; fetchError: string | null };
export type Check = (c: Criterion, ctx: CheckCtx) => Result;

const urlIn = (s: string) => s.match(/https?:\/\/[^\s"')]+?(?=[.,;]?(\s|$))/)?.[0] ?? null;
const hexIn = (s: string) => s.match(/\b[0-9a-f]{64}\b/i)?.[0].toLowerCase() ?? null;

/** Built-in checks keyed by criterion id (the job 2 criteria set). Add entries to support other criteria sets.
 *  An id without a check yields "not-evaluated", which never counts as pass. */
export const CHECKS: Record<string, Check> = {
  "http-200": (c, x) => (x.fetched ? (x.fetched.status === 200 ? "pass" : "fail") : "fail"),
  "content-type-json": (c, x) => {
    if (!x.fetched) return "fail";
    const ct = (x.fetched.contentType ?? "").trim().toLowerCase();
    return ct === "application/json" || ct.startsWith("application/json") ? "pass" : "fail";
  },
  "body-sha256": (c, x) => {
    const want = hexIn(c.requirement);
    if (!want) return "error";
    return x.fetched ? (sha256hex(x.fetched.body) === want ? "pass" : "fail") : "fail";
  },
  "max-size": (c, x) => {
    const m = c.requirement.match(/at most (\d+) bytes/i);
    if (!m) return "error";
    return x.fetched ? (x.fetched.body.length <= Number(m[1]) ? "pass" : "fail") : "fail";
  },
};

export function deliverableUrlFrom(doc: CriteriaDoc): string | null {
  for (const c of doc.criteria) { const u = urlIn(c.requirement); if (u) return u; }
  return null;
}

export async function fetchDeliverable(url: string, timeoutMs = 15000): Promise<{ fetched: Fetched | null; error: string | null }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    return { fetched: { status: r.status, contentType: r.headers.get("content-type"), body: new Uint8Array(await r.arrayBuffer()) }, error: null };
  } catch (e) { return { fetched: null, error: String((e as Error).message ?? e) }; }
}

export function runChecks(doc: CriteriaDoc, ctx: CheckCtx): Record<string, Result> {
  const out: Record<string, Result> = {};
  for (const c of doc.criteria) {
    const f = CHECKS[c.id];
    if (!f) { out[c.id] = "not-evaluated"; continue; }
    try { out[c.id] = f(c, ctx); } catch { out[c.id] = "error"; }
  }
  return out;
}

export async function loadSource(src: string): Promise<Uint8Array> {
  if (/^https?:\/\//.test(src)) return new Uint8Array(await (await fetch(src, { signal: AbortSignal.timeout(15000) })).arrayBuffer());
  return new Uint8Array(await readFile(src));
}

export const addr = (a: string) => getAddress(a);
export const j = (o: unknown) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
