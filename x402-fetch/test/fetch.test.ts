import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AgentCoin } from "@agentcoin/core";
import { wrapFetchWithAgentCoin } from "../src/index.ts";
import { makeMock, BASE, SELLER, SERVICE_ID } from "../../core-ts/test/mock.ts";

const pk = generatePrivateKey();
const acct = privateKeyToAccount(pk);
const setup = (mo: any = {}, co: any = {}) => {
  const m = makeMock(acct.address, mo);
  const client = new AgentCoin({ baseUrl: BASE, account: pk, fetch: m.fetch, publicClient: m.publicClient, walletClient: m.walletClient, ...co });
  return { m, client };
};
const body = JSON.stringify({ sha256: "0x" + "ab".repeat(32) });

test("non-402 responses pass through untouched", async () => {
  const { client } = setup();
  const base = (async () => new Response("free", { status: 200 })) as any;
  const f = wrapFetchWithAgentCoin(base, { client });
  assert.equal(await (await f("https://free.test/")).text(), "free");
});

test("402 -> listing resolved by index search -> direct order -> paid response with order headers", async () => {
  const { m, client } = setup();
  const infos: any[] = [];
  const f = wrapFetchWithAgentCoin(m.fetch, { client, onPayment: (i) => infos.push(i) });
  const r = await f(SELLER, { method: "POST", body, headers: { "content-type": "application/json" } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { receipt: { digest: "0x" + "ab".repeat(32) } });
  assert.match(r.headers.get("x-agentcoin-order-id")!, /^ord_/);
  assert.equal(r.headers.get("x-agentcoin-payment-tx"), "0x" + "11".repeat(32));
  assert.equal(infos[0].mode, "direct");
  assert.equal(infos[0].serviceId, SERVICE_ID);
  assert.ok(m.calls.some((c) => c.url.endsWith("/receipt")), "receipt recorded with the router");
});

test("auto mode uses escrow when the seller offers agentcoin-escrow", async () => {
  const { m, client } = setup({ escrowOffer: true });
  const f = wrapFetchWithAgentCoin(m.fetch, { client, services: { [SELLER]: SERVICE_ID } });
  const r = await f(SELLER, { method: "POST", body });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-agentcoin-job-id"), "42");
  assert.equal(m.sent.length, 2);
});

test("escrow mode refuses when not offered; unlisted refused by default", async () => {
  { const { m, client } = setup(); const f = wrapFetchWithAgentCoin(m.fetch, { client, mode: "escrow", services: { [SELLER]: SERVICE_ID } }); await assert.rejects(f(SELLER, { method: "POST", body }), (e: any) => e.code === "escrow_unavailable"); }
  { const { m } = setup();
    const client = new AgentCoin({ baseUrl: BASE, account: pk, fetch: (async (u: any, i: any) => (String(u).includes("/v1/services") ? new Response(JSON.stringify({ results: [] })) : m.fetch(u, i))) as any, publicClient: m.publicClient });
    const f = wrapFetchWithAgentCoin(m.fetch, { client });
    await assert.rejects(f(SELLER, { method: "POST", body }), (e: any) => e.code === "not_listed");
    assert.ok(!m.calls.some((c) => c.headers["payment-signature"])); }
});

test("mainnet-only seller is refused before any signing", async () => {
  const { m, client } = setup({ network: "eip155:8453" });
  const f = wrapFetchWithAgentCoin(m.fetch, { client, services: { [SELLER]: SERVICE_ID } });
  await assert.rejects(f(SELLER, { method: "POST", body }), (e: any) => e.code === "wrong_network");
  assert.ok(!m.calls.some((c) => c.headers["payment-signature"]));
});

test("allowedServiceIds blocks other listings", async () => {
  const { m, client } = setup({}, { allowedServiceIds: ["svc_only"] });
  const f = wrapFetchWithAgentCoin(m.fetch, { client, services: { [SELLER]: SERVICE_ID } });
  await assert.rejects(f(SELLER, { method: "POST", body }), (e: any) => e.code === "service_not_allowed");
});

test("unlisted: pay sends plain x402 exact within guards", async () => {
  const { m } = setup();
  const client = new AgentCoin({ baseUrl: BASE, account: pk, fetch: (async (u: any, i: any) => (String(u).includes("/v1/services") ? new Response(JSON.stringify({ results: [] })) : m.fetch(u, i))) as any, publicClient: m.publicClient });
  const f = wrapFetchWithAgentCoin(m.fetch, { client, unlisted: "pay" });
  const r = await f(SELLER, { method: "POST", body });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-agentcoin-payment-tx"), "0x" + "11".repeat(32));
});
