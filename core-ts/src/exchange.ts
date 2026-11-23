// AgentKoin Exchange (agentkoin-exchange/0.1) helpers and tool specs. Base Sepolia testnet only.
// Hire = ONE x402 request: POST /exchange/v1/listings/{id}/hire -> 402 (exact, payTo = offer-bound EscrowDepositRoute)
// -> sign EIP-3009 -> same POST with PAYMENT-SIGNATURE -> 201 order with escrow jobId (the relayer pays gas).
// Before signing, payTo is checked against EscrowDepositRouteFactory.routeFor(offer) on chain and the amount against maxPayment.
import { getAddress, type Hex } from "viem";
import type { AgentCoin, Json } from "./client.ts";
import { AgentCoinError } from "./errors.ts";
import { parse402, signExactPayment, readPaymentResponse } from "./x402.ts";

export const ROUTE_FACTORY_ABI = [
  {
    type: "function", name: "routeFor", stateMutability: "view", outputs: [{ name: "", type: "address" }],
    inputs: [{ name: "o", type: "tuple", components: [
      { name: "provider", type: "address" }, { name: "evaluator", type: "address" }, { name: "amount", type: "uint256" },
      { name: "deadlineSeconds", type: "uint64" }, { name: "specHash", type: "bytes32" },
    ] }],
  },
] as const;

const enc = encodeURIComponent;
const qs = (o: Json) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v)); const s = u.toString(); return s ? `?${s}` : ""; };

export async function exchangeFind(c: AgentCoin, a: Json = {}): Promise<Json> {
  if (a.id) return c.api("GET", `/exchange/v1/listings/${enc(a.id)}`);
  return c.api("GET", `/exchange/v1/listings${qs({ q: a.q, skill: a.skill, maxPrice: a.maxPrice, protocol: a.protocol, evaluator: a.evaluator, badge: a.badge, sort: a.sort, cursor: a.cursor, limit: a.limit })}`);
}

/** Hire a listing skill. With a signer: pays via x402 exact (one request after the 402). Without: returns the unsigned hire options. */
export async function exchangeHire(c: AgentCoin, a: { listingId: string; skillId?: string; input?: unknown; evaluator?: string }): Promise<Json> {
  if (!a?.listingId) throw new AgentCoinError("bad_args", "listingId required");
  if (c.allowedServiceIds && !c.allowedServiceIds.has(a.listingId)) throw new AgentCoinError("not_allowed", `listing ${a.listingId} is not in allowedServiceIds`);
  if (!c.account) return { unsigned: true, listing: await exchangeFind(c, { id: a.listingId }) };
  const url = `${c.baseUrl}/exchange/v1/listings/${enc(a.listingId)}/hire${qs({ skill: a.skillId, evaluator: a.evaluator })}`;
  const body = JSON.stringify({ skill_id: a.skillId, input: a.input ?? null, evaluator: a.evaluator });
  const f = c.fetchFn;
  const r1 = await f(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body });
  if (r1.status !== 402) throw new AgentCoinError(`http_${r1.status}`, `hire: expected 402, got ${r1.status}`, await r1.json().catch(() => null));
  const parsed = await parse402(r1);
  const req = parsed.accepts.find((x) => x.scheme === "exact" && x.network === c.caip2 && getAddress(x.asset) === c.usdc);
  if (!req) throw new AgentCoinError("no_requirement", `no exact USDC requirement on ${c.caip2}`);
  if (BigInt(req.amount) > c.maxPayment) throw new AgentCoinError("over_max_payment", `price ${req.amount} exceeds maxPayment ${c.maxPayment}`);
  const ac = req.extra?.agentcoin;
  if (!ac?.offer || !ac.depositRouteFactory) throw new AgentCoinError("bad_requirement", "402 lacks extra.agentcoin offer/depositRouteFactory");
  if (getAddress(ac.escrowContract) !== c.escrow) throw new AgentCoinError("bad_requirement", `escrow ${ac.escrowContract} is not the configured escrow ${c.escrow}`);
  if (String(ac.offer.amount) !== String(req.amount)) throw new AgentCoinError("bad_requirement", "offer.amount != amount");
  const offer = { provider: getAddress(ac.offer.provider), evaluator: getAddress(ac.offer.evaluator), amount: BigInt(ac.offer.amount), deadlineSeconds: BigInt(ac.offer.deadlineSeconds), specHash: ac.offer.specHash as Hex };
  const route = await c.publicClient.readContract({ address: getAddress(ac.depositRouteFactory), abi: ROUTE_FACTORY_ABI, functionName: "routeFor", args: [offer] });
  if (getAddress(route) !== getAddress(req.payTo)) throw new AgentCoinError("bad_requirement", "payTo is not routeFor(offer)");
  const now = BigInt((await c.publicClient.getBlock()).timestamp);
  const sig = await signExactPayment(c.account, req, parsed, { chainId: c.chainId, tokenName: "USDC", tokenVersion: "2", nowSeconds: now });
  const r2 = await f(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", [sig.header]: sig.value }, body });
  const j: any = await r2.json().catch(() => null);
  if (!r2.ok) throw new AgentCoinError(`http_${r2.status}`, `hire -> ${r2.status}: ${j?.error ?? ""}`, j);
  return { ...j, paymentResponse: readPaymentResponse(r2), testnet: true };
}

export async function exchangeGetOrder(c: AgentCoin, orderId: string): Promise<Json> { return c.api("GET", `/exchange/v1/orders/${enc(orderId)}`); }

/** Create or update a listing. With a signer: signs the EIP-712 Listing the server returns and resends. */
export async function exchangeCreateListing(c: AgentCoin, a: { listing: Json; seller?: string; sign?: boolean }): Promise<Json> {
  const seller = a.seller ?? c.address;
  if (!seller) throw new AgentCoinError("bad_args", "seller (or a configured account) required");
  let challenge: any;
  try {
    return await c.api("POST", "/exchange/v1/listings", { listing: a.listing, seller });
  } catch (e: any) {
    if (!(e instanceof AgentCoinError) || !e.details || !(e.details as any).eip712) throw e;
    challenge = e.details;
  }
  if (a.sign === false || !c.account || getAddress(c.account.address) !== getAddress(seller)) return { status: "signature-required", ...challenge };
  const td = challenge.eip712;
  const signature = await c.account.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: { ...td.message, expiresAt: BigInt(td.message.expiresAt) } });
  return c.api("POST", "/exchange/v1/listings", { listing: a.listing, seller, expiresAt: td.message.expiresAt, signature });
}

export async function exchangeAgentProfile(c: AgentCoin, address: string): Promise<Json> { return c.api("GET", `/exchange/v1/agents/${enc(address)}`); }
export async function exchangeEvaluators(c: AgentCoin): Promise<Json> { return c.api("GET", "/exchange/v1/evaluators"); }

const usdc = { type: "string", pattern: "^[0-9]{1,18}$", description: "USDC base units (6 decimals), decimal string" };
const addr = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };

export interface ExchangeToolSpec {
  name: "exchange_find" | "exchange_hire" | "exchange_get_order" | "create_listing" | "get_agent_profile" | "list_evaluators";
  description: string;
  parameters: { type: "object"; properties: Record<string, Json>; required?: string[]; additionalProperties: false };
  readOnly: boolean;
}

export const exchangeToolSpecs: ExchangeToolSpec[] = [
  {
    name: "exchange_find",
    description: "Searches AgentKoin Exchange listings (agent services hired through USDC escrow with an evaluator verdict) by text, skill, max price, protocol, evaluator, badge. With id: one listing with skills, prices, criteria hash and hire options. Read-only. Base Sepolia testnet; fees 0%.",
    parameters: { type: "object", properties: { id: { type: "string", pattern: "^lst_[0-9a-f]{16}$" }, q: { type: "string", maxLength: 300 }, skill: { type: "string", maxLength: 64 }, maxPrice: usdc, protocol: { type: "string", enum: ["x402", "a2a", "mcp", "http", "openapi"] }, evaluator: addr, badge: { type: "string", enum: ["verified-track-record"] }, sort: { type: "string", enum: ["relevance", "price", "score", "jobs"] }, cursor: { type: "string", maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "exchange_hire",
    description: "Hires an Exchange listing skill: pays the listed price in test USDC via x402 exact into a JobEscrow job (provider, evaluator, amount, SLA and criteria hash fixed by the payTo route); the relayer pays gas. Checks payTo == routeFor(offer) on chain and price <= maxPayment before signing. Without a wallet: returns the listing's hire options.",
    parameters: { type: "object", properties: { listingId: { type: "string", pattern: "^lst_[0-9a-f]{16}$" }, skillId: { type: "string", maxLength: 64 }, input: { type: "object", description: "job input; must match the skill's input_schema" }, evaluator: addr }, required: ["listingId"], additionalProperties: false },
    readOnly: false,
  },
  {
    name: "exchange_get_order",
    description: "Returns an Exchange order: status (awaiting-funding, funded, submitted, verdict, settled, ...), escrow job id, tx hashes, deliverable hash and URL, criteria URL, verdict, proof URL and the judge-kit verify command. Read-only.",
    parameters: { type: "object", properties: { orderId: { type: "string", pattern: "^xo_[0-9a-f]{16}$" } }, required: ["orderId"], additionalProperties: false },
    readOnly: true,
  },
  {
    name: "create_listing",
    description: "Seller side: creates or updates an Exchange listing (title, endpoint, protocols, skills with price, sla_seconds, input/deliverable schemas). No signup and no bond; the endpoint must answer a probe (2xx/401/402/403/405). With the seller's wallet configured the EIP-712 Listing is signed automatically; otherwise returns the typed data to sign.",
    parameters: { type: "object", properties: { listing: { type: "object" }, seller: addr, sign: { type: "boolean" } }, required: ["listing"], additionalProperties: false },
    readOnly: false,
  },
  {
    name: "get_agent_profile",
    description: "Returns an operator-signed Exchange agent profile for an address: listings, settled jobs as seller and evaluator, score (outside buyers only; 'new' below 3 jobs), badges, ERC-8004 ids, evidence root. Read-only.",
    parameters: { type: "object", properties: { address: addr }, required: ["address"], additionalProperties: false },
    readOnly: true,
  },
  {
    name: "list_evaluators",
    description: "Lists active EvaluatorRegistry evaluators selectable for Exchange jobs: stake, available exposure, Exchange track record, and the selection rule. Read-only.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
  },
];

export const EXCHANGE_TOOL_NAMES = new Set<string>(exchangeToolSpecs.map((t) => t.name));

export async function runExchangeTool(c: AgentCoin, name: string, a: Json = {}): Promise<Json> {
  switch (name) {
    case "exchange_find": return exchangeFind(c, a);
    case "exchange_hire": return exchangeHire(c, a as any);
    case "exchange_get_order": return exchangeGetOrder(c, a.orderId);
    case "create_listing": return exchangeCreateListing(c, a as any);
    case "get_agent_profile": return exchangeAgentProfile(c, a.address);
    case "list_evaluators": return exchangeEvaluators(c);
    default: throw new AgentCoinError("unknown_tool", `unknown tool ${name}`);
  }
}
