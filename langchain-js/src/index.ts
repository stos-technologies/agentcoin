// AgentCoin tools for LangChain.js / LangGraph.js. Base Sepolia testnet only.
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { asClient, runToolJson, toolSpecs, type AgentCoin, type AgentCoinOptions, type ToolSpec } from "@agentcoin/core";

export interface LangChainToolsOptions { include?: ToolSpec["name"][]; readOnly?: boolean }

/** Returns StructuredTools usable with createReactAgent, ToolNode, or model.bindTools. Tool output is a JSON string. */
export function agentcoinTools(client?: AgentCoin | AgentCoinOptions, o: LangChainToolsOptions = {}): StructuredToolInterface[] {
  const c = asClient(client);
  return toolSpecs
    .filter((t) => (!o.include || o.include.includes(t.name)) && (!o.readOnly || t.readOnly))
    .map((t) => tool(async (args: any) => runToolJson(c, t.name, args), { name: t.name, description: t.description, schema: t.parameters as any }) as unknown as StructuredToolInterface);
}
