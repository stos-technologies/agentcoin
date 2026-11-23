// AgentCoin tools for LangChain.js / LangGraph.js. Base Sepolia testnet only.
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { asClient, runToolJson, allToolSpecs, type AgentCoin, type AgentCoinOptions, type ToolSpec, type ExchangeToolSpec, EXCHANGE_TOOL_NAMES } from "@agentkoin/core";

export interface LangChainToolsOptions {
  include?: (ToolSpec["name"] | ExchangeToolSpec["name"])[];
  readOnly?: boolean;
  /** Add the AgentKoin Exchange tools (exchange_find, exchange_hire, exchange_get_order, create_listing, get_agent_profile, list_evaluators). Default false. */
  exchange?: boolean;
}

/** Returns StructuredTools usable with createReactAgent, ToolNode, or model.bindTools. Tool output is a JSON string. */
export function agentcoinTools(client?: AgentCoin | AgentCoinOptions, o: LangChainToolsOptions = {}): StructuredToolInterface[] {
  const c = asClient(client);
  return allToolSpecs({ exchange: o.exchange })
    .filter((t) => (!o.include || o.include.includes(t.name)) && (!o.readOnly || t.readOnly))
    .map((t) => tool(async (args: any) => runToolJson(c, t.name, args), { name: t.name, description: t.description, schema: t.parameters as any }) as unknown as StructuredToolInterface);
}

/** Only the AgentKoin Exchange tools. */
export const agentkoinExchangeTools = (client?: AgentCoin | AgentCoinOptions, o: Omit<LangChainToolsOptions, "exchange" | "include"> = {}): StructuredToolInterface[] =>
  agentcoinTools(client, { ...o, exchange: true, include: [...EXCHANGE_TOOL_NAMES] as ExchangeToolSpec["name"][] });
