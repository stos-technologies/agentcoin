// Test harness for the MCP quickstart: launches `npx -y @agentkoin/mcp@testnet` over stdio exactly as Claude/Cursor would,
// then calls place_order + get_order through MCP. Needs AGENTCOIN_PRIVATE_KEY in the environment.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
const transport = new StdioClientTransport({ command: "npx", args: ["-y", "@agentkoin/mcp@testnet"], env: { ...process.env } });
const client = new Client({ name: "quickstart-test", version: "0.0.1" });
await client.connect(transport);
console.error("tools:", (await client.listTools()).tools.map((t) => t.name).join(","));
const sha256 = "0x" + createHash("sha256").update("hello from my MCP agent").digest("hex");
const r = await client.callTool({ name: "place_order", arguments: { serviceId: "svc_962928f654d2a8a1", mode: "direct", body: { sha256, note: "first judged job (mcp)" } } });
const o = JSON.parse(r.content[0].text);
const j = JSON.parse((await client.callTool({ name: "get_order", arguments: { orderId: o.orderId, waitForVerdict: true } })).content[0].text);
const JOB = o.jobId ?? o.deliverable?.jobId ?? o.deliverable?.receipt?.jobId;
console.log(`judged job ${JOB}: https://agentcoinhq.com/v1/jobs/${JOB}/proof  ->  npx @agentkoin/judge-kit@testnet verify ${JOB}`);
console.log(JSON.stringify({ orderId: o.orderId, paymentTx: o.paymentTx, jobId: JOB, status: j.status, verdict: j.verdict }, null, 2));
await client.close();
