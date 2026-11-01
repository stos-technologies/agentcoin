import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData } from "viem";
import { AgentCoin, assertChainAllowed, toolSpecs, runTool, fromEnv, BASE_SEPOLIA, ESCROW_ABI } from "../src/index.ts";
import { makeMock, BASE, SERVICE_ID, PAY_TO } from "./mock.ts";
import { mockClient } from "./setup.ts";

const pk = generatePrivateKey();
const acct = privateKeyToAccount(pk);
const mk = (mo: any = {}, co: any = {}) => { const m = makeMock(acct.address, mo); return { m, c: new AgentCoin({ baseUrl: BASE, account: pk, fetch: m.fetch, publicClient: m.publicClient, walletClient: m.walletClient, pollIntervalMs: 1, verdictTimeoutMs: 50, ...co }) }; };

test("defaults to Base Sepolia and refuses mainnet chain ids", () => {
  const c = new AgentCoin({ fetch: (async () => new Response("{}")) as any });
  assert.equal(c.chainId, 84532);
  assert.equal(c.baseUrl, BASE_SEPOLIA.routerUrl);
  for (const id of [1, 8453, 137, 42161, 10]) assert.throws(() => new AgentCoin({ chainId: id }), /mainnet/);
  assert.throws(() => assertChainAllowed(8453), (e: any) => e.code === "mainnet_refused");
  assert.throws(() => new AgentCoin({ chainId: 8453, allowMainnet: true }), /no USDC address/);
  assert.equal(c.address, null);
});

test("findService: query string and id path", async () => {
  const { m, c } = mk();
  const r = await c.findService({ q: "notary", limit: 5, claimed: true });
  assert.deepEqual(r.query, { q: "notary", limit: "5", claimed: "true" });
  await c.findService({ id: SERVICE_ID });
  assert.equal(m.calls.at(-1)!.url, `${BASE}/v1/services/${SERVICE_ID}`);
});

test("routeTask adds the chain network constraint", async () => {
  const { c } = mk();
  const r = await c.routeTask({ task: "notarize", budget: "10000", constraints: { limit: 3 } });
  assert.deepEqual(r.received, { task: "notarize", budget: "10000", constraints: { network: "eip155:84532", limit: 3 } });
});

test("placeOrder: buyer, origin, allowlist", async () => {
  const { m, c } = mk({}, { origin: "agentcoin" });
  await c.placeOrder({ serviceId: SERVICE_ID });
  assert.deepEqual(m.calls.at(-1)!.body, { serviceId: SERVICE_ID, mode: "direct", buyer: acct.address, origin: "agentcoin" });
  const { c: c2 } = mk({}, { allowedServiceIds: ["svc_other"] });
  await assert.rejects(c2.placeOrder({ serviceId: SERVICE_ID }), (e: any) => e.code === "service_not_allowed");
  const ro = new AgentCoin({ baseUrl: BASE, fetch: makeMock(acct.address).fetch });
  await assert.rejects(ro.placeOrder({ serviceId: SERVICE_ID, mode: "escrow" }), (e: any) => e.code === "no_account");
});

test("payDirect (x402 v2): signs EIP-3009, retries, records receipt", async () => {
  const { m, c } = mk();
  const order = await c.placeOrder({ serviceId: SERVICE_ID });
  const r = await c.payDirect(order, { body: { sha256: "0x" + "ab".repeat(32) } });
  assert.equal(r.paymentTx, "0x" + "11".repeat(32));
  assert.equal(r.order.verdict, "delivered");
  const sellerPaid = m.calls.find((x) => x.headers["payment-signature"]);
  assert.ok(sellerPaid, "retry carries PAYMENT-SIGNATURE");
  const receipt = m.calls.find((x) => x.url.endsWith("/receipt"))!;
  assert.equal(receipt.body.paymentTx, r.paymentTx);
  assert.deepEqual(receipt.body.deliverable, { receipt: { digest: "0x" + "ab".repeat(32) } });
});

test("payDirect (x402 v1 body + X-PAYMENT)", async () => {
  const { m, c } = mk({ v1: true });
  const r = await c.payDirect(await c.placeOrder({ serviceId: SERVICE_ID }), { body: {} });
  assert.equal(r.paymentTx, "0x" + "11".repeat(32));
  assert.ok(m.calls.find((x) => x.headers["x-payment"]));
});

test("payDirect refuses mainnet network, wrong asset, over max, payTo mismatch", async () => {
  { const { c } = mk({ network: "eip155:8453" }); await assert.rejects(c.payDirect(await c.placeOrder({ serviceId: SERVICE_ID })), (e: any) => e.code === "wrong_network"); }
  { const { c } = mk({ asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }); await assert.rejects(c.payDirect(await c.placeOrder({ serviceId: SERVICE_ID })), (e: any) => e.code === "wrong_asset"); }
  { const { c } = mk({ amount: "60000" }); await assert.rejects(c.payDirect(await c.placeOrder({ serviceId: SERVICE_ID })), (e: any) => e.code === "over_max_payment"); }
  { const { m, c } = mk({ sellerPayTo: "0x000000000000000000000000000000000000dEaD" }); await assert.rejects(c.payDirect(await c.placeOrder({ serviceId: SERVICE_ID })), (e: any) => e.code === "payto_mismatch"); assert.ok(!m.calls.some((x) => x.headers["payment-signature"]), "nothing signed"); }
  assert.ok(PAY_TO);
});

test("payEscrow: checks and sends approve + createAndFundFor, records job, calls seller", async () => {
  const { m, c } = mk();
  const order = await c.placeOrder({ serviceId: SERVICE_ID, mode: "escrow" });
  const r = await c.payEscrow(order, { body: { sha256: "0x" + "ab".repeat(32) } });
  assert.equal(r.jobId, "42");
  assert.equal(m.sent.length, 2);
  assert.equal(decodeFunctionData({ abi: ESCROW_ABI, data: m.sent[1].data }).functionName, "createAndFundFor");
  const rc = m.calls.find((x) => x.url.endsWith("/receipt"))!;
  assert.deepEqual(rc.body, { jobId: "42", paymentTx: r.paymentTx });
  const sc = m.calls.find((x) => x.headers["payment-signature"])!;
  assert.equal(JSON.parse(Buffer.from(sc.headers["payment-signature"], "base64").toString()).accepted.scheme, "agentcoin-escrow");
  assert.equal(r.sellerStatus, 200);
  const v = await c.waitForVerdict(order.orderId);
  assert.equal(v.verdict, "complete");
});

test("payEscrow refuses tampered transactions before sending", async () => {
  for (const tamper of ["spender", "client", "contract"] as const) {
    const { m, c } = mk({ tamper });
    const order = await c.placeOrder({ serviceId: SERVICE_ID, mode: "escrow" });
    await assert.rejects(c.payEscrow(order), (e: any) => ["bad_tx", "wrong_escrow"].includes(e.code), tamper);
    assert.equal(m.sent.length, 0, `${tamper}: no tx sent`);
  }
});

test("reputation: local EIP-191 + evidence root checks; operator signer flag", async () => {
  const { c } = mk();
  const r = await c.reputation(SERVICE_ID);
  assert.equal(r.checks.signatureValid, true);
  assert.equal(r.checks.evidenceRootMatches, true);
  assert.equal(r.checks.signerIsOperator, false, "mock key is not the operator");
  const v = await c.verify({ serviceId: SERVICE_ID, document: { a: 1 } });
  assert.equal(v.document.valid, true);
  await assert.rejects(c.verify({}), (e: any) => e.code === "bad_args");
});

test("refund picks the call for the job state", async () => {
  const { m, c } = mk();
  m.jobState.state = 2; m.jobState.accepted = false;
  let r = await c.refund(42);
  assert.equal(r.action, "cancel"); assert.equal(r.sent, true);
  m.jobState.accepted = true; m.jobState.deadline = 1n;
  r = await c.refund(42); assert.equal(r.action, "claimRefund");
  m.jobState.state = 5; r = await c.refund(42); assert.equal(r.action, "finalize");
  m.jobState.state = 8; r = await c.refund(42); assert.equal(r.sent, false); assert.match(r.reason, /Settled/);
});

test("buy: route filtered by allowlist, then order, pay, verify", async () => {
  const { c } = mk({}, { allowedServiceIds: [SERVICE_ID] });
  const r = await c.buy({ task: "notarize a hash", body: { sha256: "0x" + "ab".repeat(32) } });
  assert.equal(r.serviceId, SERVICE_ID);
  assert.equal(r.final.verdict, "delivered");
  assert.equal(r.verification.service.checks.signatureValid, true);
  const { c: e } = mk({}, { allowedServiceIds: [SERVICE_ID] });
  const re = await e.buy({ serviceId: SERVICE_ID, mode: "escrow", body: {} });
  assert.equal(re.order.jobId, "42"); assert.equal(re.final.verdict, "complete");
});

test("tool specs and runTool", async () => {
  assert.deepEqual(toolSpecs.map((t) => t.name), ["find_service", "route_task", "place_order", "get_order", "claim_listing", "verify", "refund"]);
  for (const t of toolSpecs) { assert.equal(t.parameters.type, "object"); assert.ok(t.description.length <= 400); assert.doesNotMatch(t.description, /\b(you should|must use|best|always use)\b/i); }
  const m = makeMock(acct.address);
  const ro = new AgentCoin({ baseUrl: BASE, fetch: m.fetch });
  const u = await runTool(ro, "place_order", { serviceId: SERVICE_ID });
  assert.equal(u.unsigned, true);
  const cl = await runTool(ro, "claim_listing", { url: "https://seller.test/.well-known/agent-card.json" });
  assert.equal(cl.submitted.listing.id, "svc_new0000000001");
  const { c } = mk();
  const s = await runTool(c, "claim_listing", { serviceId: "svc_new0000000001", sign: true });
  assert.equal(s.received.claimant, acct.address);
  assert.match(s.received.signature, /^0x[0-9a-f]{130}$/);
  const r = await runTool(c, "route_task", { task: "x y", budget: "1", limit: 2 });
  assert.deepEqual(r.received.constraints, { network: "eip155:84532", limit: 2 });
  await assert.rejects(runTool(c, "nope"), /unknown tool/);
});

test("fromEnv", () => {
  const c = fromEnv({}, { AGENTCOIN_PRIVATE_KEY: pk, AGENTCOIN_MAX_PAYMENT: "20000", AGENTCOIN_ALLOWED_SERVICE_IDS: "a, b", AGENTCOIN_ORIGIN: "agentcoin" });
  assert.equal(c.address, acct.address); assert.equal(c.maxPayment, 20000n); assert.deepEqual([...c.allowedServiceIds!], ["a", "b"]); assert.equal(c.origin, "agentcoin");
  assert.throws(() => fromEnv({}, { AGENTCOIN_CHAIN_ID: "8453" }), /mainnet/);
});

test("waitForVerdict keeps polling after a failed order read", async () => {
  const { client } = mockClient();
  let n = 0;
  (client as any).getOrder = async (id: string) => { n++; if (n === 1) throw new TypeError("fetch failed"); return { orderId: id, verdict: "complete" }; };
  const o = await client.waitForVerdict("ord_x", { timeoutMs: 5000, intervalMs: 0 });
  assert.equal(o.verdict, "complete");
  assert.equal(n, 2);
});

test("service URL: DEFAULT_AGENTCOIN_URL, AGENTCOIN_URL override, legacy AGENTCOIN_BASE_URL", async () => {
  const { DEFAULT_AGENTCOIN_URL, agentcoinUrl } = await import("../src/index.ts");
  assert.equal(BASE_SEPOLIA.routerUrl, DEFAULT_AGENTCOIN_URL);
  assert.equal(agentcoinUrl({}), DEFAULT_AGENTCOIN_URL);
  assert.equal(agentcoinUrl({ AGENTCOIN_URL: "https://svc.example/", AGENTCOIN_BASE_URL: "https://old.example" }), "https://svc.example");
  assert.equal(agentcoinUrl({ AGENTCOIN_BASE_URL: "https://old.example" }), "https://old.example");
  assert.equal(fromEnv({}, { AGENTCOIN_URL: "https://svc.example" }).baseUrl, "https://svc.example");
  assert.equal(fromEnv({}, {}).baseUrl, DEFAULT_AGENTCOIN_URL);
});
