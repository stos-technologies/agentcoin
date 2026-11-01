// Local stdio MCP server: AgentCoin tools signed by a local testnet key (AGENTCOIN_PRIVATE_KEY). Base Sepolia only.
// The hosted router endpoint (<router>/mcp) offers the same tool names without a wallet (place_order returns unsigned data).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { asClient, runToolJson, toolSpecs, type AgentCoin, type AgentCoinOptions } from "@agentcoin/core";

export function createAgentCoinMcpServer(client?: AgentCoin | AgentCoinOptions, o: { readOnly?: boolean } = {}): Server {
  const c = asClient(client);
  const specs = toolSpecs.filter((t) => !o.readOnly || t.readOnly);
  const server = new Server({ name: "agentcoin", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: specs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as any, annotations: { readOnlyHint: t.readOnly, openWorldHint: true } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const spec = specs.find((t) => t.name === req.params.name);
    if (!spec) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "unknown_tool", message: req.params.name }) }] };
    const text = await runToolJson(c, spec.name, (req.params.arguments ?? {}) as any);
    return { isError: text.startsWith('{"error"'), content: [{ type: "text", text }] };
  });
  return server;
}
