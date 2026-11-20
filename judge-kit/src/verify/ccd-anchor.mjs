// Concordium anchor (scope: docs/concordium-anchor-scope.md). A settled job's frozen proof core is anchored on Concordium
// testnet with one RegisterData transaction whose payload is:
//   "AGK1"(4) | sha256(JCS(proof core))(32) | jobId uint64 BE(8) | escrow(20) | chainId uint32 BE(4)  = 68 bytes  (<= 256)
// "proof core" = the proof bundle without `signature`, `anchors` and `badges` (the anchor tx hash cannot be inside what it anchors).
// This module is shared by the service and the verify CLI (copied to judge-kit/src/verify by tools/sync-verify.mjs's convention).
// Nothing here talks to a network except sdkNodeReader(), which does read-only gRPC queries via a lazily imported SDK.
import { createHash } from "node:crypto";
import { jcs } from "./canonical.mjs";

export const ANCHOR_MAGIC = "AGK1";
export const ANCHOR_MAX_BYTES = 256; // MAX_REGISTERED_DATA_SIZE (Concordium docs)
export const DEFAULT_CCD_GRPC = { host: "grpc.testnet.concordium.com", port: 20000 };
// Public Concordium-run REST gateway (the wallet's backend). Needs no SDK and, unlike gRPC :20000, is reachable through ordinary HTTPS egress.
export const DEFAULT_CCD_PROXY = "https://wallet-proxy.testnet.concordium.com";
export const DEFAULT_CCDSCAN = "https://api-ccdscan.testnet.concordium.com/api/graphql";
const HEX = /^0x[0-9a-fA-F]*$/;
const strip0x = (h) => String(h).replace(/^0x/i, "").toLowerCase();

export const sha256Hex0x = (bytes) => "0x" + createHash("sha256").update(bytes).digest("hex");

/** The part of a proof bundle that is anchored: everything except `signature`, `anchors` and `badges`. */
export function proofCore(proof) {
  const { signature: _s, anchors: _a, badges: _b, ...core } = proof ?? {};
  return core;
}
export const proofCoreBytes = (proof) => Buffer.from(jcs(proofCore(proof)), "utf8");
export const proofCoreSha256 = (proof) => sha256Hex0x(proofCoreBytes(proof));

/** 68-byte AGK1 payload. All inputs are validated; throws on malformed input. */
export function buildAnchorPayload({ coreSha256, jobId, escrow, chainId }) {
  const h = strip0x(coreSha256);
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("coreSha256 must be 32 bytes hex");
  const e = strip0x(escrow);
  if (!/^[0-9a-f]{40}$/.test(e)) throw new Error("escrow must be a 20-byte address");
  const j = BigInt(jobId);
  if (j < 0n || j >= 1n << 64n) throw new Error("jobId out of uint64 range");
  const c = BigInt(chainId);
  if (c < 0n || c >= 1n << 32n) throw new Error("chainId out of uint32 range");
  const b = Buffer.alloc(68);
  b.write(ANCHOR_MAGIC, 0, "ascii");
  Buffer.from(h, "hex").copy(b, 4);
  b.writeBigUInt64BE(j, 36);
  Buffer.from(e, "hex").copy(b, 44);
  b.writeUInt32BE(Number(c), 64);
  return b;
}
export const anchorPayloadHex = (o) => buildAnchorPayload(o).toString("hex");

export function parseAnchorPayload(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(strip0x(buf), "hex");
  if (b.length !== 68) throw new Error(`anchor payload must be 68 bytes, got ${b.length}`);
  if (b.toString("ascii", 0, 4) !== ANCHOR_MAGIC) throw new Error("bad magic (not an AGK1 anchor)");
  return { coreSha256: "0x" + b.toString("hex", 4, 36), jobId: b.readBigUInt64BE(36).toString(), escrow: "0x" + b.toString("hex", 44, 64), chainId: b.readUInt32BE(64) };
}

/** Normalise an SDK BlockItemStatus (or a plain-object mock of it) to {state, kind, success, dataHex, sender, blockHash}. */
export function normalizeBlockItemStatus(st, { hex = defHex, addr = defHex } = {}) {
  if (!st) return { state: "unknown" };
  if (st.status === "received") return { state: "received" };
  const outcome = st.status === "finalized" ? st.outcome : st.status === "committed" ? st.outcomes?.[0] : null;
  if (!outcome) return { state: "unknown" };
  const s = outcome.summary ?? {};
  const failed = s.transactionType === "failed";
  return {
    state: st.status,
    kind: s.type === "accountTransaction" ? s.transactionType : s.type ?? null,
    success: s.type === "accountTransaction" && !failed,
    dataHex: s.dataRegistered?.data != null ? strip0x(s.dataRegistered.data) : null,
    sender: s.sender != null ? addr(s.sender) : null,
    blockHash: outcome.blockHash != null ? hex(outcome.blockHash) : null,
  };
}
/** Normalise a wallet-proxy GET /v0/submissionStatus/{hash} body. Shape VERIFIED live 2026-11-20 against a real testnet RegisterData tx:
 *  {status:"finalized", outcome:"success", registeredData:"<raw hex>", sender, blockHashes:[..], cost, transactionHash}; unknown tx -> {status:"absent"}. */
export function normalizeProxyStatus(j) {
  if (!j || j.status === "absent") return { state: "unknown" };
  if (j.status === "received") return { state: "received" };
  const success = j.outcome === "success";
  return { state: j.status, kind: j.registeredData != null ? "registerData" : success ? "other" : null, success, dataHex: j.registeredData != null ? String(j.registeredData).toLowerCase() : null, sender: j.sender ?? null, blockHash: j.blockHashes?.[0] ?? null };
}

/** Read-only reader over the public wallet-proxy REST (no SDK). Block height is looked up on CCDScan (optional, best effort). */
export function proxyNodeReader({ base = DEFAULT_CCD_PROXY, scan = DEFAULT_CCDSCAN, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  return {
    endpoint: base,
    async getTx(txHash) {
      const res = await fetchImpl(`${base}/v0/submissionStatus/${strip0x(txHash)}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`wallet-proxy answered HTTP ${res.status}`);
      const n = normalizeProxyStatus(await res.json());
      if (n.blockHash && scan) {
        try {
          const r = await fetchImpl(scan, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query($h:String!){blockByBlockHash(blockHash:$h){blockHeight}}", variables: { h: n.blockHash } }), signal: AbortSignal.timeout(timeoutMs) });
          const h = (await r.json())?.data?.blockByBlockHash?.blockHeight;
          if (h != null) n.blockHeight = String(h);
        } catch { /* optional */ }
      }
      return n;
    },
  };
}

const defHex = (x) => (typeof x === "string" ? x : x?.address ?? String(x));

/** Read-only node reader over the Concordium JS SDK (lazy import, so judge-kit stays light until an anchor exists). */
export async function sdkNodeReader({ host = DEFAULT_CCD_GRPC.host, port = DEFAULT_CCD_GRPC.port, timeoutMs = 20000, sdk = null } = {}) {
  sdk ??= await import("@concordium/web-sdk/nodejs");
  const client = new sdk.ConcordiumGRPCNodeClient(host, port, sdk.credentials.createSsl(), { timeout: timeoutMs });
  const helpers = { hex: (h) => (typeof h === "string" ? h : sdk.BlockHash.toHexString(h)), addr: (a) => (typeof a === "string" ? a : sdk.AccountAddress.toBase58(a)) };
  return {
    endpoint: `${host}:${port}`,
    async getTx(txHash) {
      let st;
      try { st = await client.getBlockItemStatus(sdk.TransactionHash.fromHexString(strip0x(txHash))); }
      catch (e) { if (/NOT_FOUND|not found/i.test(String(e?.code ?? "") + String(e?.message ?? ""))) return { state: "unknown" }; throw e; }
      const n = normalizeBlockItemStatus(st, helpers);
      if (n.blockHash) { try { n.blockHeight = String((await client.getBlockInfo(sdk.BlockHash.fromHexString(n.blockHash))).blockHeight); } catch { /* optional */ } }
      return n;
    },
    async genesis() { return helpers.hex((await client.getConsensusStatus()).genesisBlock); },
  };
}

/**
 * The `concordium-anchor` verify check. `expect` must come from chain-derived values (jobId, escrow, chainId), never from the bundle.
 * `reader` = { getTx(txHash) -> normalised status, genesis?() }, or `readerFactory()` -> reader (lazy; a throw means SDK/node unavailable).
 * Returns {id, claim, how, expected, actual, status: pass|fail|skip, reason?}.
 */
export async function verifyConcordiumAnchor({ proof, expect, reader = null, readerFactory = null, expectedSender = null, expectedGenesis = null }) {
  const base = { id: "concordium-anchor", claim: "the proof's hash is anchored on Concordium (RegisterData, finalized, bytes match)", how: "recompute sha256(JCS(proof minus signature/anchors)), rebuild the AGK1 payload from chain-derived jobId/escrow/chainId, read the tx from a Concordium node, require RegisterData + success + finalized + identical bytes" };
  const skip = (reason) => ({ ...base, expected: null, actual: null, status: "skip", reason });
  const fail = (reason, expected = null, actual = null) => ({ ...base, expected, actual, status: "fail", reason });
  const a = proof?.anchors?.concordium;
  if (!proof) return skip("no proof bundle available; nothing to anchor-check");
  if (!a) return skip("no Concordium anchor in this proof (job not anchored, or it predates anchoring)");
  if (!a.txHash) return skip(`Concordium anchor is ${a.status ?? "not yet submitted"}; no transaction to check yet`);
  let expectedHex;
  const coreSha256 = proofCoreSha256(proof);
  try { expectedHex = anchorPayloadHex({ coreSha256, jobId: expect.jobId, escrow: expect.escrow, chainId: expect.chainId }); }
  catch (e) { return fail("cannot rebuild payload: " + e.message); }
  if (a.coreSha256 && strip0x(a.coreSha256) !== strip0x(coreSha256)) return fail("bundle's anchors.concordium.coreSha256 differs from the hash of its own contents (proof modified after anchoring)", coreSha256, a.coreSha256);
  if (a.payloadHex && strip0x(a.payloadHex) !== expectedHex) return fail("bundle's anchor payload differs from the payload rebuilt from chain-derived values", expectedHex, strip0x(a.payloadHex));
  try { reader ??= await readerFactory?.(); } catch (e) { return skip(`could not start the Concordium node client (${String(e.message ?? e).slice(0, 120)}); install @concordium/web-sdk or pass --ccd-grpc`); }
  if (!reader) return skip("no Concordium node client configured");
  let tx;
  try { tx = await reader.getTx(a.txHash); }
  catch (e) { return skip(`could not reach the Concordium node (${String(e.message ?? e).slice(0, 120)}); try --ccd-grpc host:port`); }
  if (!tx || tx.state === "unknown") return fail("the Concordium node has no such transaction", a.txHash, null);
  if (tx.state !== "finalized") return fail(`transaction is ${tx.state}, not finalized`, "finalized", tx.state);
  if (tx.kind !== "registerData") return fail("transaction is not a RegisterData transaction", "registerData", tx.kind);
  if (!tx.success) return fail("transaction did not succeed", "success", "failed");
  if (strip0x(tx.dataHex ?? "") !== expectedHex) return fail("registered data differs from the expected AGK1 payload", expectedHex, tx.dataHex);
  if (expectedSender && tx.sender && tx.sender !== expectedSender) return fail("anchor was sent by an unexpected account", expectedSender, tx.sender);
  if (expectedGenesis && reader.genesis) { try { const g = strip0x(await reader.genesis()); if (g !== strip0x(expectedGenesis)) return fail("node is on a different network than expected (genesis differs)", expectedGenesis, g); } catch { /* optional */ } }
  return { ...base, expected: expectedHex, actual: tx.dataHex, status: "pass", detail: { txHash: a.txHash, blockHash: tx.blockHash ?? null, blockHeight: tx.blockHeight ?? null, sender: tx.sender ?? null } };
}
