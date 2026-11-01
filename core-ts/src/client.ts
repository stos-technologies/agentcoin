// AgentCoin router client. One class used by every framework plugin.
// Flow: findService / routeTask -> placeOrder -> pay (direct x402 exact, or escrow) -> getOrder / waitForVerdict -> verify.
import {
  createPublicClient, createWalletClient, http, getAddress, isAddress, decodeFunctionData, encodeFunctionData, erc20Abi, parseEventLogs,
  type Hex, type LocalAccount, type PublicClient, type WalletClient, type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { agentcoinUrl, BASE_SEPOLIA, MAINNET_CHAIN_IDS, DEFAULT_MAX_PAYMENT, ESCROW_ABI, ESCROW_STATES, type EscrowState } from "./constants.ts";
import { AgentCoinError } from "./errors.ts";
import { keccakJcs, verifyEip191Document } from "./canonical.ts";
import { parse402, signExactPayment, readPaymentResponse, escrowPaymentHeader, type PaymentRequirement } from "./x402.ts";

export type Json = Record<string, any>;
export type OrderMode = "direct" | "escrow";

export interface AgentCoinOptions {
  /** Router base URL. Default: the hosted Base Sepolia router. */
  baseUrl?: string;
  /** EVM chain id. Default 84532 (Base Sepolia). Mainnet ids are refused unless allowMainnet is true. */
  chainId?: number;
  /** Buyer/seller signer: a viem LocalAccount or a 0x private key. Without it the client is read-only. */
  account?: LocalAccount | Hex;
  rpcUrl?: string;
  /** Per-order payment ceiling in USDC base units (6 decimals). Default 50000 (0.05 test USDC). */
  maxPayment?: bigint | string | number;
  /** If set, orders are only placed for these service ids. */
  allowedServiceIds?: string[];
  /** Marks orders as AgentCoin-originated (excluded from seller scores). Used by AgentCoin's own test runs. */
  origin?: "agentcoin";
  /** Unsupported in v0.1. Default false. Setting it true removes the mainnet chain-id refusal; the hosted router serves eip155:84532 only. */
  allowMainnet?: boolean;
  /** USDC address for the chain. Default: Base Sepolia USDC. Required for any other chain. */
  usdc?: string;
  /** JobEscrow address. Default: Base Sepolia JobEscrow. */
  escrow?: string;
  fetch?: typeof fetch;
  publicClient?: Pick<PublicClient, "readContract" | "waitForTransactionReceipt" | "getBlock" | "simulateContract">;
  walletClient?: Pick<WalletClient, "sendTransaction" | "writeContract">;
  pollIntervalMs?: number;
  verdictTimeoutMs?: number;
}

export interface PayResult {
  orderId: string;
  mode: OrderMode;
  serviceId: string;
  amount: string;
  paymentTx: string | null;
  jobId: string | null;
  deliverable: unknown;
  sellerStatus: number | null;
  order: Json;
  transactions?: { label: string; hash: string }[];
  /** Seller HTTP response after payment (body as bytes). */
  response?: { status: number; headers: Record<string, string>; body: ArrayBuffer } | null;
}

const hdrs = (r: Response) => { const o: Record<string, string> = {}; r.headers.forEach((v, k) => { o[k] = v; }); return o; };
const decodeBody = (buf: ArrayBuffer): unknown => { const text = new TextDecoder().decode(buf); try { return JSON.parse(text); } catch { return text; } };

const isHex64 = (s: unknown) => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const big = (v: bigint | string | number) => BigInt(v);

/** Throws unless chainId is allowed: mainnet ids require allowMainnet (unsupported). */
export function assertChainAllowed(chainId: number, allowMainnet = false): void {
  if (!Number.isInteger(chainId) || chainId <= 0) throw new AgentCoinError("bad_chain", `invalid chainId ${chainId}`);
  if (MAINNET_CHAIN_IDS.has(chainId) && !allowMainnet) {
    throw new AgentCoinError("mainnet_refused", `chainId ${chainId} is a mainnet; AgentCoin v0.1 plugins run on Base Sepolia (84532) only. allowMainnet is unsupported.`);
  }
}

export class AgentCoin {
  readonly baseUrl: string;
  readonly chainId: number;
  readonly caip2: string;
  readonly account: LocalAccount | null;
  readonly maxPayment: bigint;
  readonly allowedServiceIds: Set<string> | null;
  readonly origin?: "agentcoin";
  readonly usdc: Hex;
  readonly escrow: Hex;
  readonly pollIntervalMs: number;
  readonly verdictTimeoutMs: number;
  private readonly f: typeof fetch;
  private readonly rpcUrl: string;
  private _pc: AgentCoinOptions["publicClient"] | null;
  private _wc: AgentCoinOptions["walletClient"] | null;

  constructor(o: AgentCoinOptions = {}) {
    this.chainId = o.chainId ?? BASE_SEPOLIA.chainId;
    assertChainAllowed(this.chainId, o.allowMainnet ?? false);
    if (this.chainId !== BASE_SEPOLIA.chainId && !o.usdc) throw new AgentCoinError("bad_chain", `no USDC address known for chainId ${this.chainId}; pass usdc`);
    this.caip2 = `eip155:${this.chainId}`;
    this.baseUrl = (o.baseUrl ?? agentcoinUrl()).replace(/\/+$/, "");
    this.account = typeof o.account === "string" ? privateKeyToAccount(o.account) : (o.account ?? null);
    this.maxPayment = big(o.maxPayment ?? DEFAULT_MAX_PAYMENT);
    this.allowedServiceIds = o.allowedServiceIds ? new Set(o.allowedServiceIds) : null;
    this.origin = o.origin;
    this.usdc = getAddress(o.usdc ?? BASE_SEPOLIA.usdc);
    this.escrow = getAddress(o.escrow ?? BASE_SEPOLIA.escrow);
    this.f = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.rpcUrl = o.rpcUrl ?? BASE_SEPOLIA.rpcUrl;
    this._pc = o.publicClient ?? null;
    this._wc = o.walletClient ?? null;
    this.pollIntervalMs = o.pollIntervalMs ?? 15_000;
    this.verdictTimeoutMs = o.verdictTimeoutMs ?? 10 * 60_000;
  }

  /** Address of the configured signer, or null. */
  get address(): string | null { return this.account?.address ?? null; }

  private chain(): Chain { return this.chainId === baseSepolia.id ? baseSepolia : ({ ...baseSepolia, id: this.chainId, name: `chain-${this.chainId}` } as Chain); }
  get publicClient() { return (this._pc ??= createPublicClient({ chain: this.chain(), transport: http(this.rpcUrl) }) as any); }
  get walletClient() {
    if (!this.account) throw new AgentCoinError("no_account", "this operation needs a signer (account)");
    return (this._wc ??= createWalletClient({ account: this.account, chain: this.chain(), transport: http(this.rpcUrl) }) as any);
  }

  // ------------------------------------------------------------------ REST
  async api(method: string, path: string, body?: unknown): Promise<Json> {
    const r = await this.f(this.baseUrl + path, { method, headers: { "content-type": "application/json", accept: "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const j: any = await r.json().catch(() => null);
    if (!r.ok) throw new AgentCoinError(`http_${r.status}`, `${method} ${path} -> ${r.status}: ${j?.error ?? JSON.stringify(j)?.slice(0, 300)}`, j);
    return j ?? {};
  }

  /** Search the index, or one listing with id. */
  async findService(a: { id?: string; q?: string; protocol?: string; maxPrice?: string; minScore?: number; claimed?: boolean; network?: string; cursor?: string; limit?: number; skillsOffset?: number } = {}): Promise<Json> {
    if (a.id) return this.api("GET", `/v1/services/${encodeURIComponent(a.id)}${a.skillsOffset ? `?skillsOffset=${a.skillsOffset}` : ""}`);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(a)) if (v !== undefined && v !== null && k !== "id" && k !== "skillsOffset") qs.set(k, String(v));
    return this.api("GET", `/v1/services${qs.size ? "?" + qs : ""}`);
  }

  /** Ranked candidate sellers for a task. Defaults the network constraint to this client's chain. */
  async routeTask(a: { task: string; budget?: string; constraints?: Json }): Promise<Json> {
    return this.api("POST", "/v1/route", { task: a.task, ...(a.budget ? { budget: String(a.budget) } : {}), constraints: { network: this.caip2, ...(a.constraints ?? {}) } });
  }

  /** Places an order with the router (no payment). buyer = the configured account. */
  async placeOrder(a: { serviceId: string; skillId?: string; mode?: OrderMode; deadlineSeconds?: number }): Promise<Json> {
    this.assertServiceAllowed(a.serviceId);
    const mode = a.mode ?? "direct";
    if (mode === "escrow" && !this.account) throw new AgentCoinError("no_account", "escrow orders need a signer (account)");
    return this.api("POST", "/v1/orders", { serviceId: a.serviceId, ...(a.skillId ? { skillId: a.skillId } : {}), mode, ...(this.account ? { buyer: this.account.address } : {}), ...(a.deadlineSeconds ? { deadlineSeconds: a.deadlineSeconds } : {}), ...(this.origin ? { origin: this.origin } : {}) });
  }

  async getOrder(orderId: string): Promise<Json> { return this.api("GET", `/v1/orders/${encodeURIComponent(orderId)}`); }
  async submitReceipt(orderId: string, body: Json): Promise<Json> { return this.api("POST", `/v1/orders/${encodeURIComponent(orderId)}/receipt`, body); }
  /** Seller side: index a public metadata document (A2A card, x402 catalog, MCP server card, ERC-8004 registration). */
  async submitListing(url: string): Promise<Json> { return this.api("POST", "/v1/services", { url }); }

  /**
   * Seller side: claim a listing. Without sign: returns the EIP-712 typed data and well-known token.
   * With sign and an account: signs Claim{serviceId, claimant, metadataHash, expiresAt} and verifies in one call.
   * With method "well-known": asks the router to check https://<host>/.well-known/agentcoin-claim.
   */
  async claimListing(a: { serviceId: string; sign?: boolean; method?: "eip712" | "well-known"; expiresInSeconds?: number }): Promise<Json> {
    const id = encodeURIComponent(a.serviceId);
    if (a.method === "well-known") return this.api("POST", `/v1/services/${id}/claim/verify`, { method: "well-known", ...(this.account ? { claimant: this.account.address } : {}) });
    if (!a.sign) return this.api("POST", `/v1/services/${id}/claim`, this.account ? { claimant: this.account.address } : {});
    if (!this.account) throw new AgentCoinError("no_account", "signing a claim needs a signer (account)");
    const svc = await this.findService({ id: a.serviceId });
    const metadataHash = svc.metadataHash as Hex;
    if (!isHex64(metadataHash)) throw new AgentCoinError("no_metadata_hash", "listing has no metadataHash");
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + Math.min(86_400, a.expiresInSeconds ?? 3600));
    const signature = await this.account.signTypedData({
      domain: { name: "AgentCoin Index", version: "1", chainId: this.chainId },
      types: { Claim: [{ name: "serviceId", type: "string" }, { name: "claimant", type: "address" }, { name: "metadataHash", type: "bytes32" }, { name: "expiresAt", type: "uint256" }] },
      primaryType: "Claim",
      message: { serviceId: a.serviceId, claimant: this.account.address, metadataHash, expiresAt },
    });
    return this.api("POST", `/v1/services/${id}/claim/verify`, { claimant: this.account.address, expiresAt: expiresAt.toString(), signature });
  }

  /** Signed score for a listing, checked locally: EIP-191 signer, evidence root, signer = AgentCoin operator. */
  async reputation(serviceId: string): Promise<Json> {
    const rep = await this.api("GET", `/v1/reputation/${encodeURIComponent(serviceId)}`);
    const sig = rep.score ? await verifyEip191Document(rep.score) : { valid: false, reason: "no score" };
    const evidenceRootMatches = Array.isArray(rep.evidence) && rep.score?.evidenceRoot ? keccakJcs(rep.evidence) === rep.score.evidenceRoot : false;
    const signerIsOperator = !!sig.signer && getAddress(sig.signer) === getAddress(BASE_SEPOLIA.operatorSigner);
    return { serviceId, score: rep.score, evidenceCount: Array.isArray(rep.evidence) ? rep.evidence.length : 0, checks: { signatureValid: sig.valid, signer: sig.signer ?? null, signerIsOperator, evidenceRootMatches }, evidence: rep.evidence };
  }

  /** Checks an operator-signed delivery record (EIP-191 over RFC 8785). */
  async verifyDeliveryRecord(record: Json | null | undefined): Promise<Json> {
    if (!record) return { valid: false, reason: "no delivery record" };
    const r = await verifyEip191Document(record);
    return { ...r, signerIsOperator: !!r.signer && getAddress(r.signer) === getAddress(BASE_SEPOLIA.operatorSigner) };
  }

  /** MCP tools/call on the router's stateless streamable-HTTP endpoint. */
  async mcpCall(name: string, args: Json): Promise<Json> {
    const r = await this.f(this.baseUrl + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const text = await r.text();
    const j = JSON.parse(text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("") : text);
    if (j.error) throw new AgentCoinError("mcp_error", j.error.message ?? "mcp error", j.error);
    const res = j.result;
    if (res?.isError) throw new AgentCoinError("mcp_tool_error", res.content?.[0]?.text ?? "tool error", res);
    return res?.structuredContent ?? JSON.parse(res?.content?.[0]?.text ?? "{}");
  }

  /** verify: serviceId (local score check), order (delivery record check), document/evaluator (router verify tool). */
  async verify(a: { serviceId?: string; orderId?: string; document?: Json | string; expectedSigner?: string; evaluator?: string }): Promise<Json> {
    const out: Json = {};
    if (a.serviceId) out.service = await this.reputation(a.serviceId);
    if (a.orderId) {
      const o = await this.getOrder(a.orderId);
      out.order = { orderId: o.orderId, status: o.status, verdict: o.verdict, deliverableHash: o.deliverableHash, deliveryRecord: await this.verifyDeliveryRecord(o.deliveryRecord) };
    }
    if (a.document !== undefined || a.evaluator) {
      const r = await this.mcpCall("verify", { ...(a.document !== undefined ? { document: a.document } : {}), ...(a.expectedSigner ? { expectedSigner: a.expectedSigner } : {}), ...(a.evaluator ? { evaluator: a.evaluator } : {}) });
      Object.assign(out, r);
    }
    if (!Object.keys(out).length) throw new AgentCoinError("bad_args", "serviceId, orderId, document or evaluator required");
    return out;
  }

  // ------------------------------------------------------------------ guards
  assertServiceAllowed(serviceId: string): void {
    if (this.allowedServiceIds && !this.allowedServiceIds.has(serviceId)) throw new AgentCoinError("service_not_allowed", `serviceId ${serviceId} is not in allowedServiceIds`);
  }
  private assertRequirement(req: { network: string; asset: string; amount: string | bigint }) {
    if (req.network !== this.caip2) throw new AgentCoinError("wrong_network", `payment network ${req.network} != ${this.caip2}`);
    if (getAddress(req.asset) !== this.usdc) throw new AgentCoinError("wrong_asset", `payment asset ${req.asset} != USDC ${this.usdc}`);
    if (big(req.amount) > this.maxPayment) throw new AgentCoinError("over_max_payment", `amount ${req.amount} > maxPayment ${this.maxPayment}`);
  }

  // ------------------------------------------------------------------ payment
  /** Pays a direct order with x402 exact against the seller URL, then records the receipt with the router. */
  async payDirect(order: Json, a: { body?: unknown; method?: string; url?: string; headers?: Record<string, string> } = {}): Promise<PayResult> {
    if (!this.account) throw new AgentCoinError("no_account", "payment needs a signer (account)");
    if (order.mode !== "direct") throw new AgentCoinError("bad_order", "payDirect needs a direct order");
    this.assertServiceAllowed(order.serviceId);
    const routed: Json | undefined = (order.paymentRequirements ?? []).find((r: Json) => r.scheme === "exact" && r.network === this.caip2);
    if (!routed) throw new AgentCoinError("wrong_network", `order has no exact requirement on ${this.caip2}`);
    this.assertRequirement(routed as any);
    const url = a.url ?? order.request?.url;
    if (!url) throw new AgentCoinError("no_url", "order has no seller request url");
    const method = (a.method ?? order.request?.method ?? (a.body !== undefined ? "POST" : "GET")).toUpperCase();
    const init = (extra: Record<string, string> = {}): RequestInit => ({ method, headers: { ...(a.body !== undefined ? { "content-type": "application/json" } : {}), ...(a.headers ?? {}), ...extra }, ...(a.body !== undefined ? { body: typeof a.body === "string" ? a.body : JSON.stringify(a.body) } : {}) });
    const r1 = await this.f(url, init());
    if (r1.status !== 402) throw new AgentCoinError("expected_402", `seller returned ${r1.status} before payment`);
    const parsed = await parse402(r1);
    const req = parsed.accepts.find((x: PaymentRequirement) => x.scheme === "exact" && x.network === this.caip2);
    if (!req) throw new AgentCoinError("wrong_network", `seller offers no exact requirement on ${this.caip2}`);
    this.assertRequirement(req);
    if (getAddress(req.payTo) !== getAddress(routed.payTo)) throw new AgentCoinError("payto_mismatch", `seller payTo ${req.payTo} != indexed payTo ${routed.payTo}`);
    if (big(req.amount) !== big(routed.amount)) throw new AgentCoinError("amount_mismatch", `seller amount ${req.amount} != quoted ${routed.amount}`);
    const blk = await this.publicClient.getBlock();
    const pay = await signExactPayment(this.account, req, parsed, { chainId: this.chainId, tokenName: BASE_SEPOLIA.usdcEip712.name, tokenVersion: BASE_SEPOLIA.usdcEip712.version, nowSeconds: BigInt(blk.timestamp) });
    const t = Date.now();
    const r2 = await this.f(url, init({ [pay.header]: pay.value }));
    const buf = await r2.arrayBuffer();
    const latencyMs = Date.now() - t;
    const deliverable = decodeBody(buf);
    if (r2.status !== 200) throw new AgentCoinError("payment_rejected", `seller returned ${r2.status} after payment`, deliverable);
    const pr = readPaymentResponse(r2);
    const paymentTx = pr?.transaction ?? pr?.txHash ?? null;
    if (!isHex64(paymentTx)) throw new AgentCoinError("no_payment_tx", "seller returned no settlement transaction in PAYMENT-RESPONSE", { paymentResponse: pr, deliverable });
    const rec = await this.submitReceipt(order.orderId, { paymentTx, deliverable, latencyMs });
    return { orderId: order.orderId, mode: "direct", serviceId: order.serviceId, amount: req.amount, paymentTx, jobId: pr?.jobId ?? null, deliverable, sellerStatus: r2.status, order: rec, response: { status: r2.status, headers: hdrs(r2), body: buf } };
  }

  /** Checks the router's unsigned escrow transactions against local constants, signs and sends them, records the job, calls the seller. */
  async payEscrow(order: Json, a: { body?: unknown; headers?: Record<string, string>; sellerCall?: { url: string; method?: string } | null } = {}): Promise<PayResult> {
    if (!this.account) throw new AgentCoinError("no_account", "payment needs a signer (account)");
    if (order.mode !== "escrow") throw new AgentCoinError("bad_order", "payEscrow needs an escrow order");
    this.assertServiceAllowed(order.serviceId);
    const e = order.escrow ?? {};
    if (Number(e.chainId) !== this.chainId) throw new AgentCoinError("wrong_network", `escrow chainId ${e.chainId} != ${this.chainId}`);
    if (getAddress(e.contract) !== this.escrow) throw new AgentCoinError("wrong_escrow", `escrow contract ${e.contract} != ${this.escrow}`);
    this.assertRequirement({ network: this.caip2, asset: e.token, amount: e.amount });
    const txs: Json[] = order.transactions ?? [];
    if (txs.length !== 2) throw new AgentCoinError("bad_order", "expected 2 escrow transactions");
    // tx 1: USDC.approve(escrow, amount)
    if (getAddress(txs[0].to) !== this.usdc || Number(txs[0].chainId) !== this.chainId || big(txs[0].value ?? 0) !== 0n) throw new AgentCoinError("bad_tx", "approve tx target/chain/value mismatch");
    const ap = decodeFunctionData({ abi: erc20Abi, data: txs[0].data });
    if (ap.functionName !== "approve" || getAddress(ap.args[0] as string) !== this.escrow || (ap.args[1] as bigint) !== big(e.amount)) throw new AgentCoinError("bad_tx", "approve must be approve(escrow, amount)");
    // tx 2: JobEscrow.createAndFundFor(client=me, provider, evaluator, amount, deadline, specHash)
    if (getAddress(txs[1].to) !== this.escrow || Number(txs[1].chainId) !== this.chainId || big(txs[1].value ?? 0) !== 0n) throw new AgentCoinError("bad_tx", "fund tx target/chain/value mismatch");
    const cf = decodeFunctionData({ abi: ESCROW_ABI, data: txs[1].data });
    if (cf.functionName !== "createAndFundFor") throw new AgentCoinError("bad_tx", "fund tx must be createAndFundFor");
    const [client, provider, evaluator, amount] = cf.args as unknown as [string, string, string, bigint];
    if (getAddress(client) !== getAddress(this.account.address)) throw new AgentCoinError("bad_tx", "createAndFundFor client != my address");
    if (getAddress(provider) !== getAddress(e.provider) || getAddress(evaluator) !== getAddress(e.evaluator) || amount !== big(e.amount)) throw new AgentCoinError("bad_tx", "createAndFundFor args != order escrow terms");
    const wc = this.walletClient;
    const sent: { label: string; hash: string; logs?: any[] }[] = [];
    for (const tx of txs) {
      const hash = await wc.sendTransaction({ account: this.account, chain: this.chain(), to: getAddress(tx.to), data: tx.data, value: 0n });
      const rc = await this.publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new AgentCoinError("tx_reverted", `${tx.label} reverted: ${hash}`);
      sent.push({ label: tx.label, hash, logs: rc.logs });
    }
    const ev = parseEventLogs({ abi: ESCROW_ABI, logs: sent[1].logs ?? [], eventName: "JobCreated" }).find((l: any) => getAddress(l.address) === this.escrow);
    if (!ev) throw new AgentCoinError("no_job", "no JobCreated event in fund tx");
    const jobId = (ev as any).args.jobId.toString();
    const fundTx = sent[1].hash;
    let rec: Json = {};
    for (let i = 0; i < 4; i++) {
      try { rec = await this.submitReceipt(order.orderId, { jobId, paymentTx: fundTx }); break; } catch (err) { if (i === 3) throw err; await sleep(3000); }
    }
    let deliverable: unknown = null;
    let sellerStatus: number | null = null;
    let response: PayResult["response"] = null;
    const sc = a.sellerCall === undefined ? order.sellerCall : a.sellerCall;
    if (sc?.url) {
      const r = await this.f(sc.url, { method: sc.method ?? "POST", headers: { "content-type": "application/json", ...(a.headers ?? {}), "PAYMENT-SIGNATURE": escrowPaymentHeader(this.chainId, jobId, fundTx) }, ...(a.body !== undefined ? { body: typeof a.body === "string" ? a.body : JSON.stringify(a.body) } : {}) });
      sellerStatus = r.status;
      const buf = await r.arrayBuffer();
      deliverable = decodeBody(buf);
      response = { status: r.status, headers: hdrs(r), body: buf };
    }
    return { orderId: order.orderId, mode: "escrow", serviceId: order.serviceId, amount: String(e.amount), paymentTx: fundTx, jobId, deliverable, sellerStatus, order: rec, transactions: sent.map(({ label, hash }) => ({ label, hash })), response };
  }

  /** Polls an order until it has a verdict (escrow) or a terminal status. */
  async waitForVerdict(orderId: string, { timeoutMs = this.verdictTimeoutMs, intervalMs = this.pollIntervalMs } = {}): Promise<Json> {
    const end = Date.now() + timeoutMs;
    // a slow or failed read of the order (escrow order reads can take ~60 s) does not end the wait; the last error is rethrown at the deadline
    const poll = async (): Promise<Json> => {
      try { return await this.getOrder(orderId); } catch (e) { if (Date.now() >= end) throw e; return {}; }
    };
    let o = await poll();
    while (!o.verdict && Date.now() < end) { await sleep(intervalMs); o = await poll(); }
    return o;
  }

  /** On-chain escrow job state. */
  async getJob(jobId: string | bigint): Promise<Json> {
    const j: any = await this.publicClient.readContract({ address: this.escrow, abi: ESCROW_ABI, functionName: "getJob", args: [BigInt(jobId)] });
    return { ...j, stateName: ESCROW_STATES[Number(j.state)] as EscrowState };
  }

  /**
   * Buyer refund path for an escrow job. Picks the JobEscrow call for the job's state, simulates it, sends it if it would succeed:
   * Funded + not accepted -> cancel; Funded + past deadline -> claimRefund; Submitted + eval window over -> timeoutRelease;
   * Rejected/Partial/Completed + challenge window over -> finalize (Reject refunds the buyer). Otherwise returns {sent:false, reason}.
   */
  async refund(jobId: string | bigint, { send = true } = {}): Promise<Json> {
    const job = await this.getJob(jobId);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const st = job.stateName as EscrowState;
    let fn: "cancel" | "claimRefund" | "timeoutRelease" | "finalize" | null = null;
    if (st === "Funded" && !job.accepted) fn = "cancel";
    else if (st === "Funded" && now >= BigInt(job.deadline)) fn = "claimRefund";
    else if (st === "Submitted") fn = "timeoutRelease";
    else if (st === "Rejected" || st === "Partial" || st === "Completed") fn = "finalize";
    if (!fn) return { jobId: String(jobId), state: st, sent: false, reason: `no refund action for state ${st}${st === "Funded" ? " before the deadline" : ""}` };
    if (fn === "cancel" || fn === "claimRefund") {
      if (!this.account || getAddress(job.client) !== getAddress(this.account.address)) { if (fn === "cancel") return { jobId: String(jobId), state: st, sent: false, reason: "cancel is callable by the job client only" }; }
    }
    if (!this.account) return { jobId: String(jobId), state: st, action: fn, sent: false, reason: "no signer", data: encodeFunctionData({ abi: ESCROW_ABI, functionName: fn, args: [BigInt(jobId)] }), to: this.escrow };
    try {
      await this.publicClient.simulateContract({ account: this.account, address: this.escrow, abi: ESCROW_ABI, functionName: fn, args: [BigInt(jobId)] });
    } catch (err: any) {
      return { jobId: String(jobId), state: st, action: fn, sent: false, reason: `simulation reverted: ${err?.shortMessage ?? err?.message ?? err}` };
    }
    if (!send) return { jobId: String(jobId), state: st, action: fn, sent: false, reason: "send=false (simulation ok)" };
    const hash = await this.walletClient.writeContract({ account: this.account, chain: this.chain(), address: this.escrow, abi: ESCROW_ABI, functionName: fn, args: [BigInt(jobId)] });
    const rc = await this.publicClient.waitForTransactionReceipt({ hash });
    return { jobId: String(jobId), state: st, action: fn, sent: true, tx: hash, status: rc.status };
  }

  /**
   * One call: (route | serviceId) -> placeOrder -> pay -> (escrow: wait for verdict) -> verify score and delivery record.
   * Candidates are filtered to allowedServiceIds when set.
   */
  async buy(a: { serviceId?: string; task?: string; budget?: string; skillId?: string; mode?: OrderMode; body?: unknown; waitForVerdict?: boolean; deadlineSeconds?: number }): Promise<Json> {
    let serviceId = a.serviceId;
    let route: Json | null = null;
    if (!serviceId) {
      if (!a.task) throw new AgentCoinError("bad_args", "serviceId or task required");
      route = await this.routeTask({ task: a.task, budget: a.budget ?? this.maxPayment.toString() });
      const c = (route.candidates ?? []).find((x: Json) => !this.allowedServiceIds || this.allowedServiceIds.has(x.serviceId ?? x.id));
      if (!c) throw new AgentCoinError("no_candidate", "no routed candidate within allowedServiceIds and budget", { candidates: (route.candidates ?? []).map((x: Json) => x.serviceId ?? x.id) });
      serviceId = c.serviceId ?? c.id;
    }
    const mode = a.mode ?? "direct";
    const order = await this.placeOrder({ serviceId: serviceId!, skillId: a.skillId, mode, deadlineSeconds: a.deadlineSeconds });
    const paid = mode === "escrow" ? await this.payEscrow(order, { body: a.body }) : await this.payDirect(order, { body: a.body });
    const final = mode === "escrow" && a.waitForVerdict !== false ? await this.waitForVerdict(order.orderId) : await this.getOrder(order.orderId);
    const verification = await this.verify({ serviceId: serviceId!, orderId: order.orderId });
    return { serviceId, routedFrom: route ? { candidates: (route.candidates ?? []).length } : null, order: { orderId: order.orderId, mode, amount: paid.amount, paymentTx: paid.paymentTx, jobId: paid.jobId, transactions: paid.transactions, sellerStatus: paid.sellerStatus }, deliverable: paid.deliverable, final: { status: final.status, verdict: final.verdict, deliverableHash: final.deliverableHash, jobState: final.job?.stateName ?? final.job?.state ?? null }, verification, testnet: true };
  }
}
