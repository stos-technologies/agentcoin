// agentkoin-judge-kit verify <jobId> [--escrow 0x..] [--rpc URL] [--server URL] [--proof FILE] [--window N] [--no-sourcify] [--json]
// Re-runs every proof check against a Base Sepolia RPC. The service's proof is used only for hints (tx hashes, URLs) and
// its signature is checked against the key the service publishes; every fact is re-read from the chain or re-hashed from raw
// bytes. Read-only: no private key, no signer, no write calls. Exit 0 when no check failed, 1 otherwise, 2 on usage error.
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { collect, evaluateChecks, describeEvidence, verifyProofSignature, crossCheck, addressFromProofJwk, ESCROWS } from "./job-proof.mjs";

const DEFAULT_ESCROW = "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D";
const DEFAULT_RPCS = ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"];

export function parseArgs(argv) {
  const o = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--no-sourcify" || a === "--no-server") o.flags[a.slice(2)] = true;
    else if (a.startsWith("--")) o.flags[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

export async function verifyJob({ jobId, escrow = DEFAULT_ESCROW, rpc, server = "https://agentcoinhq.com", proofFile, window, sourcify = true, noServer = false, client = null, fetchBytes, log = () => {} }) {
  const url = rpc ?? DEFAULT_RPCS[0];
  const w = Number(window ?? (/publicnode/.test(url) ? 50000 : 200));
  client ??= createPublicClient({ chain: baseSepolia, transport: http(url) });
  let proof = null;
  const notes = [];
  try {
    if (proofFile) proof = JSON.parse(readFileSync(proofFile, "utf8"));
    else if (!noServer) {
      const isDefault = escrow.toLowerCase() === DEFAULT_ESCROW.toLowerCase();
      const r = await fetch(isDefault ? `${server}/v1/jobs/${jobId}/proof` : `${server}/v1/escrows/${escrow}/jobs/${jobId}/proof`, { signal: AbortSignal.timeout(20000) });
      if (r.ok) proof = await r.json();
      else notes.push(`proof endpoint answered ${r.status}; continuing without hints`);
    }
  } catch (e) { notes.push("proof not fetched: " + e.message); }
  if (proof && proof.schema !== "agentkoin-job-proof/v1") { notes.push("server response is not an agentkoin-job-proof/v1 bundle; ignored"); proof = null; }
  const results = [];
  if (proof) {
    let signer = null;
    if (!proofFile && !noServer) {
      try { const jwks = await (await fetch(`${server}/.well-known/jwks.json`, { signal: AbortSignal.timeout(15000) })).json(); signer = addressFromProofJwk(jwks.keys?.[0]); } catch (e) { notes.push("jwks not fetched: " + e.message); }
    }
    const sv = await verifyProofSignature(proof, signer);
    results.push({ id: "proof-signature", claim: "the proof is signed by the key the service publishes in /.well-known/jwks.json", how: "EIP-191 over keccak256(RFC 8785(proof without signature)); signer compared with the jwks key", expected: signer, actual: sv.signer ?? null, status: sv.valid ? (signer ? "pass" : "skip") : "fail", ...(sv.valid && !signer ? { reason: "no published key to compare (offline or --proof)" } : sv.reason ? { reason: sv.reason } : {}) });
    if (proof.escrow && proof.escrow.toLowerCase() !== escrow.toLowerCase()) results.push({ id: "proof-subject", claim: "proof is for the requested escrow and job", how: "compare proof.escrow / proof.jobId with the request", expected: { escrow, jobId: String(jobId) }, actual: { escrow: proof.escrow, jobId: proof.jobId }, status: "fail" });
  }
  const hints = {
    fundTx: proof?.txs?.fund?.hash, submitTx: proof?.txs?.submit?.hash, verdictTx: proof?.txs?.verdict?.hash, settleTx: proof?.txs?.settle?.hash,
    criteriaUrls: [proof?.criteria?.url, ...(proof?.criteria?.candidateUrls ?? [])].filter(Boolean),
    deliverableUrls: [proof?.deliverable?.url, ...(proof?.deliverable?.candidateUrls ?? []), ...(!noServer && !proofFile && escrow.toLowerCase() === DEFAULT_ESCROW.toLowerCase() ? [`${server}/v1/notarize/${jobId}`] : [])].filter(Boolean),
  };
  const ev = await collect({ client, escrow, jobId, hints, window: w, sourcify, ...(fetchBytes ? { fetchBytes } : {}) });
  const checks = evaluateChecks(ev);
  results.push(...checks);
  if (proof) {
    for (const c of crossCheck(proof, checks)) results.push({ id: `proof-claims:${c.id}`, claim: `the proof's expected value for ${c.id} equals the independently derived one`, how: "compare proof.checks[].expected with the recomputed expected", expected: null, actual: null, status: c.status, ...(c.reason ? { reason: c.reason } : {}) });
  }
  const failed = results.filter((r) => r.status === "fail").length;
  let published = null;
  if (!proofFile && !noServer) { try { const jwks = await (await fetch(`${server}/.well-known/jwks.json`, { signal: AbortSignal.timeout(15000) })).json(); published = addressFromProofJwk(jwks.keys?.[0]); } catch { /* optional */ } }
  if (ev.deliverable?.raw && !ev.deliverable.receiptSignature && !noServer && !proofFile) {
    try { const st = await (await fetch(`${server}/v1/notarize/${jobId}`, { signal: AbortSignal.timeout(15000) })).json(); if (st?.receiptSignature?.value) ev.deliverable.receiptSignature = st.receiptSignature; } catch { /* optional */ }
  }
  const details = await describeEvidence(ev, { expectedSigner: published });
  return { details, jobId: String(jobId), escrow, escrowVersion: ev.escrowVersion, rpc: url, ok: failed === 0, failed, passed: results.filter((r) => r.status === "pass").length, skipped: results.filter((r) => r.status === "skip").length, evaluator: ev.evaluator?.address ?? null, errors: ev.errors, notes, results };
}

function printDetails(d) {
  if (d?.receipt) {
    const x = d.receipt;
    console.log("\nreceipt (for hand recomputation)");
    console.log(`  url                    ${x.url}`);
    console.log(`  raw bytes              ${x.rawByteLength}  sha256 ${x.rawSha256}`);
    console.log(`  raw receipt            ${JSON.stringify(x.receipt)}`);
    console.log(`  canonical (RFC 8785)   ${x.canonical}`);
    console.log(`  keccak256(canonical)   ${x.canonicalKeccak256}`);
    console.log(`  sha256(canonical)      ${x.canonicalSha256}`);
    console.log(`  on-chain deliverable   ${x.onchainDeliverableHash}   (${x.hashAlgorithm})`);
  }
  if (d?.signature) {
    const s = d.signature;
    console.log(`  signed digest          ${s.signedDigest}   (${s.scheme}, message = raw 32-byte keccak256(canonical))`);
    console.log(`  recovered signer       ${s.recoveredSigner}${s.matchesClaimed ? "  (= signer in receipt)" : "  (DIFFERS from receipt signer " + s.claimedSigner + ")"}${s.matchesPublishedKey == null ? "" : s.matchesPublishedKey ? "  (= key published at /.well-known/jwks.json)" : "  (NOT the published jwks key)"}`);
  }
  if (d?.settlement) {
    const t = d.settlement;
    console.log("\nfinalize payout");
    console.log(`  settle tx              ${t.txHash} (block ${t.blockNumber}), payoutBps ${t.payoutBps}`);
    for (const x of t.transfers) console.log(`  USDC transfer          escrow -> ${x.to}  ${x.value} atomic`);
    console.log(`  to provider            ${t.toProvider} atomic USDC of ${t.jobAmount}`);
    console.log(`  refund to client       ${t.toClient} atomic USDC${t.toClient === "0" ? "  (no refund leg)" : ""}`);
  }
}

const fmt = (r) => `${r.status === "pass" ? "PASS" : r.status === "skip" ? "skip" : "FAIL"}  ${r.id.padEnd(34)} ${r.claim}${r.reason ? `  [${r.reason}]` : ""}`;

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  const jobId = a._[0];
  if (!jobId || !/^\d+$/.test(jobId)) { console.error("usage: agentkoin-judge-kit verify <jobId> [--escrow 0x..] [--rpc URL] [--server URL] [--proof FILE] [--window N] [--no-sourcify] [--no-server] [--json]"); return 2; }
  const escrow = a.flags.escrow ?? DEFAULT_ESCROW;
  if (!ESCROWS[escrow.toLowerCase()] && !a.flags.rpc) console.error(`note: ${escrow} is not a known AgentKoin escrow`);
  const r = await verifyJob({ jobId, escrow, rpc: a.flags.rpc, server: a.flags.server, proofFile: a.flags.proof, window: a.flags.window, sourcify: !a.flags["no-sourcify"], noServer: !!a.flags["no-server"] });
  if (a.flags.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`job ${r.jobId} on ${r.escrow} (${r.escrowVersion}) via ${r.rpc}`);
    for (const x of r.results) console.log(fmt(x));
    printDetails(r.details);
    for (const n of r.notes) console.log("note: " + n);
    console.log(`${r.ok ? "OK" : "FAILED"}: ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped${r.evaluator ? `; evaluator ${r.evaluator}` : ""}`);
  }
  return r.ok ? 0 : 1;
}
