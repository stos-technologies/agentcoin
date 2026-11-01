import { test } from "node:test";
import assert from "node:assert/strict";
import { agentcoinTools } from "../src/index.ts";
import { mockClient } from "../../core-ts/test/setup.ts";
import { SERVICE_ID } from "../../core-ts/test/mock.ts";

test("exposes 7 StructuredTools with names and JSON schemas", () => {
  const { client } = mockClient();
  const tools = agentcoinTools(client);
  assert.equal(tools.length, 7);
  const po: any = tools.find((t) => t.name === "place_order");
  assert.deepEqual(po.schema.required, ["serviceId"]);
});

test("invoke: find_service -> place_order direct -> verify", async () => {
  const { client } = mockClient();
  const t = Object.fromEntries(agentcoinTools(client).map((x) => [x.name, x]));
  const f = JSON.parse(await t.find_service.invoke({ q: "notary" }));
  assert.ok(f.results.some((r: any) => r.id === SERVICE_ID));
  const o = JSON.parse(await t.place_order.invoke({ serviceId: SERVICE_ID, body: { sha256: "0x" + "ab".repeat(32) } }));
  assert.match(o.orderId, /^ord_/);
  const v = JSON.parse(await t.verify.invoke({ serviceId: SERVICE_ID }));
  assert.equal(v.service.serviceId, SERVICE_ID);
  assert.ok(v.service.checks, "local signature checks present");
});

test("invoke via ToolCall message shape returns a ToolMessage", async () => {
  const { client } = mockClient();
  const fs: any = agentcoinTools(client).find((t) => t.name === "find_service");
  const msg = await fs.invoke({ type: "tool_call", id: "call_1", name: "find_service", args: { q: "notary" } });
  assert.equal(msg.tool_call_id, "call_1");
  assert.ok(JSON.parse(msg.content).results.length > 0);
});

test("errors come back as JSON tool output; mainnet client refused at construction", async () => {
  const { client } = mockClient({}, { allowedServiceIds: ["svc_only"] });
  const po: any = agentcoinTools(client).find((t) => t.name === "place_order");
  assert.equal(JSON.parse(await po.invoke({ serviceId: SERVICE_ID })).error, "service_not_allowed");
  assert.throws(() => agentcoinTools({ chainId: 8453 }), (e: any) => e.code === "mainnet_refused");
});
