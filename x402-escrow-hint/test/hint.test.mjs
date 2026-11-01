import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { escrowHint, withEscrowHint, escrowHintMiddleware, EXTENSION_KEY, BASE_SEPOLIA_ESCROW, DEFAULT_AGENTCOIN_URL } from "../index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const PROVIDER = "0x" + "12".repeat(20);
const PR = { x402Version: 2, error: "payment required", resource: { url: "https://seller.test/x" }, accepts: [{ scheme: "exact", network: "eip155:84532", amount: "10000", asset: BASE_SEPOLIA_ESCROW.token, payTo: PROVIDER, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }], extensions: { bazaar: { info: {} } } };

test("withEscrowHint: adds extensions['agentcoin-escrow'], accepts and other fields unchanged, input not mutated", () => {
  const before = structuredClone(PR);
  const out = withEscrowHint(PR, { provider: PROVIDER, serviceId: "svc_" + "a".repeat(16) });
  assert.deepEqual(PR, before);
  assert.notEqual(out, PR);
  assert.deepEqual(out.accepts, PR.accepts);
  assert.deepEqual(out.extensions.bazaar, PR.extensions.bazaar);
  assert.deepEqual(Object.keys(out), Object.keys(PR));
  for (const k of Object.keys(PR)) if (k !== "extensions") assert.deepEqual(out[k], PR[k]);
  const { info, schema } = out.extensions[EXTENSION_KEY];
  assert.equal(info.v, "agentcoin-escrow-hint/v1");
  assert.equal(info.chainId, 84532);
  assert.equal(info.escrow.contract, BASE_SEPOLIA_ESCROW.escrowContract);
  assert.equal(info.escrow.x402Scheme, "agentcoin-escrow");
  assert.equal(info.router.reputation, `${BASE_SEPOLIA_ESCROW.routerUrl}/v1/reputation/svc_${"a".repeat(16)}`);
  assert.deepEqual(info.escrow.refunds.map((r) => r.call.split("(")[0]), ["claimRefund", "cancel", "timeoutRelease", "finalize"]);
  assert.deepEqual(schema.required, ["v", "escrowAvailable", "network", "chainId", "router", "escrow"]);
  assert.doesNotMatch(JSON.stringify(out), /guarantee|you should/i);
  // without extensions in the input
  const { extensions: _e, ...bare } = PR;
  assert.deepEqual(Object.keys(withEscrowHint(bare, { provider: PROVIDER }).extensions), [EXTENSION_KEY]);
});

test("validation: provider required, Base Sepolia only, PaymentRequired shape", () => {
  assert.throws(() => escrowHint({ provider: "x" }), /provider/);
  assert.throws(() => escrowHint({ provider: PROVIDER, deployment: { chainId: 8453, network: "eip155:8453" } }), /Base Sepolia/);
  assert.throws(() => escrowHint({ provider: PROVIDER, serviceId: "nope" }), /serviceId/);
  assert.throws(() => withEscrowHint({ x402Version: 2 }, { provider: PROVIDER }), /accepts/);
});

test("middleware: only 402 PaymentRequired bodies are extended", () => {
  const mw = escrowHintMiddleware({ provider: PROVIDER });
  const mk = (status) => { const sent = []; const res = { statusCode: status, json: (b) => sent.push(b) }; mw({}, res, () => {}); return { res, sent }; };
  const a = mk(402); a.res.json(PR);
  assert.ok(a.sent[0].extensions[EXTENSION_KEY]);
  assert.deepEqual(a.sent[0].accepts, PR.accepts);
  const b = mk(200); b.res.json({ ok: 1 });
  assert.deepEqual(b.sent[0], { ok: 1 });
  const c = mk(402); c.res.json({ error: "x" });
  assert.deepEqual(c.sent[0], { error: "x" });
});

test("default service URL equals @agentcoin/core DEFAULT_AGENTCOIN_URL", async () => {
  const core = await import("../../core-ts/src/constants.ts");
  assert.equal(DEFAULT_AGENTCOIN_URL, core.DEFAULT_AGENTCOIN_URL);
});

test("constants match deployments/base-sepolia.json; Python helper emits identical JSON", () => {
  const d = JSON.parse(readFileSync(path.join(ROOT, "deployments/base-sepolia.json"), "utf8"));
  assert.equal(BASE_SEPOLIA_ESCROW.escrowContract, d.contracts.JobEscrow.address);
  assert.equal(BASE_SEPOLIA_ESCROW.evaluatorRegistry, d.contracts.EvaluatorRegistry.address);
  assert.equal(BASE_SEPOLIA_ESCROW.token, d.usdc.address);
  assert.equal(BASE_SEPOLIA_ESCROW.evalWindowSeconds, d.params.evalWindow);
  assert.equal(BASE_SEPOLIA_ESCROW.challengeWindowSeconds, d.params.challengeWindow);
  assert.equal(BASE_SEPOLIA_ESCROW.evaluatorMinStake, String(d.params.minStake));
  const py = path.join(ROOT, "python/.venv/bin/python");
  if (!existsSync(py)) return;
  const out = execFileSync(py, ["-c", `import json; from agentcoin_core.escrow_hint import escrow_hint; print(json.dumps(escrow_hint(provider="${PROVIDER}", service_id="svc_${"b".repeat(16)}")))`], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), escrowHint({ provider: PROVIDER, serviceId: "svc_" + "b".repeat(16) }));
});
