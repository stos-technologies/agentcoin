// Local stdio MCP server: AgentCoin tools signed by a local testnet key (AGENTCOIN_PRIVATE_KEY). Base Sepolia only.
// The hosted router endpoint (<router>/mcp) offers the same tool names without a wallet (place_order returns unsigned data).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { asClient, runToolJson, toolSpecs, type AgentCoin, type AgentCoinOptions } from "@agentkoin/core";

/** MCP tool annotations for directory review: every tool is read-only or a write; none deletes or overwrites data. */
const TITLES: Record<string, string> = { find_service: "Find services in the index", route_task: "Route a task to ranked sellers", place_order: "Place and pay an order", get_order: "Get an order", claim_listing: "Claim or index a listing", verify: "Verify a score, record or document", refund: "Refund an escrow order" };
const IDEMPOTENT_WRITES = new Set(["claim_listing", "refund"]);
export function toolAnnotations(t: { name: string; readOnly: boolean }) {
  return { title: TITLES[t.name] ?? t.name, readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly || IDEMPOTENT_WRITES.has(t.name), openWorldHint: true };
}

export function createAgentCoinMcpServer(client?: AgentCoin | AgentCoinOptions, o: { readOnly?: boolean } = {}): Server {
  const c = asClient(client);
  const specs = toolSpecs.filter((t) => !o.readOnly || t.readOnly);
  const server = new Server({ name: "agentkoin", version: "0.1.1-testnet" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: specs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as any, annotations: toolAnnotations(t) })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const spec = specs.find((t) => t.name === req.params.name);
    if (!spec) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "unknown_tool", message: req.params.name }) }] };
    const text = await runToolJson(c, spec.name, (req.params.arguments ?? {}) as any);
    return { isError: text.startsWith('{"error"'), content: [{ type: "text", text }] };
  });
  return server;
}
