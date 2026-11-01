// fetch wrapper: on HTTP 402 from an x402 seller, the payment goes through the AgentCoin router.
//   - The seller is resolved to an AgentCoin listing (explicit map, resolver, or index search by host).
//   - mode "escrow" (or "auto" when the seller's 402 offers scheme agentcoin-escrow on eip155:84532): test USDC is held in
//     JobEscrow until the evaluator verdict; refund on reject or expiry.
//   - mode "direct" (or "auto" otherwise): x402 exact payment to the seller; the router records an operator-signed delivery record.
//   - Unlisted sellers: refused by default (unlisted: "refuse"), or paid as plain x402 exact under the same guards (unlisted: "pay").
// Guards (from @agentcoin/core): eip155:84532 only, USDC only, per-request maxPayment, optional allowedServiceIds.
import { AgentCoin, AgentCoinError, parse402, signExactPayment, readPaymentResponse, BASE_SEPOLIA, type Json } from "@agentcoin/core";
import { getAddress } from "viem";

export interface AgentCoinFetchOptions {
  client: AgentCoin;
  mode?: "auto" | "escrow" | "direct";
  unlisted?: "refuse" | "pay";
  /** Exact URL (without query) or origin -> serviceId. Checked before the resolver and index search. */
  services?: Record<string, string>;
  resolveService?: (url: URL, method: string) => Promise<string | null> | string | null;
  /** Called after each payment with the order summary. */
  onPayment?: (info: AgentCoinPaymentInfo) => void;
}

export interface AgentCoinPaymentInfo { url: string; serviceId: string | null; orderId: string | null; mode: "escrow" | "direct" | "unlisted"; amount: string; paymentTx: string | null; jobId: string | null }

const headersToRecord = (h: HeadersInit | undefined): Record<string, string> => {
  const o: Record<string, string> = {};
  if (!h) return o;
  new Headers(h).forEach((v, k) => { o[k] = v; });
  return o;
};

async function resolve(o: AgentCoinFetchOptions, url: URL, method: string): Promise<{ serviceId: string; skillId?: string } | null> {
  const noQuery = url.origin + url.pathname;
  const mapped = o.services?.[noQuery] ?? o.services?.[url.origin];
  if (mapped) return { serviceId: mapped };
  if (o.resolveService) { const id = await o.resolveService(url, method); if (id) return { serviceId: id }; }
  const r = await o.client.findService({ q: url.host, limit: 50 });
  for (const s of (r.results ?? []).filter((x: Json) => x.host === url.host).slice(0, 5)) {
    const d = await o.client.findService({ id: s.id });
    const sk = (d.skills ?? []).find((k: Json) => k.url && new URL(k.url).origin + new URL(k.url).pathname === noQuery && (!k.method || k.method.toUpperCase() === method));
    if (sk) return { serviceId: s.id, skillId: sk.id };
  }
  return null;
}

/** Returns a fetch function with AgentCoin-routed x402 payment. Response headers add x-agentcoin-order-id, x-agentcoin-payment-tx, x-agentcoin-job-id. */
export function wrapFetchWithAgentCoin(baseFetch: typeof fetch, o: AgentCoinFetchOptions): typeof fetch {
  const client = o.client;
  const mode = o.mode ?? "auto";
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input));
    const method = (init.method ?? req?.method ?? "GET").toUpperCase();
    const body = init.body ?? (req && method !== "GET" && method !== "HEAD" ? await req.clone().text() : undefined);
    if (body !== undefined && typeof body !== "string") throw new AgentCoinError("unsupported_body", "only string bodies are supported for paid requests");
    const headers = { ...headersToRecord(req?.headers), ...headersToRecord(init.headers) };
    const first = await baseFetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    if (first.status !== 402) return first;
    const parsed = await parse402(first.clone());
    const exact = parsed.accepts.find((a) => a.scheme === "exact" && a.network === client.caip2);
    const escrowOffered = parsed.accepts.some((a) => a.scheme === "agentcoin-escrow" && a.network === client.caip2);
    if (!exact && !escrowOffered) throw new AgentCoinError("wrong_network", `seller offers no payment on ${client.caip2}`, { networks: parsed.accepts.map((a) => a.network) });
    const hit = await resolve(o, url, method);
    const build = (r: { status: number; headers: Record<string, string>; body: ArrayBuffer }, info: AgentCoinPaymentInfo) => {
      o.onPayment?.(info);
      const h = new Headers(r.headers);
      if (info.orderId) h.set("x-agentcoin-order-id", info.orderId);
      if (info.paymentTx) h.set("x-agentcoin-payment-tx", info.paymentTx);
      if (info.jobId) h.set("x-agentcoin-job-id", info.jobId);
      h.delete("content-length"); h.delete("content-encoding");
      return new Response(r.body, { status: r.status, headers: h });
    };
    if (!hit) {
      if ((o.unlisted ?? "refuse") === "refuse") throw new AgentCoinError("not_listed", `no AgentCoin listing found for ${url.origin}${url.pathname}`);
      if (!exact || !client.account) throw new AgentCoinError("no_account", "plain x402 payment needs an exact requirement and a signer");
      if (exact.network !== client.caip2 || getAddress(exact.asset) !== client.usdc || BigInt(exact.amount) > client.maxPayment) throw new AgentCoinError("guard", "unlisted requirement outside network/asset/maxPayment guards");
      const blk = await client.publicClient.getBlock();
      const pay = await signExactPayment(client.account, exact, parsed, { chainId: client.chainId, tokenName: BASE_SEPOLIA.usdcEip712.name, tokenVersion: BASE_SEPOLIA.usdcEip712.version, nowSeconds: BigInt(blk.timestamp) });
      const r = await baseFetch(url, { method, headers: { ...headers, [pay.header]: pay.value }, ...(body !== undefined ? { body } : {}) });
      const pr = readPaymentResponse(r);
      return build({ status: r.status, headers: headersToRecord(r.headers), body: await r.arrayBuffer() }, { url: url.href, serviceId: null, orderId: null, mode: "unlisted", amount: exact.amount, paymentTx: pr?.transaction ?? null, jobId: pr?.jobId ?? null });
    }
    const useEscrow = mode === "escrow" || (mode === "auto" && escrowOffered);
    if (useEscrow) {
      if (!escrowOffered) throw new AgentCoinError("escrow_unavailable", "seller 402 does not offer scheme agentcoin-escrow");
      const order = await client.placeOrder({ serviceId: hit.serviceId, skillId: hit.skillId, mode: "escrow" });
      const paid = await client.payEscrow(order, { body, headers, sellerCall: { url: url.href, method } });
      return build(paid.response!, { url: url.href, serviceId: hit.serviceId, orderId: paid.orderId, mode: "escrow", amount: paid.amount, paymentTx: paid.paymentTx, jobId: paid.jobId });
    }
    const order = await client.placeOrder({ serviceId: hit.serviceId, skillId: hit.skillId, mode: "direct" });
    const paid = await client.payDirect(order, { body, method, url: url.href, headers });
    return build(paid.response!, { url: url.href, serviceId: hit.serviceId, orderId: paid.orderId, mode: "direct", amount: paid.amount, paymentTx: paid.paymentTx, jobId: paid.jobId });
  }) as typeof fetch;
}
