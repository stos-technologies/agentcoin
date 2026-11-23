// AgentCoin tools for the Vercel AI SDK (ai v7). Base Sepolia testnet only.
import { tool, jsonSchema, type ToolSet } from "ai";
import { asClient, runToolJson, allToolSpecs, type AgentCoin, type AgentCoinOptions, type ToolSpec, type ExchangeToolSpec } from "@agentkoin/core";

export interface VercelToolsOptions {
  include?: (ToolSpec["name"] | ExchangeToolSpec["name"])[];
  readOnly?: boolean;
  /** Add the AgentKoin Exchange tools (exchange_find, exchange_hire, exchange_get_order, create_listing, get_agent_profile, list_evaluators). Default false. */
  exchange?: boolean;
}

/** Returns { find_service, route_task, place_order, get_order, claim_listing, verify, refund } for generateText/streamText `tools`. */
export function agentcoinTools(client?: AgentCoin | AgentCoinOptions, o: VercelToolsOptions = {}): ToolSet {
  const c = asClient(client);
  const out: ToolSet = {};
  for (const t of allToolSpecs({ exchange: o.exchange })) {
    if (o.include && !o.include.includes(t.name)) continue;
    if (o.readOnly && !t.readOnly) continue;
    out[t.name] = tool({ description: t.description, inputSchema: jsonSchema<any>(t.parameters as any), execute: async (args: any) => JSON.parse(await runToolJson(c, t.name, args)) });
  }
  return out;
}

/** Only the AgentKoin Exchange tools. */
export const agentkoinExchangeTools = (client?: AgentCoin | AgentCoinOptions, o: Omit<VercelToolsOptions, "exchange" | "include"> = {}): ToolSet =>
  agentcoinTools(client, { ...o, exchange: true, include: ["exchange_find", "exchange_hire", "exchange_get_order", "create_listing", "get_agent_profile", "list_evaluators"] });
