// Framework-neutral tool definitions. Each plugin maps these to its framework's tool type.
// Names match the router's MCP/A2A tools (find_service, route_task, place_order, get_order, claim_listing, verify) plus refund.
import type { AgentCoin, Json } from "./client.ts";
import { AgentCoinError } from "./errors.ts";

export interface ToolSpec {
  name: "find_service" | "route_task" | "place_order" | "get_order" | "claim_listing" | "verify" | "refund";
  description: string;
  /** JSON Schema (draft 2020-12 subset: type, properties, required, enum, pattern, minimum, maximum). */
  parameters: { type: "object"; properties: Record<string, Json>; required?: string[]; additionalProperties: false };
  readOnly: boolean;
}

const usdc = { type: "string", pattern: "^[0-9]{1,18}$", description: "USDC base units (6 decimals), decimal string" };
const protocol = { type: "string", enum: ["x402", "a2a", "mcp", "openapi", "erc8004"] };

export const toolSpecs: ToolSpec[] = [
  {
    name: "find_service",
    description: "Searches the AgentCoin index of agent services (A2A, MCP, x402, ERC-8004) by text, protocol, max price, min delivery score, claimed status, network. With id: one listing with skills, prices, request formats, score. Read-only. Base Sepolia testnet.",
    parameters: { type: "object", properties: { id: { type: "string", maxLength: 40 }, q: { type: "string", maxLength: 300 }, protocol, maxPrice: usdc, minScore: { type: "number", minimum: 0, maximum: 1 }, claimed: { type: "boolean" }, network: { type: "string", maxLength: 80 }, cursor: { type: "string", maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "route_task",
    description: "Returns ranked candidate sellers for a task and budget: quote, request template, delivery score, order modes (direct, escrow). Network defaults to eip155:84532. No payment. Read-only.",
    parameters: { type: "object", properties: { task: { type: "string", minLength: 2, maxLength: 2000 }, budget: usdc, protocol, claimed: { type: "boolean" }, minScore: { type: "number", minimum: 0, maximum: 1 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["task"], additionalProperties: false },
    readOnly: true,
  },
  {
    name: "place_order",
    description: "Places an order for a listing and pays it from the configured wallet. mode direct: x402 exact payment to the seller, receipt recorded. mode escrow: test USDC held in JobEscrow until the evaluator verdict; refund on reject or expiry. Amount capped by maxPayment. Without a wallet: returns unsigned payment data.",
    parameters: { type: "object", properties: { serviceId: { type: "string", maxLength: 40 }, skillId: { type: "string", maxLength: 300 }, mode: { type: "string", enum: ["direct", "escrow"] }, body: { type: "object", description: "JSON request body sent to the seller (see the listing's request template)" } }, required: ["serviceId"], additionalProperties: false },
    readOnly: false,
  },
  {
    name: "get_order",
    description: "Returns an order's status, payment tx, escrow job state, deliverable hash, verdict and operator-signed delivery record. waitForVerdict polls until a verdict (escrow, up to the client's timeout).",
    parameters: { type: "object", properties: { orderId: { type: "string", maxLength: 40 }, waitForVerdict: { type: "boolean" } }, required: ["orderId"], additionalProperties: false },
    readOnly: true,
  },
  {
    name: "claim_listing",
    description: "Seller side. url: indexes a public metadata document (A2A card, x402 catalog, MCP server card, ERC-8004 registration). serviceId: returns claim typed data; sign true signs the EIP-712 claim with the configured wallet (a payTo or ERC-8004 owner); method well-known checks /.well-known/agentcoin-claim.",
    parameters: { type: "object", properties: { serviceId: { type: "string", maxLength: 40 }, url: { type: "string", maxLength: 2000 }, sign: { type: "boolean" }, method: { type: "string", enum: ["eip712", "well-known"] } }, additionalProperties: false },
    readOnly: false,
  },
  {
    name: "verify",
    description: "serviceId: signed delivery score with local signature and evidence-root checks. orderId: delivery record signature check. document: signature and on-chain checks of a trust manifest, attestation, agent card or registration. evaluator: reputation counts. Read-only.",
    parameters: { type: "object", properties: { serviceId: { type: "string", maxLength: 40 }, orderId: { type: "string", maxLength: 40 }, document: { type: "object" }, expectedSigner: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, evaluator: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } }, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "refund",
    description: "Escrow orders: checks the JobEscrow job state and sends the refund-path call that applies (cancel before acceptance, claimRefund after the deadline, timeoutRelease after a missed verdict, finalize after the challenge window). Returns the reason when none applies.",
    parameters: { type: "object", properties: { orderId: { type: "string", maxLength: 40 }, jobId: { type: "string", pattern: "^[0-9]{1,30}$" } }, additionalProperties: false },
    readOnly: false,
  },
];

const trim = (o: Json) => {
  if (o?.service?.evidence) { const { evidence, ...rest } = o.service; o = { ...o, service: rest }; }
  return o;
};

/** Executes one tool against a client. Returns plain JSON. */
export async function runTool(client: AgentCoin, name: string, args: Json = {}): Promise<Json> {
  switch (name) {
    case "find_service": return client.findService(args);
    case "route_task": {
      const { task, budget, ...constraints } = args;
      return client.routeTask({ task, budget, constraints });
    }
    case "place_order": {
      const order = await client.placeOrder({ serviceId: args.serviceId, skillId: args.skillId, mode: args.mode ?? "direct" });
      if (!client.account) return { unsigned: true, order };
      const paid = order.mode === "escrow" ? await client.payEscrow(order, { body: args.body }) : await client.payDirect(order, { body: args.body });
      const { order: rec, response: _r, ...rest } = paid;
      return { ...rest, status: rec?.status ?? null, verdict: rec?.verdict ?? null, testnet: true };
    }
    case "get_order": return args.waitForVerdict ? client.waitForVerdict(args.orderId) : client.getOrder(args.orderId);
    case "claim_listing": {
      let serviceId = args.serviceId;
      let submitted: Json | null = null;
      if (!serviceId && args.url) { submitted = await client.submitListing(args.url); serviceId = submitted.listing?.id; }
      if (!serviceId) throw new AgentCoinError("bad_args", "serviceId or url required");
      if (submitted && !args.sign && args.method !== "well-known") return { submitted, challenge: await client.claimListing({ serviceId }) };
      const r = await client.claimListing({ serviceId, sign: args.sign, method: args.method });
      return submitted ? { submitted, claim: r } : r;
    }
    case "verify": return trim(await client.verify(args));
    case "refund": {
      let jobId = args.jobId;
      if (!jobId && args.orderId) jobId = (await client.getOrder(args.orderId)).jobId;
      if (!jobId) throw new AgentCoinError("bad_args", "jobId, or orderId of an escrow order, required");
      return client.refund(jobId);
    }
    default: throw new AgentCoinError("unknown_tool", `unknown tool ${name}`);
  }
}

/** Runs a tool and returns a JSON string. Errors become {"error": code, "message": ...} so agents see them as tool output. */
export async function runToolJson(client: AgentCoin, name: string, args: Json = {}): Promise<string> {
  try {
    return JSON.stringify(await runTool(client, name, args ?? {}), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch (e: any) {
    return JSON.stringify({ error: e?.code ?? "error", message: String(e?.message ?? e) });
  }
}
