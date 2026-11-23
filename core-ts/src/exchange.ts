// AgentKoin Exchange (agentkoin-exchange/0.1) helpers and tool specs. Base Sepolia testnet only.
// Hire = ONE x402 request: POST /exchange/v1/listings/{id}/hire -> 402 (exact, payTo = offer-bound EscrowDepositRoute)
// -> sign EIP-3009 -> same POST with PAYMENT-SIGNATURE -> 201 order with escrow jobId (the relayer pays gas).
// Before signing, payTo is checked against EscrowDepositRouteFactory.routeFor(offer) on chain and the amount against maxPayment.
// Exchange buyer fee (staged build): 0.8% of the price, min 0.05 USDC, buyer pays on top as a second EIP-3009 authorization
// (payload.feeAuthorization) to the fee recipient; 0 for opted-in beta buyers in the beta window; reduced by fee credits.
import { getAddress, type Hex } from "viem";
import type { AgentCoin, Json } from "./client.ts";
import { AgentCoinError } from "./errors.ts";
import { parse402, signExactPayment, readPaymentResponse, type PaymentRequirement } from "./x402.ts";

/** Upper bound the client accepts for the Exchange buyer fee: max(ceil(price * bps / 10000), min); defaults 80 bps, 50000 (0.8%, 0.05 USDC). */
export function exchangeFeeMax(price: bigint, bps: bigint = 80n, min: bigint = 50_000n): bigint {
  const pct = (price * bps + 9_999n) / 10_000n;
  return pct > min ? pct : min;
}
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

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
  const url = `${c.baseUrl}/exchange/v1/listings/${enc(a.listingId)}/hire${qs({ skill: a.skillId, evaluator: a.evaluator, buyer: c.address })}`;
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
  // fee leg (quoted for this buyer: beta waiver / credits may make it 0, then no second authorization is signed)
  const fr = ac.exchangeFee?.requirement;
  let header = sig.value;
  if (fr) {
    const fee = BigInt(fr.amount);
    const cap = exchangeFeeMax(BigInt(req.amount), c.maxExchangeFeeBps, c.maxExchangeFeeMin);
    if (fee > cap) throw new AgentCoinError("bad_requirement", `Exchange fee ${fee} exceeds the accepted ceiling ${cap} (max(${c.maxExchangeFeeBps} bps, ${c.maxExchangeFeeMin})) for price ${req.amount}`);
    if (getAddress(fr.asset) !== c.usdc) throw new AgentCoinError("bad_requirement", "fee asset is not USDC");
    const feeReq: PaymentRequirement = { scheme: "exact", network: fr.network, amount: String(fr.amount), asset: fr.asset, payTo: fr.payTo, maxTimeoutSeconds: fr.maxTimeoutSeconds, extra: fr.extra, x402Version: 2, raw: fr };
    const fsig = await signExactPayment(c.account, feeReq, parsed, { chainId: c.chainId, tokenName: "USDC", tokenVersion: "2", nowSeconds: now });
    const main = unb64(sig.value), feeP = unb64(fsig.value);
    main.payload.feeAuthorization = feeP.payload;
    header = b64(main);
  }
  const r2 = await f(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", [sig.header]: header }, body });
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

/** POST that returns an EIP-712 challenge (HTTP 400 with eip712) when unsigned; signs it with the configured account if it matches. */
async function signedPost(c: AgentCoin, path: string, body: Json, who: string, timeKey: "expiresAt" | "issuedAt", sign = true): Promise<Json> {
  let challenge: any;
  try {
    return await c.api("POST", path, body);
  } catch (e: any) {
    if (!(e instanceof AgentCoinError) || !e.details || !(e.details as any).eip712) throw e;
    challenge = e.details;
  }
  if (!sign || !c.account || getAddress(c.account.address) !== getAddress(who)) return { status: "signature-required", ...challenge };
  const td = challenge.eip712;
  const signature = await c.account.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: { ...td.message, [timeKey]: BigInt(td.message[timeKey]) } });
  return c.api("POST", path, { ...body, [timeKey]: td.message[timeKey], signature });
}
export async function exchangeEarn(c: AgentCoin, a: Json = {}): Promise<Json> { return c.api("GET", `/exchange/v1/earn${qs({ category: a.category, address: a.address ?? c.address, limit: a.limit })}`); }
export async function exchangeListJobs(c: AgentCoin, a: Json = {}): Promise<Json> {
  if (a.jobId) return c.api("GET", `/exchange/v1/jobs/${enc(a.jobId)}`);
  return c.api("GET", `/exchange/v1/jobs${qs({ category: a.category, minBudget: a.minBudget, maxBudget: a.maxBudget, cursor: a.cursor, limit: a.limit })}`);
}
export async function exchangePostJob(c: AgentCoin, a: { job: Json; buyer?: string; sign?: boolean }): Promise<Json> {
  const buyer = a.buyer ?? c.address;
  if (!buyer) throw new AgentCoinError("bad_args", "buyer (or a configured account) required");
  return signedPost(c, "/exchange/v1/jobs", { job: a.job, buyer }, buyer, "expiresAt", a.sign !== false);
}
export async function exchangeClaimJob(c: AgentCoin, a: { jobId: string; claimer?: string; sign?: boolean }): Promise<Json> {
  const claimer = a.claimer ?? c.address;
  if (!a?.jobId || !claimer) throw new AgentCoinError("bad_args", "jobId and claimer (or a configured account) required");
  return signedPost(c, `/exchange/v1/jobs/${enc(a.jobId)}/claim`, { claimer }, claimer, "expiresAt", a.sign !== false);
}
export async function exchangeJoinBeta(c: AgentCoin, a: { agent?: string; optIn?: boolean; sign?: boolean } = {}): Promise<Json> {
  const agent = a.agent ?? c.address;
  if (!agent) throw new AgentCoinError("bad_args", "agent (or a configured account) required");
  return signedPost(c, "/exchange/v1/beta", { agent, optIn: a.optIn ?? true }, agent, "issuedAt", a.sign !== false);
}
export async function exchangeFeeCredits(c: AgentCoin, agent?: string): Promise<Json> {
  const a = agent ?? c.address;
  if (!a) throw new AgentCoinError("bad_args", "agent (or a configured account) required");
  return c.api("GET", `/exchange/v1/beta/${enc(a)}`);
}

const usdc = { type: "string", pattern: "^[0-9]{1,18}$", description: "USDC base units (6 decimals), decimal string" };
const addr = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };

export interface ExchangeToolSpec {
  name: "exchange_find" | "exchange_hire" | "exchange_get_order" | "create_listing" | "get_agent_profile" | "list_evaluators" | "find_earning_opportunities" | "list_open_jobs" | "post_job" | "claim_job" | "join_beta" | "get_fee_credits";
  description: string;
  parameters: { type: "object"; properties: Record<string, Json>; required?: string[]; additionalProperties: false };
  readOnly: boolean;
}

export const exchangeToolSpecs: ExchangeToolSpec[] = [
  {
    name: "exchange_find",
    description: "Searches AgentKoin Exchange listings (agent services hired through USDC escrow with an evaluator verdict) by text, skill, max price, protocol, evaluator, badge. With id: one listing with skills, prices, criteria hash and hire options. Read-only. Base Sepolia testnet; buyer fee 0.8% (min 0.05 USDC) on top, seller receives 100%.",
    parameters: { type: "object", properties: { id: { type: "string", pattern: "^lst_[0-9a-f]{16}$" }, q: { type: "string", maxLength: 300 }, skill: { type: "string", maxLength: 64 }, maxPrice: usdc, protocol: { type: "string", enum: ["x402", "a2a", "mcp", "http", "openapi"] }, evaluator: addr, badge: { type: "string", enum: ["verified-track-record", "beta-tester"] }, sort: { type: "string", enum: ["relevance", "price", "score", "jobs"] }, cursor: { type: "string", maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "exchange_hire",
    description: "Hires an Exchange listing skill: pays the price in test USDC via x402 exact into a JobEscrow job (provider, evaluator, amount, SLA, criteria hash fixed by the payTo route) plus the Exchange buyer fee (0.8%, min 0.05 USDC; waived for beta testers) as a second authorization. Checks payTo == routeFor(offer), price <= maxPayment and fee <= max(0.8%, 0.05 USDC) (client-configurable).",
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
  {
    name: "find_earning_opportunities",
    description: "For an agent asked to make money: open jobs to claim, service categories where demand exceeds supply (from real board/order data) and evaluator openings, each with a one-call next step. Base Sepolia testnet, test USDC; no earnings promised. Read-only.",
    parameters: { type: "object", properties: { category: { type: "string", maxLength: 64 }, address: addr, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "list_open_jobs",
    description: "Lists the Exchange open-jobs board (buyer-posted tasks with budget, category, SLA, criteria hash) or, with jobId, one job and its order. Read-only.",
    parameters: { type: "object", properties: { jobId: { type: "string", pattern: "^oj_[0-9a-f]{16}$" }, category: { type: "string", maxLength: 64 }, minBudget: usdc, maxBudget: usdc, cursor: { type: "string", maxLength: 10 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "post_job",
    description: "Buyer side: posts a task to the open-jobs board (title, category, budget in USDC base units, sla_seconds, deliverable_schema, input). Signs the EIP-712 OpenJob with the configured wallet, else returns the typed data. Funded into escrow after an agent claims it; buyer fee 0.8% (min 0.05 USDC) on top.",
    parameters: { type: "object", properties: { job: { type: "object" }, buyer: addr, sign: { type: "boolean" } }, required: ["job"], additionalProperties: false },
    readOnly: false,
  },
  {
    name: "claim_job",
    description: "Claims an open job (EIP-712 Claim signed with the configured wallet). Exclusive for 2 h while the buyer funds a JobEscrow job with provider = you; deliver per the criteria; paid 100% of the budget on a complete verdict.",
    parameters: { type: "object", properties: { jobId: { type: "string", pattern: "^oj_[0-9a-f]{16}$" }, claimer: addr, sign: { type: "boolean" } }, required: ["jobId"], additionalProperties: false },
    readOnly: false,
  },
  {
    name: "join_beta",
    description: "Opts the wallet in (or out with optIn false) of the testnet Exchange beta via EIP-712 BetaOptIn. Beta: 0% Exchange buyer fee in the beta window, fee credits per completed judged job (usable only against Exchange fees; not cash, not withdrawable), beta-tester badge.",
    parameters: { type: "object", properties: { agent: addr, optIn: { type: "boolean" }, sign: { type: "boolean" } }, additionalProperties: false },
    readOnly: false,
  },
  {
    name: "get_fee_credits",
    description: "Returns beta status, badge and the off-chain fee-credit balance and history for an address. Credits only reduce future Exchange buyer fees; not cash, not withdrawable, not transferable. Read-only.",
    parameters: { type: "object", properties: { agent: addr }, additionalProperties: false },
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
    case "find_earning_opportunities": return exchangeEarn(c, a);
    case "list_open_jobs": return exchangeListJobs(c, a);
    case "post_job": return exchangePostJob(c, a as any);
    case "claim_job": return exchangeClaimJob(c, a as any);
    case "join_beta": return exchangeJoinBeta(c, a as any);
    case "get_fee_credits": return exchangeFeeCredits(c, a.agent);
    default: throw new AgentCoinError("unknown_tool", `unknown tool ${name}`);
  }
}
