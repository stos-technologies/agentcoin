// AgentKoin Exchange helpers: x402 hire checks (payTo == routeFor(offer), maxPayment, escrow), signed listing create. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, getAddress } from "viem";
import { AgentCoin, exchangeFeeMax, exchangeToolSpecs, runTool, allToolSpecs, toolSpecs, BASE_SEPOLIA } from "../src/index.ts";

const BASE = "https://ex.test";
const ROUTE = "0x82f1Df21D32431fb2D974C051E8Ea24f179e12eE";
const FACTORY = "0x32174eFD01e600E621Cf3f0D19Ff694483B19b95";
const LID = "lst_294b97b984a7dc02";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

function mock(o: { amount?: string; route?: string; escrow?: string; fee?: string } = {}) {
  const calls: any[] = [];
  const amount = o.amount ?? "10000";
  const req = { scheme: "exact", network: "eip155:84532", amount, asset: BASE_SEPOLIA.usdc, payTo: ROUTE, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2", agentcoin: { depositRouteFactory: FACTORY, escrowContract: o.escrow ?? BASE_SEPOLIA.escrow, offer: { provider: "0x745528C4E0CBdA5759175A660da06d0aaA72db7F", evaluator: "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a", amount, deadlineSeconds: 3600, specHash: "0x" + "62".repeat(32) }, ...(o.fee ? { exchangeFee: { fee: o.fee, requirement: { scheme: "exact", network: "eip155:84532", amount: o.fee, asset: BASE_SEPOLIA.usdc, payTo: "0x000000000000000000000000000000000000FEE0", maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } } } } : {}) } } };
  const json = (s: number, b: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...h } });
  const fetch = async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const h = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? "GET", path: url.pathname + url.search, headers: h, body });
    if (url.pathname === `/exchange/v1/listings/${LID}/hire`) {
      if (!h["payment-signature"]) return json(402, { x402Version: 2, accepts: [req] }, { "PAYMENT-REQUIRED": b64({ x402Version: 2, resource: { url: String(input) }, accepts: [req] }) });
      return json(201, { order_id: "xo_7357afe788d69ba0", job_id: "37", status: "funded" }, { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0x" + "89".repeat(32) }) });
    }
    if (url.pathname === "/exchange/v1/listings" && init.method === "POST") {
      if (!body.signature) return json(400, { error: "signature required", eip712: { domain: { name: "AgentKoin Exchange", version: "1", chainId: 84532 }, types: { Listing: [{ name: "seller", type: "address" }, { name: "listingHash", type: "bytes32" }, { name: "expiresAt", type: "uint256" }] }, primaryType: "Listing", message: { seller: body.seller, listingHash: "0x" + "aa".repeat(32), expiresAt: "1795400000" } } });
      return json(201, { status: "created", signature: body.signature, expiresAt: body.expiresAt });
    }
    if (url.pathname.startsWith("/exchange/v1/")) return json(200, { path: url.pathname, search: url.search });
    return json(404, { error: "not found" });
  };
  const publicClient: any = {
    readContract: async (a: any) => { calls.push({ readContract: a.functionName, address: a.address, args: a.args }); return o.route ?? ROUTE; },
    getBlock: async () => ({ timestamp: 1795395900n }),
  };
  return { calls, fetch, publicClient };
}
const client = (m: any, co: any = {}) => new AgentCoin({ baseUrl: BASE, account: generatePrivateKey(), fetch: m.fetch as any, publicClient: m.publicClient, ...co });

test("exchange tool specs: twelve tools, router specs unchanged unless exchange: true", () => {
  assert.deepEqual(exchangeToolSpecs.map((t) => t.name), ["exchange_find", "exchange_hire", "exchange_get_order", "create_listing", "get_agent_profile", "list_evaluators", "find_earning_opportunities", "list_open_jobs", "post_job", "claim_job", "join_beta", "get_fee_credits"]);
  assert.equal(toolSpecs.length, 7);
  assert.equal(allToolSpecs().length, 7);
  assert.equal(allToolSpecs({ exchange: true }).length, 19);
  for (const t of exchangeToolSpecs) assert.equal(t.parameters.additionalProperties, false);
});

test("exchange_hire: 402 -> routeFor(offer) check -> signed EIP-3009 -> funded order (one paid request)", async () => {
  const m = mock();
  const c = client(m);
  const r = await runTool(c, "exchange_hire", { listingId: LID, skillId: "notarize", input: { digest: "0x" + "11".repeat(32) } });
  assert.equal(r.job_id, "37");
  assert.equal(r.paymentResponse.success, true);
  const rc = m.calls.find((x) => x.readContract);
  assert.equal(rc.readContract, "routeFor");
  assert.equal(getAddress(rc.address), FACTORY);
  assert.equal(rc.args[0].amount, 10000n);
  const paid = m.calls.filter((x) => x.headers?.["payment-signature"]);
  assert.equal(paid.length, 1);
  const pp = unb64(paid[0].headers["payment-signature"]);
  assert.equal(pp.payload.authorization.from, c.address);
  assert.equal(getAddress(pp.payload.authorization.to), ROUTE);
  assert.equal(pp.payload.authorization.value, "10000");
  assert.deepEqual(paid[0].body.input, { digest: "0x" + "11".repeat(32) });
});

test("exchange_hire refuses: payTo != routeFor, price > maxPayment, wrong escrow, listing outside allowedServiceIds", async () => {
  await assert.rejects(runTool(client(mock({ route: "0x000000000000000000000000000000000000dEaD" })), "exchange_hire", { listingId: LID }), /routeFor/);
  await assert.rejects(runTool(client(mock({ amount: "60000" })), "exchange_hire", { listingId: LID }), /maxPayment/);
  await assert.rejects(runTool(client(mock({ escrow: "0x000000000000000000000000000000000000bEEF" })), "exchange_hire", { listingId: LID }), /escrow/);
  await assert.rejects(runTool(client(mock(), { allowedServiceIds: ["lst_0000000000000000"] }), "exchange_hire", { listingId: LID }), /allowedServiceIds/);
  for (const bad of [mock({ route: "0x000000000000000000000000000000000000dEaD" }), mock({ amount: "60000" })]) {
    await runTool(client(bad), "exchange_hire", { listingId: LID }).catch(() => {});
    assert.equal(bad.calls.filter((x) => x.headers?.["payment-signature"]).length, 0);
  }
  const ro = new AgentCoin({ baseUrl: BASE, fetch: mock().fetch as any });
  const r = await runTool(ro, "exchange_hire", { listingId: LID });
  assert.equal(r.unsigned, true);
});

test("create_listing signs the server's EIP-712 Listing with the seller wallet; read tools hit the documented paths", async () => {
  const pk = generatePrivateKey();
  const m = mock();
  const c = new AgentCoin({ baseUrl: BASE, account: pk, fetch: m.fetch as any });
  const r = await runTool(c, "create_listing", { listing: { title: "x" } });
  assert.equal(r.status, "created");
  const sent = m.calls.filter((x) => x.path === "/exchange/v1/listings" && x.method === "POST");
  assert.equal(sent.length, 2);
  const td = { domain: { name: "AgentKoin Exchange", version: "1", chainId: 84532 }, types: { Listing: [{ name: "seller", type: "address" }, { name: "listingHash", type: "bytes32" }, { name: "expiresAt", type: "uint256" }] }, primaryType: "Listing" as const, message: { seller: c.address as `0x${string}`, listingHash: ("0x" + "aa".repeat(32)) as `0x${string}`, expiresAt: 1795400000n } };
  assert.equal(await recoverTypedDataAddress({ ...td, signature: sent[1].body.signature }), privateKeyToAccount(pk).address);
  const un = await runTool(new AgentCoin({ baseUrl: BASE, fetch: mock().fetch as any }), "create_listing", { listing: { title: "x" }, seller: privateKeyToAccount(pk).address });
  assert.equal(un.status, "signature-required");
  assert.equal(un.eip712.primaryType, "Listing");
  assert.equal((await runTool(c, "exchange_find", { q: "notary", maxPrice: "20000" })).search, "?q=notary&maxPrice=20000");
  assert.equal((await runTool(c, "exchange_get_order", { orderId: "xo_7357afe788d69ba0" })).path, "/exchange/v1/orders/xo_7357afe788d69ba0");
  assert.equal((await runTool(c, "get_agent_profile", { address: c.address })).path, `/exchange/v1/agents/${c.address}`);
  assert.equal((await runTool(c, "list_evaluators", {})).path, "/exchange/v1/evaluators");
});

test("exchange_hire with the Exchange fee: second EIP-3009 (feeAuthorization) to the fee recipient; over-ceiling fee refused", async () => {
  const m = mock({ amount: "20000", fee: "50000" });
  const c = client(m);
  await runTool(c, "exchange_hire", { listingId: LID });
  const paid = m.calls.filter((x) => x.headers?.["payment-signature"]);
  assert.equal(paid.length, 1);
  const pp = unb64(paid[0].headers["payment-signature"]);
  assert.equal(pp.payload.authorization.value, "20000");
  assert.equal(pp.payload.feeAuthorization.authorization.value, "50000");
  assert.equal(getAddress(pp.payload.feeAuthorization.authorization.to), getAddress("0x000000000000000000000000000000000000FEE0"));
  assert.notEqual(pp.payload.feeAuthorization.authorization.nonce, pp.payload.authorization.nonce);
  assert.ok(m.calls[0].path.includes(`buyer=${c.address}`), "quote personalised for the buyer (beta waiver / credits)");
  // ceiling: max(ceil(price * 80 / 10000), 50000); 50001 on a 0.02 price is refused, nothing signed
  const over = mock({ amount: "20000", fee: "50001" });
  await assert.rejects(runTool(client(over), "exchange_hire", { listingId: LID }), /exceeds the accepted ceiling/);
  assert.equal(over.calls.filter((x) => x.headers?.["payment-signature"]).length, 0);
  // a lower client ceiling refuses the default fee
  await assert.rejects(runTool(client(mock({ amount: "20000", fee: "50000" }), { maxExchangeFeeMin: 10000n }), "exchange_hire", { listingId: LID }), /ceiling/);
  // percent above the $6.25 boundary (price itself must still be <= maxPayment)
  const big = mock({ amount: "50000000", fee: "400000" });
  await runTool(client(big, { maxPayment: 50_000_000n }), "exchange_hire", { listingId: LID });
  assert.equal(big.calls.filter((x) => x.headers?.["payment-signature"]).length, 1);
  await assert.rejects(runTool(client(mock({ amount: "50000000", fee: "400001" }), { maxPayment: 50_000_000n }), "exchange_hire", { listingId: LID }), /ceiling/);
});

test("earn / open jobs / beta tools hit the documented paths and sign the server's EIP-712", async () => {
  const pk = generatePrivateKey();
  const m = mock();
  const c = new AgentCoin({ baseUrl: BASE, account: pk, fetch: m.fetch as any });
  assert.equal((await runTool(c, "find_earning_opportunities", { category: "translate" })).path, "/exchange/v1/earn");
  assert.equal((await runTool(c, "list_open_jobs", {})).path, "/exchange/v1/jobs");
  assert.equal((await runTool(c, "list_open_jobs", { jobId: "oj_0123456789abcdef" })).path, "/exchange/v1/jobs/oj_0123456789abcdef");
  assert.equal((await runTool(c, "get_fee_credits", {})).path, `/exchange/v1/beta/${c.address}`);
});

test("exchangeFeeMax: 0.8% with a 0.05 USDC minimum below $6.25, ceil in atomic units", () => {
  assert.equal(exchangeFeeMax(1_000_000n), 50_000n);
  assert.equal(exchangeFeeMax(6_249_999n), 50_000n);
  assert.equal(exchangeFeeMax(6_250_000n), 50_000n);
  assert.equal(exchangeFeeMax(6_250_001n), 50_001n);
  assert.equal(exchangeFeeMax(50_000_000n), 400_000n);
});
