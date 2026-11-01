// AgentCoin tools for the OpenAI Agents SDK (TypeScript). Base Sepolia testnet only.
import { tool, type FunctionTool } from "@openai/agents";
import { asClient, runToolJson, toolSpecs, type AgentCoin, type AgentCoinOptions, type ToolSpec } from "@agentcoin/core";

export interface OpenAIAgentsToolsOptions { include?: ToolSpec["name"][]; readOnly?: boolean }

/** Returns FunctionTools for `new Agent({ tools })`. Non-strict JSON schema (optional fields allowed). */
export function agentcoinTools(client?: AgentCoin | AgentCoinOptions, o: OpenAIAgentsToolsOptions = {}): FunctionTool<any, any, string>[] {
  const c = asClient(client);
  return toolSpecs
    .filter((t) => (!o.include || o.include.includes(t.name)) && (!o.readOnly || t.readOnly))
    .map((t) => tool({ name: t.name, description: t.description, parameters: t.parameters as any, strict: false, execute: async (args: any) => runToolJson(c, t.name, args) }) as FunctionTool<any, any, string>);
}
export { RunContext } from "@openai/agents";
