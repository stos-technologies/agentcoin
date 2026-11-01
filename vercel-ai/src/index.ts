// AgentCoin tools for the Vercel AI SDK (ai v7). Base Sepolia testnet only.
import { tool, jsonSchema, type ToolSet } from "ai";
import { asClient, runToolJson, toolSpecs, type AgentCoin, type AgentCoinOptions, type ToolSpec } from "@agentcoin/core";

export interface VercelToolsOptions { include?: ToolSpec["name"][]; readOnly?: boolean }

/** Returns { find_service, route_task, place_order, get_order, claim_listing, verify, refund } for generateText/streamText `tools`. */
export function agentcoinTools(client?: AgentCoin | AgentCoinOptions, o: VercelToolsOptions = {}): ToolSet {
  const c = asClient(client);
  const out: ToolSet = {};
  for (const t of toolSpecs) {
    if (o.include && !o.include.includes(t.name)) continue;
    if (o.readOnly && !t.readOnly) continue;
    out[t.name] = tool({ description: t.description, inputSchema: jsonSchema<any>(t.parameters as any), execute: async (args: any) => JSON.parse(await runToolJson(c, t.name, args)) });
  }
  return out;
}
