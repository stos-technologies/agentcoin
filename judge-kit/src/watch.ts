#!/usr/bin/env node
// AgentKoin evalWindow watcher + evaluator health check. Read-only RPC; no signing.
// Alerts: JSON lines on stdout; optional webhook POST (--webhook / WATCH_WEBHOOK_URL, unset by default).
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import type { Address } from "viem";
import { DEFAULT_ESCROW, DEFAULT_RPC, STATES, escrowAbi, registryAbi, addr, j, makeClient, readJob, blockNow, evalWindowOf } from "./lib.ts";

const { values: a } = parseArgs({
  options: {
    config: { type: "string" },                // optional JSON file with the same keys as the flags below
    rpc: { type: "string" }, escrow: { type: "string" },
    thresholds: { type: "string" },            // seconds remaining, comma separated; default 1800,600,120
    evaluator: { type: "string", multiple: true }, // restrict to these evaluators (default: all evaluators of open jobs)
    "from-job": { type: "string" },
    webhook: { type: "string" },
    loop: { type: "boolean", default: false }, interval: { type: "string" },
    "health-only": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (a.help) { console.log("usage: node src/watch.ts [--config f.json] [--rpc url] [--escrow 0x..] [--thresholds 1800,600,120] [--evaluator 0x..] [--webhook url] [--loop --interval s] [--health-only]"); process.exit(0); }
const cfg = a.config ? JSON.parse(await readFile(a.config, "utf8")) : {};
const pick = <T>(flag: T | undefined, key: string, dflt: T): T => (flag ?? cfg[key] ?? dflt);
const rpc: string = pick(a.rpc, "rpc", process.env.WATCH_RPC_URL ?? DEFAULT_RPC);
const escrow = addr(pick(a.escrow, "escrow", process.env.WATCH_ESCROW ?? DEFAULT_ESCROW));
const thresholds: number[] = String(pick(a.thresholds, "thresholds", "1800,600,120")).split(",").map(Number).sort((x, y) => y - x);
const only: string[] = (a.evaluator ?? cfg.evaluators ?? []).map((x: string) => addr(x).toLowerCase());
const webhook: string | undefined = a.webhook ?? cfg.webhook ?? process.env.WATCH_WEBHOOK_URL;
const fromJob = BigInt(pick(a["from-job"], "fromJob", "1"));
const interval = Number(pick(a.interval, "interval", "30"));
if (thresholds.some((t) => !Number.isFinite(t) || t < 0)) { console.error("bad thresholds"); process.exit(2); }

const pc = makeClient(rpc);
const sent = new Set<string>(); // alert dedupe within a --loop run: jobId:level
const emit = async (o: Record<string, unknown>) => {
  const line = { ts: Math.floor(Date.now() / 1000), ...o };
  console.log(j(line));
  if (webhook && o.severity) {
    try { await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: j(line), signal: AbortSignal.timeout(10000) }); }
    catch (e) { console.log(j({ event: "webhook-error", error: String((e as Error).message) })); }
  }
};

export async function once() {
  const now = await blockNow(pc);
  const n = (await pc.readContract({ address: escrow, abi: escrowAbi, functionName: "jobCount" })) as bigint;
  const regAddr = (await pc.readContract({ address: escrow, abi: escrowAbi, functionName: "registry" })) as Address;
  const evals = new Map<string, Address>();
  const summary = { event: "summary", blockTimestamp: now, escrow, jobCount: n, submitted: 0, alerts: 0 };
  for (let id = fromJob; id <= n; id++) {
    const job = await readJob(pc, escrow, id);
    const st = STATES[job.state];
    if (only.length && !only.includes(job.evaluator.toLowerCase())) continue;
    if (st === "Funded" || st === "Submitted") evals.set(job.evaluator.toLowerCase(), job.evaluator);
    if (a["health-only"] || st !== "Submitted") continue;
    summary.submitted++;
    const window = await evalWindowOf(pc, escrow, job.configVersion);
    const deadline = job.submittedAt + window;
    const remaining = Number(deadline - now);
    const info = { jobId: id, evaluator: job.evaluator, submittedAt: job.submittedAt, evalWindow: window, deadline, remainingSeconds: remaining };
    if (remaining < 0) {
      const key = id + ":missed";
      if (!sent.has(key)) { sent.add(key); summary.alerts++; await emit({ event: "alert", level: "missed", severity: "critical", ...info, note: "evalWindow elapsed; timeoutRelease(jobId) is callable by anyone" }); }
      continue;
    }
    const crossed = thresholds.filter((t) => remaining <= t);
    if (crossed.length) {
      const level = Math.min(...crossed); // tightest threshold crossed
      const key = id + ":" + level;
      if (!sent.has(key)) {
        sent.add(key); summary.alerts++;
        const severity = level === Math.min(...thresholds) ? "critical" : "warning";
        await emit({ event: "alert", level: "approaching", thresholdSeconds: level, severity, ...info });
      }
    } else await emit({ event: "job", status: "ok", ...info });
  }
  // evaluator health (assignment-bearing evaluators)
  for (const ev of evals.values()) {
    const [active, stake, minStake, exposure, eth] = await Promise.all([
      pc.readContract({ address: regAddr, abi: registryAbi, functionName: "isActive", args: [ev] }),
      pc.readContract({ address: regAddr, abi: registryAbi, functionName: "stakeOf", args: [ev] }),
      pc.readContract({ address: regAddr, abi: registryAbi, functionName: "minStake" }),
      pc.readContract({ address: regAddr, abi: registryAbi, functionName: "availableExposure", args: [ev] }),
      pc.getBalance({ address: ev }),
    ]);
    const problems: string[] = [];
    if (!active) problems.push("not-active-in-registry");
    if ((stake as bigint) < (minStake as bigint)) problems.push("stake-below-minStake");
    if (eth === 0n) problems.push("zero-native-balance-cannot-pay-gas");
    const hc = { event: "evaluator-health", evaluator: ev, active, stake, minStake, availableExposure: exposure, nativeBalanceWei: eth, ok: problems.length === 0, problems };
    if (problems.length) { summary.alerts++; await emit({ ...hc, severity: "warning" }); } else await emit(hc);
  }
  console.log(j(summary));
  return summary;
}

do { await once(); if (a.loop) await new Promise((r) => setTimeout(r, interval * 1000)); } while (a.loop);
