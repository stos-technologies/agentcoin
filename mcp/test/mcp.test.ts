import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgentCoinMcpServer } from "../src/index.ts";
import { mockClient } from "../../core-ts/test/setup.ts";
import { SERVICE_ID } from "../../core-ts/test/mock.ts";

async function connect(srv: any) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([srv.connect(a), client.connect(b)]);
  return client;
}

test("tools/list returns 7 tools; readOnly mode returns 4", async () => {
  const { client } = mockClient();
  assert.equal((await (await connect(createAgentCoinMcpServer(client))).listTools()).tools.length, 7);
  const ro = (await (await connect(createAgentCoinMcpServer(client, { readOnly: true }))).listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(ro, ["find_service", "get_order", "route_task", "verify"]);
});

test("tools/call find_service -> place_order (direct, signed locally)", async () => {
  const { client } = mockClient();
  const mc = await connect(createAgentCoinMcpServer(client));
  const f: any = await mc.callTool({ name: "find_service", arguments: { q: "notary" } });
  assert.ok(JSON.parse(f.content[0].text).results.some((r: any) => r.id === SERVICE_ID));
  const o: any = await mc.callTool({ name: "place_order", arguments: { serviceId: SERVICE_ID, body: { sha256: "0x" + "ab".repeat(32) } } });
  assert.equal(o.isError, false);
  assert.match(JSON.parse(o.content[0].text).orderId, /^ord_/);
});

test("errors set isError", async () => {
  const { client } = mockClient({}, { allowedServiceIds: ["svc_only"] });
  const mc = await connect(createAgentCoinMcpServer(client));
  const o: any = await mc.callTool({ name: "place_order", arguments: { serviceId: SERVICE_ID } });
  assert.equal(o.isError, true);
});
