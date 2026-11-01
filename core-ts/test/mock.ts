// Mocked AgentCoin router + seller + chain for unit tests. No network.
import { encodeFunctionData, erc20Abi, encodeEventTopics, encodeAbiParameters, getAddress, verifyTypedData, keccak256, toBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE_SEPOLIA, ESCROW_ABI } from "../src/constants.ts";
import { keccakJcs } from "../src/canonical.ts";

export const BASE = "https://router.test";
export const SELLER = "https://seller.test/v1/notarize";
export const SERVICE_ID = "svc_test0000000001";
export const PAY_TO = "0x6A32bC3Bb5eA1dc814f14E29e6f026535129A84f";
export const PROVIDER = "0x745528C4E0CBdA5759175A660da06d0aaA72db7F";
export const EVALUATOR = "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

export interface MockOpts { network?: string; asset?: string; amount?: string; sellerPayTo?: string; v1?: boolean; tamper?: "spender" | "client" | "contract" | null; scoreKey?: Hex; escrowOffer?: boolean }

export function makeMock(buyerAddress: string, o: MockOpts = {}) {
  const calls: { method: string; url: string; body: any; headers: Record<string, string> }[] = [];
  const network = o.network ?? "eip155:84532";
  const asset = o.asset ?? BASE_SEPOLIA.usdc;
  const amount = o.amount ?? "10000";
  const req = { scheme: "exact", network, amount, asset, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } };
  const scoreKey = o.scoreKey ?? generatePrivateKey();
  const orders = new Map<string, any>();
  let seq = 0;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const settleTx = ("0x" + "11".repeat(32)) as Hex;

  const fetch = async (input: any, init: any = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, headers });
    const u = new URL(url);
    if (url.startsWith(SELLER)) {
      if (headers["payment-signature"]) {
        const p = unb64(headers["payment-signature"]);
        if (p.accepted?.scheme === "agentcoin-escrow") return json(200, { receipt: { jobId: p.payload.jobId }, deliverableHash: "0x" + "ab".repeat(32) });
        const a = p.payload.authorization;
        const ok = await verifyTypedData({ address: a.from, domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: getAddress(asset) }, types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] }, primaryType: "TransferWithAuthorization", message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) }, signature: p.payload.signature });
        if (!ok) return json(402, { error: "bad signature" });
        return json(200, { receipt: { digest: body?.sha256 ?? null } }, { "PAYMENT-RESPONSE": b64({ success: true, transaction: settleTx, network, payer: a.from, jobId: "7" }) });
      }
      if (headers["x-payment"]) {
        return json(200, { ok: true }, { "X-PAYMENT-RESPONSE": b64({ success: true, transaction: settleTx, network: "base-sepolia" }) });
      }
      const sreq = { ...req, payTo: o.sellerPayTo ?? PAY_TO };
      if (o.v1) return json(402, { x402Version: 1, accepts: [{ scheme: "exact", network: network === "eip155:84532" ? "base-sepolia" : network, maxAmountRequired: amount, asset, payTo: sreq.payTo, resource: SELLER, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }] });
      const accepts: any[] = [sreq];
      if (o.escrowOffer) accepts.push({ scheme: "agentcoin-escrow", network, amount, asset, payTo: PROVIDER, maxTimeoutSeconds: 300, extra: {} });
      return json(402, {}, { "PAYMENT-REQUIRED": b64({ x402Version: 2, resource: { url: SELLER }, accepts }) });
    }
    if (!url.startsWith(BASE)) return json(599, { error: "mock: unexpected host " + url });
    const p = u.pathname;
    if (p === "/v1/services" && method === "GET") return json(200, { total: 1, results: [{ id: "svc_otherhost0001", host: "other.test" }, { id: SERVICE_ID, name: "Test notary", host: "seller.test", status: "claimed", operatedBy: "AgentCoin" }], query: Object.fromEntries(u.searchParams) });
    if (p === "/v1/services" && method === "POST") return json(200, { status: "created", listing: { id: "svc_new0000000001", status: "unclaimed" } });
    if (p.startsWith("/v1/services/") && p.endsWith("/claim/verify")) return json(200, { status: "claimed", received: body });
    if (p.startsWith("/v1/services/") && p.endsWith("/claim")) return json(200, { eip712: { typedData: {} }, wellKnown: { content: "tok" } });
    if (p.startsWith("/v1/services/")) return json(200, { id: p.split("/")[3], metadataHash: "0x" + "cd".repeat(32), skills: [{ id: "POST /v1/notarize", method: "POST", url: SELLER }] });
    if (p === "/v1/route") return json(200, { candidates: [{ serviceId: "svc_outside000001" }, { serviceId: SERVICE_ID }], received: body });
    if (p === "/v1/orders" && method === "POST") {
      if (body.serviceId !== SERVICE_ID) return json(404, { error: "unknown serviceId" });
      const id = `ord_${++seq}`;
      if (body.mode === "escrow") {
        const client = o.tamper === "client" ? "0x000000000000000000000000000000000000dEaD" : body.buyer;
        const spender = o.tamper === "spender" ? "0x000000000000000000000000000000000000bEEF" : BASE_SEPOLIA.escrow;
        const order = {
          orderId: id, mode: "escrow", serviceId: SERVICE_ID, origin: body.origin ?? "external",
          escrow: { chainId: 84532, contract: o.tamper === "contract" ? "0x000000000000000000000000000000000000c0De" : BASE_SEPOLIA.escrow, token: asset, client: body.buyer, provider: PROVIDER, evaluator: EVALUATOR, amount, deadline: "1893456000", specHash: "0x" + "6b".repeat(32) },
          transactions: [
            { step: 1, label: "USDC.approve(escrow, amount)", chainId: 84532, to: asset, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as Hex, BigInt(amount)] }), value: "0" },
            { step: 2, label: "JobEscrow.createAndFundFor", chainId: 84532, to: BASE_SEPOLIA.escrow, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: "createAndFundFor", args: [client, PROVIDER, EVALUATOR, BigInt(amount), 1893456000n, ("0x" + "6b".repeat(32)) as Hex] }), value: "0" },
          ],
          sellerCall: { method: "POST", url: SELLER },
        };
        orders.set(id, { ...order, status: "awaiting-escrow" });
        return json(201, order);
      }
      const order = { orderId: id, mode: "direct", serviceId: SERVICE_ID, origin: body.origin ?? "external", paymentRequirements: [req], request: { method: "POST", url: SELLER } };
      orders.set(id, { ...order, status: "awaiting-payment" });
      return json(201, order);
    }
    const m = p.match(/^\/v1\/orders\/([^/]+)(\/receipt)?$/);
    if (m) {
      const ord = orders.get(m[1]);
      if (!ord) return json(404, { error: "unknown orderId" });
      if (m[2]) {
        if (ord.mode === "direct") Object.assign(ord, { paymentTx: body.paymentTx, status: "settled", verdict: "delivered", deliverableHash: "0x" + "ee".repeat(32) });
        else Object.assign(ord, { jobId: body.jobId, paymentTx: body.paymentTx, status: "funded" });
        return json(200, ord);
      }
      if (ord.mode === "escrow" && ord.jobId) Object.assign(ord, { status: "verdict", verdict: "complete" });
      return json(200, ord);
    }
    if (p.startsWith("/v1/reputation/")) {
      const evidence = [{ type: "probe", status: 200 }];
      const score: any = { v: "agentcoin-score/v1", serviceId: p.split("/")[3], evidenceRoot: keccakJcs(evidence), testnet: true };
      const acct = privateKeyToAccount(scoreKey);
      const digest = keccakJcs(score);
      score.signature = { scheme: "eip191", canonicalization: "RFC8785", digest: "keccak256", signer: acct.address, signedDigest: digest, value: await acct.signMessage({ message: { raw: digest } }) };
      return json(200, { score, evidence });
    }
    if (p === "/mcp") return json(200, { jsonrpc: "2.0", id: 1, result: { structuredContent: { document: { valid: true } }, content: [{ type: "text", text: "{}" }] } });
    return json(404, { error: "mock: no route " + method + " " + p });
  };

  // chain mocks
  const sent: { to: string; data: Hex }[] = [];
  const jobState = { state: 2, accepted: false, deadline: 1893456000n, client: buyerAddress };
  const walletClient = {
    sendTransaction: async (tx: any) => { sent.push({ to: tx.to, data: tx.data }); return keccak256(toBytes("tx" + sent.length)); },
    writeContract: async (tx: any) => { sent.push({ to: tx.address, data: encodeFunctionData({ abi: tx.abi, functionName: tx.functionName, args: tx.args }) }); return keccak256(toBytes("w" + sent.length)); },
  };
  const jobCreatedLog = () => ({
    address: BASE_SEPOLIA.escrow, blockHash: ("0x" + "00".repeat(32)) as Hex, blockNumber: 1n, logIndex: 0, transactionHash: ("0x" + "22".repeat(32)) as Hex, transactionIndex: 0, removed: false,
    topics: encodeEventTopics({ abi: ESCROW_ABI, eventName: "JobCreated", args: { jobId: 42n, client: buyerAddress as Hex, provider: PROVIDER as Hex } }),
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint64" }, { type: "bytes32" }, { type: "uint32" }], [EVALUATOR, BigInt(amount), 1893456000n, ("0x" + "6b".repeat(32)) as Hex, 2]),
  });
  const publicClient = {
    getBlock: async () => ({ timestamp: 1793500000n }),
    waitForTransactionReceipt: async () => ({ status: "success", logs: sent.length === 2 ? [jobCreatedLog()] : [] }),
    readContract: async () => ({ client: jobState.client, provider: PROVIDER, evaluator: EVALUATOR, state: jobState.state, accepted: jobState.accepted, deadline: jobState.deadline, amount: BigInt(amount) }),
    simulateContract: async () => ({ result: undefined }),
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, walletClient: walletClient as any, publicClient: publicClient as any, sent, jobState, scoreKey };
}
