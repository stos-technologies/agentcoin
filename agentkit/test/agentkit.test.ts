import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentcoinActionProvider, clientFromWalletProvider } from "../src/index.ts";
import { makeMock, BASE, SERVICE_ID } from "../../core-ts/test/mock.ts";

const acct = privateKeyToAccount(generatePrivateKey());
function fakeWp(m: ReturnType<typeof makeMock>, chainId = "84532") {
  return {
    getNetwork: () => ({ protocolFamily: "evm", networkId: chainId === "84532" ? "base-sepolia" : "base-mainnet", chainId }),
    getAddress: () => acct.address,
    getName: () => "fake",
    signMessage: (msg: any) => acct.signMessage({ message: msg }),
    signTypedData: (td: any) => acct.signTypedData(td),
    signTransaction: (tx: any) => acct.signTransaction(tx),
    sendTransaction: (tx: any) => m.walletClient.sendTransaction(tx),
    waitForTransactionReceipt: (h: any) => m.publicClient.waitForTransactionReceipt({ hash: h }),
    getPublicClient: () => m.publicClient,
  } as any;
}

test("action provider exposes seven prefixed actions with zod schemas", () => {
  const m = makeMock(acct.address);
  const actions = agentcoinActionProvider({ baseUrl: BASE, fetch: m.fetch }).getActions(fakeWp(m));
  assert.deepEqual(actions.map((a: any) => a.name).sort(), ["claim_listing", "find_service", "get_order", "place_order", "refund", "route_task", "verify"].map((n) => "AgentCoinActionProvider_" + n).sort());
  const po = actions.find((a: any) => a.name === "AgentCoinActionProvider_place_order")!;
  assert.equal(po.schema.safeParse({}).success, false, "serviceId required");
  assert.equal(po.schema.safeParse({ serviceId: "x", mode: "direct" }).success, true);
  assert.equal(po.schema.safeParse({ serviceId: "x", extra: 1 }).success, false, "strict");
});

test("find -> place_order (direct, signed by the wallet provider) -> verify", async () => {
  const m = makeMock(acct.address);
  const actions = agentcoinActionProvider({ baseUrl: BASE, fetch: m.fetch, allowedServiceIds: [SERVICE_ID] }).getActions(fakeWp(m));
  const by = (n: string) => actions.find((a: any) => a.name === "AgentCoinActionProvider_" + n)!;
  const f = JSON.parse(await by("find_service").invoke({ q: "notary" }));
  assert.ok(f.results.some((r: any) => r.id === SERVICE_ID));
  const p = JSON.parse(await by("place_order").invoke({ serviceId: SERVICE_ID, body: { sha256: "0x" + "ab".repeat(32) } }));
  assert.equal(p.paymentTx, "0x" + "11".repeat(32));
  assert.equal(p.verdict, "delivered");
  const v = JSON.parse(await by("verify").invoke({ serviceId: SERVICE_ID, orderId: p.orderId }));
  assert.equal(v.service.checks.signatureValid, true);
  const e = JSON.parse(await by("place_order").invoke({ serviceId: SERVICE_ID, mode: "escrow", body: {} }));
  assert.equal(e.jobId, "42");
  assert.equal(m.sent.length, 2, "approve + createAndFundFor via wallet provider");
});

test("refuses mainnet and non-base-sepolia wallet providers", async () => {
  const m = makeMock(acct.address);
  assert.throws(() => clientFromWalletProvider(fakeWp(m, "8453")), /mainnet/);
  assert.throws(() => clientFromWalletProvider(fakeWp(m, "11155111")), /base-sepolia/);
  const p = agentcoinActionProvider({ baseUrl: BASE, fetch: m.fetch });
  assert.equal(p.supportsNetwork({ protocolFamily: "evm", chainId: "84532" } as any), true);
  assert.equal(p.supportsNetwork({ protocolFamily: "evm", chainId: "8453" } as any), false);
  const a = agentcoinActionProvider({ baseUrl: BASE, fetch: m.fetch }).getActions(fakeWp(m, "8453"));
  const r = JSON.parse(await a[0].invoke({ q: "x" }));
  assert.equal(r.error, "mainnet_refused");
});

test("disableAgentKitAnalytics: constructing a ViemWalletProvider sends no analytics request", async () => {
  const { ViemWalletProvider } = await import("@coinbase/agentkit");
  const { createWalletClient, custom } = await import("viem");
  const { baseSepolia } = await import("viem/chains");
  const { privateKeyToAccount: pka, generatePrivateKey: gpk } = await import("viem/accounts");
  const { disableAgentKitAnalytics } = await import("../src/index.ts");
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: any) => { urls.push(String(u)); return new Response("{}", { status: 400 }); }) as any;
  try {
    disableAgentKitAnalytics();
    const wc = createWalletClient({ account: pka(gpk()), chain: baseSepolia, transport: custom({ request: async () => null }) });
    new ViemWalletProvider(wc as any);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(urls.filter((u) => u.includes("coinbase.com")), []);
  } finally { globalThis.fetch = realFetch; }
});
