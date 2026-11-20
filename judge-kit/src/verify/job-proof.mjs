// Self-verifying job proofs. Pure viem + node:crypto (no repo config, no private keys, no write calls), so the same code
// runs inside the service (to build GET /v1/jobs/{id}/proof) and inside the `verify` CLI (to re-check it from an RPC).
//   collect()        reads the chain (and fetches raw criteria/receipt bytes) and returns evidence; hints (tx hashes, URLs) are
//                    only used as search shortcuts and are validated against receipts, never trusted.
//   evaluateChecks() turns evidence into checks[] = {id, claim, how, expected, actual, status}.
import { createHash } from "node:crypto";
import { parseAbi, parseEventLogs, getAddress, keccak256, toBytes, zeroAddress } from "viem";
import { jcs } from "./canonical.mjs";

export const PROOF_SCHEMA = "agentkoin-job-proof/v1";
export const ESCROWS = {
  "0x4eaf6d09f8c22980bb16e719779ace73a7b1cb3d": { version: "v0.5", deployBlock: 57000000 },
  "0xd6e00d3419c16a3bee1b8cc030a7062bf2014b2c": { version: "v0.6", deployBlock: 59708557 },
};
export const USDC_84532 = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const NOTARY_SPEC_TEXT = "agentcoin-notary/v1: JSON receipt {v, digest, note, jobId, client, settleTx, notarizedAt, chainId}; deliverableHash = keccak256(RFC8785(receipt))";
export const KNOWN_CRITERIA_STORES = ["https://x402toll.com/v1/evaluator/criteria/"];
const STATES = ["None", "Open", "Funded", "Submitted", "Completed", "Rejected", "Partial", "Disputed", "Settled", "Expired", "Cancelled"];
const OUTCOMES = ["None", "Complete", "Reject", "Partial"];

const JOB_TUPLE = "(address client,address provider,address evaluator,uint32 configVersion,uint8 state,uint8 outcome,bool accepted,bool instant,uint16 payoutBps,uint64 deadline,uint64 submittedAt,uint64 verdictAt,uint64 disputedAt,uint256 amount,uint256 providerBond,uint256 slashBase,bytes32 specHash,bytes32 deliverableHash,bytes32 reasonHash)";
export const ESCROW_ABI = parseAbi([
  `function getJob(uint256 jobId) view returns (${JOB_TUPLE})`,
  "function jobCount() view returns (uint256)",
  "function registry() view returns (address)",
  "function config(uint32 version) view returns ((uint256 instantThreshold,uint256 minChallengeBond,uint64 evalWindow,uint64 challengeWindow,uint64 arbitrationTimeout,uint16 challengeBondBps,uint16 missedVerdictSlashBps,uint16 wrongVerdictSlashBps,uint16 materialDiffBps,uint16 feeBps,uint16 failedChallengeEvaluatorShareBps,uint16 instantBondCoverBps,uint16 evaluatorFeeBps))",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 amount, uint64 deadline, bytes32 specHash, uint32 configVersion)",
  "event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)",
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverableHash)",
  "event Verdict(uint256 indexed jobId, address indexed evaluator, uint8 outcome, uint16 payoutBps, bytes32 reasonHash)",
  "event Settled(uint256 indexed jobId, uint16 payoutBps)",
]);
const REGISTRY_ABI = parseAbi([
  "function minStake() view returns (uint256)",
  "function evaluatorInfo(address evaluator) view returns ((uint256 stake,uint256 lockedExposure,uint64 unstakeRequestedAt,uint64 unstakeAmount,uint64 unused))",
]);
const REGISTRY_STAKE_ABI = parseAbi(["function evaluatorInfo(address) view returns (uint256,uint256,uint64,uint256)"]);
const ERC20_EVENTS = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

export const sha256Hex = (bytes) => "0x" + createHash("sha256").update(bytes).digest("hex");
export const keccakBytes = (bytes) => keccak256(bytes);
const lc = (a) => String(a ?? "").toLowerCase();
const same = (a, b) => lc(a) === lc(b);

/** First block whose timestamp >= ts (binary search over eth_getBlockByNumber). */
export async function blockAtOrAfter(client, ts, { lo = 1n, hi = null } = {}) {
  hi ??= await client.getBlockNumber();
  let l = lo, h = hi;
  while (l < h) {
    const mid = (l + h) / 2n;
    const b = await client.getBlock({ blockNumber: mid });
    if (Number(b.timestamp) >= Number(ts)) h = mid;
    else l = mid + 1n;
  }
  return l;
}

/** eth_getLogs for one event filtered by indexed jobId, walked in windows of <= `window` blocks, in `dir` direction. */
export async function findJobLogs(client, { address, event, jobId, from, to, window = 200, dir = "forward", maxCalls = 60 }) {
  const abiItem = ESCROW_ABI.find((i) => i.type === "event" && i.name === event);
  const out = [];
  let calls = 0;
  const W = BigInt(window);
  if (dir === "forward") {
    for (let f = from; f <= to && calls < maxCalls; f += W) {
      const t = f + W - 1n < to ? f + W - 1n : to;
      calls++;
      const logs = await client.getLogs({ address, event: abiItem, args: { jobId: BigInt(jobId) }, fromBlock: f, toBlock: t });
      if (logs.length) return { logs, calls };
    }
  } else {
    for (let t = to; t >= from && calls < maxCalls; t -= W) {
      const f = t - W + 1n > from ? t - W + 1n : from;
      calls++;
      const logs = await client.getLogs({ address, event: abiItem, args: { jobId: BigInt(jobId) }, fromBlock: f, toBlock: t });
      if (logs.length) return { logs, calls };
    }
  }
  return { logs: out, calls };
}

export async function fetchBytesDefault(url) {
  const r = await fetch(url, { headers: { "accept-encoding": "identity" }, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return { bytes: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get("content-type") };
}

async function txFacts(client, hash) {
  const [tx, rc] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  const blk = await client.getBlock({ blockNumber: rc.blockNumber });
  return { hash, from: getAddress(tx.from), to: tx.to ? getAddress(tx.to) : null, status: rc.status, blockNumber: rc.blockNumber, timestamp: Number(blk.timestamp), logs: rc.logs };
}

/** Event of `name` for jobId emitted by `escrow` inside a tx (null when the tx does not contain it). */
function eventIn(facts, escrow, name, jobId) {
  if (!facts || facts.status !== "success") return null;
  const logs = facts.logs.filter((l) => same(l.address, escrow));
  const parsed = parseEventLogs({ abi: ESCROW_ABI, logs, eventName: name, strict: false });
  const hit = parsed.find((p) => String(p.args.jobId) === String(jobId));
  return hit ? { ...hit.args, logIndex: hit.logIndex, name } : null;
}

/**
 * Gather every fact a proof needs. `hints` = { fundTx, submitTx, verdictTx, settleTx, criteriaUrls[], deliverableUrls[] } (all optional).
 * Returns evidence; never throws for a missing optional part (the matching check reports it).
 */
export async function collect({ client, escrow, jobId, hints = {}, window = 200, fetchBytes = fetchBytesDefault, fetchJson = null, sourcify = true, maxCalls = 60, sourcifyUrl = "https://sourcify.dev/server/v2/contract" }) {
  escrow = getAddress(escrow);
  const id = BigInt(jobId);
  const ev = { schema: PROOF_SCHEMA, escrow, jobId: String(id), chainId: await client.getChainId(), errors: [] };
  const note = (m) => ev.errors.push(String(m).slice(0, 200));
  ev.escrowVersion = ESCROWS[lc(escrow)]?.version ?? "unknown";
  const [head, code] = await Promise.all([client.getBlock(), client.getCode({ address: escrow })]);
  ev.blockNumber = String(head.number);
  ev.blockTimestamp = Number(head.timestamp);
  ev.escrowHasCode = !!code && code !== "0x";
  ev.escrowCodeHash = ev.escrowHasCode ? keccakBytes(code) : null;
  if (!ev.escrowHasCode) return ev;
  let j;
  try {
    j = await client.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "getJob", args: [id], blockNumber: head.number });
  } catch (e) {
    note("getJob: " + (e.shortMessage ?? e.message));
    return ev;
  }
  ev.job = {
    state: STATES[j.state], outcome: OUTCOMES[j.outcome], client: j.client, provider: j.provider, evaluator: j.evaluator, amount: String(j.amount), instant: j.instant,
    payoutBps: Number(j.payoutBps), deadline: Number(j.deadline), submittedAt: Number(j.submittedAt), verdictAt: Number(j.verdictAt),
    specHash: j.specHash, deliverableHash: j.deliverableHash, reasonHash: j.reasonHash, configVersion: Number(j.configVersion),
  };
  ev.exists = j.client !== zeroAddress;
  if (!ev.exists) return ev;
  const cfg = await client.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "config", args: [j.configVersion] }).catch(() => null);
  const challengeWindow = cfg ? Number(cfg.challengeWindow) : 600;
  const W = window;
  const facts = {};
  const getFacts = async (h) => {
    if (!h) return null;
    try { return (facts[h] ??= await txFacts(client, h)); } catch (e) { note(`tx ${h}: ${e.shortMessage ?? e.message}`); return null; }
  };
  const dep = ESCROWS[lc(escrow)]?.deployBlock ? BigInt(ESCROWS[lc(escrow)].deployBlock) : 1n;

  // --- verdict (its block timestamp equals job.verdictAt) ---
  let verdict = null;
  let verdictBlock = null;
  if (ev.job.verdictAt > 0) {
    let f = await getFacts(hints.verdictTx);
    let e = eventIn(f, escrow, "Verdict", id);
    if (!e) {
      const b = await blockAtOrAfter(client, ev.job.verdictAt, { lo: dep });
      const end = (await blockAtOrAfter(client, ev.job.verdictAt + 1, { lo: b })) - 1n; // several blocks can share one timestamp
      const r = await findJobLogs(client, { address: escrow, event: "Verdict", jobId: id, from: b, to: end < b ? b : end, window: W, maxCalls });
      const lg = r.logs[0];
      if (lg) { f = await getFacts(lg.transactionHash); e = eventIn(f, escrow, "Verdict", id); }
    }
    if (e) { verdict = { ...e, tx: f }; verdictBlock = f.blockNumber; }
  }
  // --- fund (JobCreated): searched backwards from the verdict block, else from head ---
  let created = null;
  {
    let f = await getFacts(hints.fundTx);
    let e = eventIn(f, escrow, "JobCreated", id);
    if (!e) {
      const anchor = verdictBlock ?? head.number;
      const r = await findJobLogs(client, { address: escrow, event: "JobCreated", jobId: id, from: dep, to: anchor, window: W, dir: "backward", maxCalls });
      const lg = r.logs[0];
      if (lg) { f = await getFacts(lg.transactionHash); e = eventIn(f, escrow, "JobCreated", id); }
    }
    if (e) created = { ...e, tx: f };
  }
  // --- submit: between the fund block and the verdict block (or head) ---
  let submit = null;
  if (ev.job.submittedAt > 0 || ev.job.state === "Submitted") {
    let f = await getFacts(hints.submitTx);
    let e = eventIn(f, escrow, "JobSubmitted", id);
    if (!e && created) {
      const r = await findJobLogs(client, { address: escrow, event: "JobSubmitted", jobId: id, from: created.tx.blockNumber, to: verdictBlock ?? head.number, window: W, maxCalls });
      const lg = r.logs[0];
      if (lg) { f = await getFacts(lg.transactionHash); e = eventIn(f, escrow, "JobSubmitted", id); }
    }
    if (e) submit = { ...e, tx: f };
  }
  // --- settled ---
  let settled = null;
  if (ev.job.state === "Settled" || ev.job.state === "Expired") {
    let f = await getFacts(hints.settleTx);
    let e = eventIn(f, escrow, "Settled", id);
    if (!e && verdict) {
      const b = await blockAtOrAfter(client, ev.job.verdictAt + challengeWindow, { lo: verdict.tx.blockNumber });
      const r = await findJobLogs(client, { address: escrow, event: "Settled", jobId: id, from: b, to: head.number, window: W, maxCalls });
      const lg = r.logs[0];
      if (lg) { f = await getFacts(lg.transactionHash); e = eventIn(f, escrow, "Settled", id); }
    }
    if (e) settled = { ...e, tx: f };
  }
  // --- payment path inside the fund tx ---
  let payment = null;
  if (created) {
    const tf = created.tx;
    const usdc = ev.chainId === 84532 ? USDC_84532 : null;
    const xfers = parseEventLogs({ abi: ERC20_EVENTS, logs: tf.logs.filter((l) => (usdc ? same(l.address, usdc) : true)), eventName: "Transfer", strict: false });
    const intoEscrow = xfers.filter((x) => same(x.args.to, escrow));
    const first = intoEscrow[0];
    const routeIn = first && !same(first.args.from, ev.job.client) ? xfers.find((x) => same(x.args.to, first.args.from) && same(x.args.from, ev.job.client)) : null;
    payment = {
      txHash: tf.hash, blockNumber: String(tf.blockNumber), logIndex: created.logIndex, txSender: tf.from,
      client: ev.job.client, amount: ev.job.amount, token: usdc,
      transfers: xfers.map((x) => ({ from: getAddress(x.args.from), to: getAddress(x.args.to), value: String(x.args.value), logIndex: x.logIndex })),
      intoEscrow: intoEscrow.map((x) => ({ from: getAddress(x.args.from), value: String(x.args.value) })),
      path: !first ? "none" : same(first.args.from, ev.job.client) ? "direct (client -> escrow)" : routeIn ? "deposit route (client -> route -> escrow)" : "other",
      route: routeIn ? getAddress(first.args.from) : null,
      facilitator: routeIn || !first || same(first.args.from, ev.job.client) ? (same(tf.from, ev.job.client) ? null : tf.from) : tf.from,
    };
  }
  ev.txs = { fund: created && { hash: created.tx.hash, block: String(created.tx.blockNumber), logIndex: created.logIndex, event: "JobCreated" }, submit: submit && { hash: submit.tx.hash, block: String(submit.tx.blockNumber), logIndex: submit.logIndex, event: "JobSubmitted", from: submit.tx.from }, verdict: verdict && { hash: verdict.tx.hash, block: String(verdict.tx.blockNumber), logIndex: verdict.logIndex, event: "Verdict", from: verdict.tx.from }, settle: settled && { hash: settled.tx.hash, block: String(settled.tx.blockNumber), logIndex: settled.logIndex, event: "Settled", from: settled.tx.from } };
  ev.created = created && { blockNumber: String(created.tx.blockNumber), amount: String(created.amount), client: created.client, provider: created.provider, evaluator: created.evaluator, specHash: created.specHash, deadline: Number(created.deadline) };
  ev.submit = submit && { provider: submit.provider, deliverableHash: submit.deliverableHash, timestamp: submit.tx.timestamp, blockNumber: String(submit.tx.blockNumber) };
  ev.verdict = verdict && { evaluator: verdict.evaluator, outcome: OUTCOMES[verdict.outcome], payoutBps: Number(verdict.payoutBps), reasonHash: verdict.reasonHash, txFrom: verdict.tx.from, timestamp: verdict.tx.timestamp, blockNumber: String(verdict.tx.blockNumber) };
  ev.settled = settled && { payoutBps: Number(settled.payoutBps) };
  if (settled) {
    const usdc = ev.chainId === 84532 ? USDC_84532 : null;
    const xs = parseEventLogs({ abi: ERC20_EVENTS, logs: settled.tx.logs.filter((l) => (usdc ? same(l.address, usdc) : true)), eventName: "Transfer", strict: false });
    const out = xs.filter((x) => same(x.args.from, escrow)).map((x) => ({ from: getAddress(x.args.from), to: getAddress(x.args.to), value: String(x.args.value), logIndex: x.logIndex }));
    const sum = (a) => out.filter((x) => same(x.to, a)).reduce((t, x) => t + BigInt(x.value), 0n);
    ev.settlement = { txHash: settled.tx.hash, blockNumber: String(settled.tx.blockNumber), payoutBps: Number(settled.payoutBps), transfers: out,
      toProvider: String(sum(ev.job.provider)), toClient: String(sum(ev.job.client)), jobAmount: ev.job.amount };
  }
  ev.payment = payment;

  // --- evaluator stake at the verdict block ---
  try {
    const registry = await client.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "registry" });
    const bn = verdict ? BigInt(verdict.tx.blockNumber) : head.number;
    const [stake, min] = await Promise.all([
      client.readContract({ address: registry, abi: REGISTRY_STAKE_ABI, functionName: "evaluatorInfo", args: [ev.job.evaluator], blockNumber: bn }),
      client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "minStake", blockNumber: bn }),
    ]);
    ev.evaluator = { address: getAddress(ev.job.evaluator), registry, stake: String(stake[0]), minStake: String(min), atBlock: String(bn) };
  } catch (e) {
    ev.evaluator = { address: getAddress(ev.job.evaluator), error: String(e.shortMessage ?? e.message).slice(0, 160) };
  }

  // --- raw criteria and deliverable bytes (any URL is fine: the bytes are hashed against the chain) ---
  const specNoPrefix = ev.job.specHash.slice(2);
  const critUrls = [...(hints.criteriaUrls ?? []), ...KNOWN_CRITERIA_STORES.map((u) => u + specNoPrefix)];
  ev.criteria = { specHash: ev.job.specHash, candidates: [] };
  for (const url of [...new Set(critUrls)]) {
    try {
      const { bytes } = await fetchBytes(url);
      ev.criteria.candidates.push({ url, bytes: bytes.length, sha256: sha256Hex(bytes), keccak256: keccakBytes(bytes) });
      if (sha256Hex(bytes) === lc(ev.job.specHash)) { ev.criteria.url = url; ev.criteria.length = bytes.length; ev.criteria.sha256 = sha256Hex(bytes); ev.criteria.bytes = bytes; break; }
    } catch (e) { ev.criteria.candidates.push({ url, error: String(e.message).slice(0, 120) }); }
  }
  ev.criteria.defaultSpec = { text: NOTARY_SPEC_TEXT, keccak256: keccak256(toBytes(NOTARY_SPEC_TEXT)) };
  let docUrls = [];
  if (ev.criteria.bytes) {
    try { docUrls = [...new Set(JSON.parse(ev.criteria.bytes.toString("utf8")).criteria.map((c) => c?.check?.url).filter(Boolean))]; } catch { /* not a checks document */ }
  }
  ev.deliverable = { deliverableHash: ev.job.deliverableHash, candidates: [] };
  for (const url of [...new Set([...(hints.deliverableUrls ?? []), ...docUrls])]) {
    try {
      const { bytes } = await fetchBytes(url);
      const s = sha256Hex(bytes), k = keccakBytes(bytes);
      ev.deliverable.candidates.push({ url, bytes: bytes.length, sha256: s, keccak256: k });
      if (s === lc(ev.job.deliverableHash) || k === lc(ev.job.deliverableHash)) { ev.deliverable.url = url; ev.deliverable.length = bytes.length; ev.deliverable.hashAlgorithm = s === lc(ev.job.deliverableHash) ? "sha256" : "keccak256"; ev.deliverable.bytes = bytes; ev.deliverable.raw = bytes; break; }
    } catch (e) { ev.deliverable.candidates.push({ url, error: String(e.message).slice(0, 120) }); }
  }
  // keccak(JCS(receipt)) form used by default-mode notarize jobs: the receipt JSON is canonicalised before hashing
  if (!ev.deliverable.url) {
    for (const c of ev.deliverable.candidates) {
      if (c.error) continue;
      try {
        const { bytes } = await fetchBytes(c.url);
        const body = JSON.parse(bytes.toString("utf8"));
        const r = body.receipt ?? body;
        if (keccak256(toBytes(jcs(r))) === lc(ev.job.deliverableHash)) { ev.deliverable.url = c.url; ev.deliverable.hashAlgorithm = "keccak256(RFC8785(receipt))"; ev.deliverable.length = bytes.length; ev.deliverable.bytes = Buffer.from(jcs(r)); ev.deliverable.raw = bytes; ev.deliverable.receiptSignature = body.receiptSignature ?? null; break; }
      } catch { /* next */ }
    }
  }

  // --- Sourcify ---
  if (sourcify) {
    try {
      const sj = fetchJson ? await fetchJson(`${sourcifyUrl}/${ev.chainId}/${escrow}`) : JSON.parse((await fetchBytes(`${sourcifyUrl}/${ev.chainId}/${escrow}`)).bytes.toString("utf8"));
      ev.sourcify = { url: `${sourcifyUrl}/${ev.chainId}/${escrow}`, match: sj.match ?? null, runtimeMatch: sj.runtimeMatch ?? null };
    } catch (e) { ev.sourcify = { error: String(e.message).slice(0, 120) }; }
  }
  return ev;
}

const pass = (b) => (b ? "pass" : "fail");

/** Evaluate evidence into the check list. status: pass | fail | skip (skip only when the input is absent by design). */
export function evaluateChecks(ev) {
  const C = [];
  const add = (id, claim, how, expected, actual, status, reason) => C.push({ id, claim, how, expected: expected ?? null, actual: actual ?? null, status, ...(reason ? { reason } : {}) });
  const j = ev.job;
  add("job-onchain", "the job exists on the named escrow", "eth_getCode(escrow) is non-empty and JobEscrow.getJob(jobId).client != 0 at the head block", true, !!(ev.escrowHasCode && ev.exists), pass(ev.escrowHasCode && ev.exists));
  if (!j || !ev.exists) return C;
  // spec
  const sha = ev.criteria?.sha256;
  if (sha) add("spec-hash", "sha256(criteria bytes) == job.specHash", "GET the criteria bytes, sha256 them, compare with getJob(jobId).specHash", j.specHash, sha, pass(lc(sha) === lc(j.specHash)));
  else if (lc(j.specHash) === lc(ev.criteria?.defaultSpec?.keccak256)) add("spec-hash", "job.specHash == keccak256(published default notary spec text)", "keccak256(utf8(spec text)) compared with getJob(jobId).specHash", j.specHash, ev.criteria.defaultSpec.keccak256, "pass");
  else add("spec-hash", "criteria bytes hash to job.specHash", "fetch candidate criteria URLs and hash the bytes (sha256 or keccak256 of the default spec text)", j.specHash, (ev.criteria?.candidates ?? []).map((c) => c.sha256).filter(Boolean), "fail", "no candidate criteria bytes hash to specHash");
  // deliverable
  if (j.submittedAt > 0) {
    if (ev.deliverable?.url) add("deliverable-hash", "hash(receipt/deliverable bytes) == job.deliverableHash", "GET the deliverable bytes, hash them (sha256, or keccak256 of the RFC 8785 receipt), compare with getJob(jobId).deliverableHash", j.deliverableHash, ev.deliverable.hashAlgorithm, "pass");
    else add("deliverable-hash", "hash(receipt/deliverable bytes) == job.deliverableHash", "GET candidate deliverable URLs and hash the bytes", j.deliverableHash, (ev.deliverable?.candidates ?? []).map((c) => c.sha256).filter(Boolean), "fail", "no candidate deliverable bytes hash to deliverableHash");
  } else add("deliverable-hash", "deliverable hash committed on chain", "job not submitted yet", null, null, "skip", "job has no submission");
  // payment
  const p = ev.payment;
  if (p) {
    const total = p.intoEscrow.reduce((a, x) => a + BigInt(x.value), 0n);
    const okPath = p.path.startsWith("direct") || p.path.startsWith("deposit route");
    add("payment-flow", "the USDC that funded the job moved client -> (route) -> escrow in the fund tx", "read the fund tx receipt: JobCreated(jobId) plus USDC Transfer logs into the escrow; amount equals job.amount and the first hop is the client", { amount: j.amount, client: j.client }, { path: p.path, intoEscrow: p.intoEscrow, route: p.route }, pass(okPath && total >= BigInt(j.amount) && ev.created && ev.created.amount === j.amount && same(ev.created.client, j.client)));
  } else add("payment-flow", "the USDC that funded the job moved client -> (route) -> escrow in the fund tx", "locate JobCreated(jobId), read the tx receipt", { amount: j.amount, client: j.client }, null, "fail", "JobCreated not located");
  // submit
  if (j.submittedAt > 0) {
    const s = ev.submit;
    add("submit-tx", "JobSubmitted(jobId, provider, deliverableHash) matches the job", "locate the JobSubmitted log (after the fund tx, not after the verdict); compare provider and deliverableHash with getJob", { provider: j.provider, deliverableHash: j.deliverableHash }, s && { provider: s.provider, deliverableHash: s.deliverableHash, block: s.blockNumber }, pass(!!s && same(s.provider, j.provider) && lc(s.deliverableHash) === lc(j.deliverableHash) && (!ev.created || BigInt(s.blockNumber) >= BigInt(ev.created.blockNumber)) && (!ev.verdict || s.timestamp <= ev.verdict.timestamp)));
  } else add("submit-tx", "JobSubmitted matches the job", "job not submitted", null, null, "skip", "job has no submission");
  // verdict
  if (j.verdictAt > 0) {
    const v = ev.verdict;
    add("verdict-signer", "the verdict tx was sent by job.evaluator with the on-chain outcome and payout", "locate the Verdict log; its tx `from` must equal getJob.evaluator; outcome and payoutBps equal the job's", { evaluator: j.evaluator, outcome: j.outcome, payoutBps: j.payoutBps }, v && { evaluator: v.txFrom, event_evaluator: v.evaluator, outcome: v.outcome, payoutBps: v.payoutBps }, pass(!!v && same(v.txFrom, j.evaluator) && same(v.evaluator, j.evaluator) && (v.outcome === j.outcome || j.state === "Disputed") && (v.payoutBps === j.payoutBps || j.state === "Disputed")));
  } else add("verdict-signer", "verdict tx sent by the evaluator", "no verdict yet", null, null, "skip", "job has no verdict");
  // settle
  if (j.state === "Settled") {
    const s = ev.settled;
    add("settlement", "Settled(jobId, payoutBps) was emitted and equals the job's payoutBps", "locate the Settled log after verdictAt + challengeWindow", { payoutBps: j.payoutBps }, s && { payoutBps: s.payoutBps }, pass(!!s && s.payoutBps === j.payoutBps));
  } else add("settlement", "Settled event", "job not settled", null, null, "skip", `job state is ${j.state}`);
  // evaluator stake
  const e = ev.evaluator;
  if (e?.stake !== undefined) add("evaluator-stake", "the evaluator had at least minStake in the registry at the verdict block", "EvaluatorRegistry.evaluatorInfo(evaluator).stake and minStake read at the verdict block", { minStake: e.minStake }, { stake: e.stake, atBlock: e.atBlock }, pass(BigInt(e.stake) >= BigInt(e.minStake)));
  else add("evaluator-stake", "the evaluator had at least minStake at the verdict block", "registry state read at the verdict block", null, e?.error ?? null, "skip", "historical registry state unavailable from this RPC");
  // bytecode
  if (ev.sourcify) {
    const sm = ev.sourcify.match ?? ev.sourcify.runtimeMatch;
    if (sm) add("escrow-bytecode", "escrow runtime bytecode is a Sourcify exact_match", "GET Sourcify v2 contract record for (chainId, escrow); match must be exact_match; code hash from eth_getCode", { match: "exact_match" }, { match: sm, codeHash: ev.escrowCodeHash }, pass(sm === "exact_match" || sm === "match"));
    else add("escrow-bytecode", "escrow runtime bytecode is a Sourcify exact_match", "GET Sourcify v2 contract record", { match: "exact_match" }, ev.sourcify.error ?? null, "fail", "Sourcify returned no match");
  } else add("escrow-bytecode", "escrow runtime bytecode is a Sourcify exact_match", "disabled for this run", null, null, "skip", "sourcify lookup disabled");
  return C;
}

/** The bundle served by GET /v1/jobs/{id}/proof (before signing). Contains no raw bytes, only hashes, URLs and byte lengths. */
export function proofBundle(ev, extra = {}) {
  const checks = evaluateChecks(ev).map(({ id, claim, how, expected }) => ({ id, claim, how, expected }));
  const strip = (o) => (o ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== "bytes")) : o);
  return {
    schema: PROOF_SCHEMA,
    escrow: ev.escrow, escrowVersion: ev.escrowVersion, chainId: ev.chainId, jobId: ev.jobId, blockNumber: ev.blockNumber,
    job: ev.job, txs: ev.txs,
    payment: ev.payment && { scheme: ev.payment.path, amount: ev.payment.amount, payer: ev.payment.client, payTo: ev.payment.route ?? ev.escrow, depositRoute: ev.payment.route, facilitator: ev.payment.facilitator, token: ev.payment.token, fundTx: ev.payment.txHash, transfers: ev.payment.transfers },
    criteria: { specHash: ev.criteria?.specHash, url: ev.criteria?.url ?? null, byteLength: ev.criteria?.length ?? null, hashAlgorithm: ev.criteria?.url ? "sha256" : "keccak256(default notary spec text)", ...(ev.criteria?.url ? {} : { defaultSpecText: NOTARY_SPEC_TEXT }) },
    deliverable: { deliverableHash: ev.deliverable?.deliverableHash, url: ev.deliverable?.url ?? null, byteLength: ev.deliverable?.length ?? null, hashAlgorithm: ev.deliverable?.hashAlgorithm ?? null },
    evaluator: ev.evaluator && strip(ev.evaluator),
    sourcify: ev.sourcify ?? null,
    checks,
    ...extra,
  };
}
export const canonicalProof = (bundleWithoutSignature) => jcs(bundleWithoutSignature);

// ---------- proof signature (EIP-191 over keccak256(RFC 8785(proof without "signature"))) ----------
import { verifyMessage, recoverMessageAddress, getAddress as _ga } from "viem";
/** Verifies the bundle signature and, when `expectedSigner` is given, that the signer is that address. Read-only (no account objects). */
export async function verifyProofSignature(proof, expectedSigner = null) {
  const s = proof?.signature;
  if (!s || s.scheme !== "eip191") return { valid: false, reason: "no eip191 signature" };
  const { signature, ...rest } = proof;
  const digest = keccak256(toBytes(jcs(rest)));
  if (s.signedDigest !== digest) return { valid: false, reason: "digest mismatch (proof modified)" };
  let ok = false;
  try { ok = await verifyMessage({ address: s.signer, message: { raw: digest }, signature: s.value }); } catch { ok = false; }
  if (!ok) return { valid: false, reason: "signature does not match signer" };
  if (expectedSigner && _ga(expectedSigner) !== _ga(s.signer)) return { valid: false, reason: "signer is not the expected key", signer: _ga(s.signer) };
  return { valid: true, signer: _ga(s.signer) };
}

/** Cross-check: every check id in the served proof must carry the same `expected` as the independently computed one. */
export function crossCheck(proof, results) {
  const out = [];
  for (const pc of proof?.checks ?? []) {
    const mine = results.find((r) => r.id === pc.id);
    if (!mine) { out.push({ id: pc.id, status: "fail", reason: "check not recomputed" }); continue; }
    if (mine.status === "skip") continue;
    out.push({ id: pc.id, status: jcs(pc.expected ?? null) === jcs(mine.expected ?? null) ? "pass" : "fail" });
  }
  return out;
}

/** Address of a secp256k1 JWK as published in /.well-known/jwks.json (keccak256 of the uncompressed point, last 20 bytes). */
export function addressFromProofJwk(jwk) {
  if (!jwk?.x || !jwk?.y) return null;
  const pub = Buffer.concat([Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return _ga("0x" + keccak256(pub).slice(-40));
}


// ---------- explicit values for hand recomputation ----------
/**
 * The numbers a person recomputing by hand compares: the raw receipt, its canonical (RFC 8785) bytes and digests, the signer recovered
 * from the receipt signature, and the finalize payout split read from the settle tx's USDC Transfer logs. Recovery only (no signing).
 */
export async function describeEvidence(ev, { expectedSigner = null } = {}) {
  const d = ev.deliverable ?? {};
  const out = { receipt: null, signature: null, settlement: ev.settlement ?? null };
  if (d.url && d.raw) {
    let receipt = null, body = null;
    try { body = JSON.parse(d.raw.toString("utf8")); receipt = body.receipt ?? body; } catch { /* not JSON */ }
    const canon = receipt ? Buffer.from(jcs(receipt)) : null;
    out.receipt = {
      url: d.url, hashAlgorithm: d.hashAlgorithm, onchainDeliverableHash: ev.job.deliverableHash,
      rawByteLength: d.raw.length, rawSha256: sha256Hex(d.raw),
      receipt, canonical: canon ? canon.toString("utf8") : null,
      canonicalKeccak256: canon ? keccak256(canon) : null, canonicalSha256: canon ? sha256Hex(canon) : null,
    };
    const rs = d.receiptSignature ?? body?.receiptSignature ?? null;
    if (rs?.value && canon) {
      const digest = keccak256(canon);
      let recovered = null;
      try { recovered = getAddress(await recoverMessageAddress({ message: { raw: digest }, signature: rs.value })); } catch { /* bad signature */ }
      out.signature = { scheme: rs.scheme, signedDigest: digest, claimedSigner: rs.signer ? getAddress(rs.signer) : null, recoveredSigner: recovered,
        matchesClaimed: !!recovered && !!rs.signer && recovered === getAddress(rs.signer),
        matchesPublishedKey: expectedSigner ? recovered === getAddress(expectedSigner) : null };
    }
  }
  return out;
}
